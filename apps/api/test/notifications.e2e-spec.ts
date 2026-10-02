import { Prisma } from '@prisma/client';
import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { NotificationContextService } from '../src/notifications/notification-context.service';
import { MAX_OUTBOX_ATTEMPTS } from '../src/notifications/notification-dispatcher.service';
import { NotificationReminderService } from '../src/notifications/notification-reminder.service';
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import {
  EmailNotificationProvider,
  PushNotificationProvider,
  SmsNotificationProvider,
} from '../src/notifications/providers/channel.providers';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * NOTIFICATIONS
 * ===========================================================================
 *
 *     booking / status change / gift card ─(same tx)→ outbox
 *     reminder sweep ─────────────────────────────────→ outbox
 *     outbox → dispatcher → notification rows → worker → mock provider
 *
 * The background timer is off in tests; each test turns the handle itself
 * (`runOnce`, or one stage), so what runs is decided here and not by a timer
 * racing the assertions. The providers are the mocks the app ships with,
 * taken from the Nest container and told when to fail.
 */
describe('notifications', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  let haircut: string;
  let ari: string;

  let scheduler: NotificationSchedulerService;
  let reminders: NotificationReminderService;
  let email: EmailNotificationProvider;
  let sms: SmsNotificationProvider;
  let push: PushNotificationProvider;

  let unique = 0;
  let slot = 0;

  const api = (path: string, companyId = world.companyA.id) => `/api/v1/companies/${companyId}/${path}`;
  const as = (token: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(http).post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) =>
      request(http).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  /** A unique 10:00-ish slot, 30+ days out, so no two bookings collide. */
  function nextStart(): string {
    const n = slot++;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30 + Math.floor(n / 8));
    const hour = 9 + (n % 8);
    return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  }

  async function book(customerId = world.companyA.customerId): Promise<{ id: string; startsAt: string }> {
    const startsAt = nextStart();
    const res = await as(ownerA).post(api('appointments'), {
      branchId: world.companyA.branchId,
      serviceId: haircut,
      employeeId: ari,
      customerId,
      startsAt,
    });
    expect(res.status).toBe(201);
    return { id: res.body.data.id as string, startsAt };
  }

  async function customer(data: { email?: string | null; phone?: string | null; firstName?: string }) {
    const row = await harness.prisma.companyCustomer.create({
      data: {
        companyId: world.companyA.id,
        firstName: data.firstName ?? `Guest${unique}`,
        lastName: 'Notify',
        email: data.email === undefined ? `guest${unique++}@example.com` : data.email,
        phone: data.phone === undefined ? `+9768${String(unique++).padStart(7, '0')}` : data.phone,
      },
    });
    return row.id;
  }

  const notificationsFor = (appointmentId: string) =>
    harness.prisma.notification.findMany({ where: { appointmentId }, orderBy: { channel: 'asc' } });

  const runA = () => scheduler.runOnce({ companyId: world.companyA.id });

  async function member(roleKey: string): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `notif-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
    });
    await prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });
    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }

  async function resetSettings() {
    await harness.prisma.companySettings.updateMany({
      data: {
        emailNotificationsEnabled: true,
        smsNotificationsEnabled: true,
        pushNotificationsEnabled: true,
        remindersEnabled: true,
        reminderOffsetsMinutes: [1440, 120],
        notificationEventChannels: Prisma.DbNull,
        autoConfirmBookings: true,
      },
    });
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    scheduler = harness.app.get(NotificationSchedulerService);
    reminders = harness.app.get(NotificationReminderService);
    email = harness.app.get(EmailNotificationProvider);
    sms = harness.app.get(SmsNotificationProvider);
    push = harness.app.get(PushNotificationProvider);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    const branchId = world.companyA.branchId;

    await prisma.businessHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        branchId,
        dayOfWeek,
        opensAt: new Date('1970-01-01T09:00:00.000Z'),
        closesAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
    haircut = (
      await prisma.service.create({
        data: {
          companyId,
          name: 'Haircut',
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 4500n,
          currencyCode: 'MNT',
          requiresEmployee: true,
        },
      })
    ).id;
    await prisma.serviceBranch.create({ data: { companyId, serviceId: haircut, branchId } });
    const employee = await prisma.employee.create({
      data: { companyId, displayName: 'Ari', status: 'ACTIVE', isBookable: true },
    });
    ari = employee.id;
    await prisma.employeeBranch.create({ data: { companyId, employeeId: ari, branchId } });
    await prisma.employeeService.create({ data: { companyId, employeeId: ari, serviceId: haircut } });
    await prisma.employeeSchedule.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        employeeId: ari,
        branchId,
        dayOfWeek,
        startsAt: new Date('1970-01-01T09:00:00.000Z'),
        endsAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
  });

  beforeEach(async () => {
    email.reset();
    sms.reset();
    push.reset();
    await resetSettings();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('appointment events → jobs', () => {
    it('writes the event with the booking and sends nothing on the request path', async () => {
      const { id } = await book();

      const event = await harness.prisma.outboxEvent.findFirst({
        where: { companyId: world.companyA.id, type: 'appointment.created' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(event).toMatchObject({ status: 'PENDING' });
      expect(event!.payload).toEqual({ appointmentId: id });
      // Queued, not sent: the booking request did not wait for any provider.
      expect(await notificationsFor(id)).toHaveLength(0);
      expect(email.delivered).toHaveLength(0);
    });

    it('emits confirmed, cancelled, completed and rescheduled from the status changes', async () => {
      await harness.prisma.companySettings.updateMany({
        where: { companyId: world.companyA.id },
        data: { autoConfirmBookings: false },
      });
      const pending = await book();
      await as(ownerA).post(api(`appointments/${pending.id}/confirm`)).expect(200);

      const moved = await as(ownerA)
        .post(api(`appointments/${pending.id}/reschedule`), { startsAt: nextStart() })
        .expect(200);
      const newId = moved.body.data.id as string;

      const cancelled = await book();
      await as(ownerA).post(api(`appointments/${cancelled.id}/cancel`), { reason: 'Customer asked' }).expect(200);

      const events = await harness.prisma.outboxEvent.findMany({
        where: { companyId: world.companyA.id },
        select: { type: true, payload: true },
      });
      const has = (type: string, appointmentId: string) =>
        events.some(
          (e) => e.type === type && (e.payload as { appointmentId?: string }).appointmentId === appointmentId,
        );

      expect(has('appointment.confirmed', pending.id)).toBe(true);
      expect(has('appointment.rescheduled', newId)).toBe(true);
      // The old half of a reschedule is not announced as a cancellation.
      expect(has('appointment.cancelled', pending.id)).toBe(false);
      expect(has('appointment.cancelled', cancelled.id)).toBe(true);
    });

    it('emits completed, and nothing for starting', async () => {
      const done = await book();
      // Completion is only valid once in progress; move the clock forward in data.
      await harness.prisma.appointment.update({
        where: { id: done.id },
        data: { startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 60_000) },
      });
      await as(ownerA).post(api(`appointments/${done.id}/start`)).expect(200);
      await as(ownerA).post(api(`appointments/${done.id}/complete`)).expect(200);

      const types = (
        await harness.prisma.outboxEvent.findMany({
          where: { companyId: world.companyA.id, payload: { equals: { appointmentId: done.id } } },
          select: { type: true },
        })
      ).map((e) => e.type);
      expect(types).toContain('appointment.completed');
      expect(types).not.toContain('appointment.started');
    });

    it('emits for a gift card issued or assigned to a customer, not for an anonymous one', async () => {
      const before = await harness.prisma.outboxEvent.count({ where: { type: { startsWith: 'gift_card.' } } });
      await as(ownerA).post(api('gift-cards'), { initialBalanceMinor: '5000000' }).expect(201);
      expect(await harness.prisma.outboxEvent.count({ where: { type: { startsWith: 'gift_card.' } } })).toBe(before);

      const owned = await as(ownerA)
        .post(api('gift-cards'), { initialBalanceMinor: '5000000', issuedToCustomerId: world.companyA.customerId })
        .expect(201);
      const loose = await as(ownerA).post(api('gift-cards'), { initialBalanceMinor: '3000000' }).expect(201);
      await as(ownerA)
        .patch(api(`gift-cards/${loose.body.data.id}`), { issuedToCustomerId: world.companyA.customerId })
        .expect(200);

      await runA();
      const cards = await harness.prisma.notification.findMany({
        where: { companyId: world.companyA.id, type: { startsWith: 'gift_card.' } },
      });
      expect(cards.map((n) => n.type).sort()).toEqual(['gift_card.assigned', 'gift_card.issued']);
      const issued = email.delivered.find((m) => m.subject?.includes('gift card'));
      expect(issued?.body).toMatch(/50,000\.00/);
      // The code is bearer value and never goes in a message.
      expect(JSON.stringify(email.delivered)).not.toContain(owned.body.data.code);
    });
  });

  // ===========================================================================
  describe('queue processing', () => {
    it('turns an event into rendered, sent messages on each reachable channel', async () => {
      const { id } = await book();
      const result = await runA();
      expect(result.dispatched).toBeGreaterThan(0);

      const rows = await notificationsFor(id);
      // Email and SMS; push has no device on file, so no row at all.
      expect(rows.map((r) => [r.channel, r.status])).toEqual([
        ['EMAIL', 'SENT'],
        ['SMS', 'SENT'],
      ]);
      expect(rows[0]).toMatchObject({ provider: 'mock-email', recipientType: 'CUSTOMER', retryCount: 0 });
      expect(rows[1]).toMatchObject({ provider: 'mock-sms', subject: null });

      const outbox = await harness.prisma.outboxEvent.findFirstOrThrow({
        where: { type: 'appointment.created', payload: { equals: { appointmentId: id } } },
      });
      expect(outbox.status).toBe('PUBLISHED');

      const message = email.delivered.find((m) => m.notificationId === rows[0]!.id)!;
      expect(message.to).toBe('customer@company-a.test');
      expect(message.subject).toBe('Your booking at Company A');
      // Every variable filled from the database, in the branch's timezone.
      expect(message.body).toContain('Hi Company A customer');
      expect(message.body).toContain('Haircut with Ari at');
      expect(message.body).toMatch(/ at \d{1,2}:00( [AP]M)?\./);
      expect(message.body).not.toContain('{{');
      expect(sms.delivered.some((m) => m.to === '+97699000001')).toBe(true);
    });

    it('never sends the same event twice, however often the queue runs', async () => {
      const { id } = await book();
      await runA();
      await runA();
      // Replay the outbox row, as a crashed dispatcher would leave it.
      await harness.prisma.outboxEvent.updateMany({
        where: { type: 'appointment.created', payload: { equals: { appointmentId: id } } },
        data: { status: 'PENDING', publishedAt: null },
      });
      await Promise.all([runA(), runA(), runA()]);

      expect(await notificationsFor(id)).toHaveLength(2);
      const rows = await notificationsFor(id);
      expect(email.delivered.filter((m) => m.notificationId === rows[0]!.id)).toHaveLength(1);
    });

    it('uses the company’s active template, and the default once it is switched off', async () => {
      const created = await as(ownerA)
        .post(api('notification-templates'), {
          type: 'appointment.created',
          channel: 'EMAIL',
          subject: '{{companyName}} — see you {{appointmentDate}}',
          body: 'Dear {{customerName}}, {{employeeName}} will do your {{serviceName}} at {{appointmentTime}} ({{branchName}}).',
        })
        .expect(201);

      const first = await book();
      await runA();
      const [custom] = await notificationsFor(first.id);
      expect(custom!.templateId).toBe(created.body.data.id);
      const sent = email.delivered.find((m) => m.notificationId === custom!.id)!;
      expect(sent.subject).toMatch(/^Company A — see you /);
      expect(sent.body).toMatch(
        /^Dear Company A customer, Ari will do your Haircut at \d{1,2}:00( [AP]M)? \(Company A main branch\)\.$/,
      );

      await as(ownerA)
        .patch(api(`notification-templates/${created.body.data.id}`), { isActive: false })
        .expect(200);
      const second = await book();
      await runA();
      const [fallback] = await notificationsFor(second.id);
      expect(fallback!.templateId).toBeNull();
      expect(fallback!.subject).toBe('Your booking at Company A');
    });
  });

  // ===========================================================================
  describe('retries', () => {
    const due = (id: string) =>
      harness.prisma.notification.update({ where: { id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });

    it('retries a transient failure after a backoff, then succeeds', async () => {
      const { id } = await book();
      email.failNext(1);
      await runA();

      let row = (await notificationsFor(id)).find((r) => r.channel === 'EMAIL')!;
      expect(row).toMatchObject({ status: 'RETRYING', retryCount: 1, failureReason: 'Simulated EMAIL failure' });
      expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // Not due yet: another run leaves it alone.
      await runA();
      row = (await notificationsFor(id)).find((r) => r.channel === 'EMAIL')!;
      expect(row.status).toBe('RETRYING');

      await due(row.id);
      await runA();
      row = (await notificationsFor(id)).find((r) => r.channel === 'EMAIL')!;
      expect(row).toMatchObject({ status: 'SENT', retryCount: 1, failureReason: null });
    });

    it('stops after the retry budget — no infinite retries', async () => {
      const { id } = await book();
      email.failNext(50, { throws: true });

      for (let i = 0; i < 6; i += 1) {
        await runA();
        const row = (await notificationsFor(id)).find((r) => r.channel === 'EMAIL')!;
        if (row.status === 'RETRYING') await due(row.id);
      }

      const row = (await notificationsFor(id)).find((r) => r.channel === 'EMAIL')!;
      // One attempt plus three retries, then FAILED for good.
      expect(row).toMatchObject({ status: 'FAILED', retryCount: 4, maxRetries: 3, nextRetryAt: null });
      expect(row.failedAt).not.toBeNull();

      email.reset();
      await runA();
      expect(email.delivered).toHaveLength(0);
      expect((await harness.prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED');
    });

    it('does not retry a permanent failure', async () => {
      const { id } = await book();
      email.failNext(1, { retryable: false, reason: 'Mailbox does not exist' });
      await runA();
      const row = (await notificationsFor(id)).find((r) => r.channel === 'EMAIL')!;
      expect(row).toMatchObject({ status: 'FAILED', retryCount: 1, failureReason: 'Mailbox does not exist' });
    });

    it('gives up on an outbox event that keeps failing to dispatch', async () => {
      const context = harness.app.get(NotificationContextService);
      const spy = jest.spyOn(context, 'resolve').mockRejectedValue(new Error('database hiccup'));
      try {
        const { id } = await book();
        for (let i = 0; i < MAX_OUTBOX_ATTEMPTS + 2; i += 1) await runA();

        const event = await harness.prisma.outboxEvent.findFirstOrThrow({
          where: { type: 'appointment.created', payload: { equals: { appointmentId: id } } },
        });
        expect(event).toMatchObject({ status: 'FAILED', attempts: MAX_OUTBOX_ATTEMPTS });
        expect(event.lastError).toContain('database hiccup');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ===========================================================================
  describe('reminders', () => {
    const reminderEvents = (appointmentId: string) =>
      harness.prisma.outboxEvent.findMany({
        where: { type: 'appointment.reminder', payload: { path: ['appointmentId'], equals: appointmentId } },
      });

    it('schedules each configured reminder once, at its time', async () => {
      const { id, startsAt } = await book();
      const start = new Date(startsAt).getTime();

      // 23 hours out: the 24h reminder is due, the 2h one is not.
      const first = await reminders.scheduleDue({ now: new Date(start - 23 * 3_600_000), companyId: world.companyA.id });
      expect(first.scheduled).toBeGreaterThanOrEqual(1);
      let events = await reminderEvents(id);
      expect(events.map((e) => (e.payload as { offsetMinutes: number }).offsetMinutes)).toEqual([1440]);

      // 90 minutes out: the 2h one now.
      await reminders.scheduleDue({ now: new Date(start - 90 * 60_000), companyId: world.companyA.id });
      events = await reminderEvents(id);
      expect(events.map((e) => (e.payload as { offsetMinutes: number }).offsetMinutes).sort()).toEqual([120, 1440]);

      await runA();
      const sent = (await notificationsFor(id)).filter((n) => n.type === 'appointment.reminder');
      expect(sent.map((n) => n.status)).toEqual(['SENT', 'SENT', 'SENT', 'SENT']);
      expect(email.delivered.some((m) => m.subject?.startsWith('Reminder: Haircut'))).toBe(true);
    });

    it('never schedules a duplicate, even with sweeps racing', async () => {
      const { id, startsAt } = await book();
      const now = new Date(new Date(startsAt).getTime() - 60 * 60_000);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => reminders.scheduleDue({ now, companyId: world.companyA.id })),
      );
      await reminders.scheduleDue({ now, companyId: world.companyA.id });

      // Both offsets have passed an hour before, but the booking existed before
      // both, so it gets one of each — exactly once.
      expect(await harness.prisma.appointmentReminder.count({ where: { appointmentId: id } })).toBe(2);
      expect(await reminderEvents(id)).toHaveLength(2);
      expect(results.reduce((sum, r) => sum + r.scheduled, 0)).toBeGreaterThanOrEqual(2);

      await runA();
      await runA();
      const rows = (await notificationsFor(id)).filter((n) => n.type === 'appointment.reminder');
      expect(rows).toHaveLength(4); // 2 reminders × email + SMS
    });

    it('does not send a “24 hours” reminder for a booking made after that moment', async () => {
      const { id, startsAt } = await book();
      const start = new Date(startsAt).getTime();
      await harness.prisma.appointment.update({
        where: { id },
        data: { createdAt: new Date(start - 3 * 3_600_000) },
      });

      await reminders.scheduleDue({ now: new Date(start - 150 * 60_000), companyId: world.companyA.id });
      expect(await reminderEvents(id)).toHaveLength(0);

      await reminders.scheduleDue({ now: new Date(start - 60 * 60_000), companyId: world.companyA.id });
      const events = await reminderEvents(id);
      expect(events.map((e) => (e.payload as { offsetMinutes: number }).offsetMinutes)).toEqual([120]);
    });

    it('follows the company’s settings: custom offsets, and none when switched off', async () => {
      await as(ownerA)
        .patch(api('notification-settings'), { reminders: { offsetsMinutes: [30] } })
        .expect(200);
      const { id, startsAt } = await book();
      const start = new Date(startsAt).getTime();

      await reminders.scheduleDue({ now: new Date(start - 90 * 60_000), companyId: world.companyA.id });
      expect(await reminderEvents(id)).toHaveLength(0);
      await reminders.scheduleDue({ now: new Date(start - 20 * 60_000), companyId: world.companyA.id });
      expect((await reminderEvents(id)).map((e) => (e.payload as { offsetMinutes: number }).offsetMinutes)).toEqual([30]);

      await as(ownerA).patch(api('notification-settings'), { reminders: { enabled: false } }).expect(200);
      const other = await book();
      await reminders.scheduleDue({
        now: new Date(new Date(other.startsAt).getTime() - 10 * 60_000),
        companyId: world.companyA.id,
      });
      expect(await reminderEvents(other.id)).toHaveLength(0);
    });

    it('reminds nobody about a cancelled appointment', async () => {
      const { id, startsAt } = await book();
      await as(ownerA).post(api(`appointments/${id}/cancel`), { reason: 'Changed plans' }).expect(200);
      await reminders.scheduleDue({
        now: new Date(new Date(startsAt).getTime() - 60 * 60_000),
        companyId: world.companyA.id,
      });
      expect(await reminderEvents(id)).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('disabled channels and preferences', () => {
    it('creates nothing on a channel the company switched off', async () => {
      await as(ownerA).patch(api('notification-settings'), { channels: { sms: false } }).expect(200);
      const { id } = await book();
      await runA();
      expect((await notificationsFor(id)).map((r) => r.channel)).toEqual(['EMAIL']);
      expect(sms.delivered).toHaveLength(0);
    });

    it('creates nothing for a type switched off for every channel', async () => {
      await as(ownerA)
        .patch(api('notification-settings'), { eventChannels: { 'appointment.created': [] } })
        .expect(200);
      const { id } = await book();
      await runA();
      expect(await notificationsFor(id)).toHaveLength(0);
    });

    it('respects a customer turning a channel off', async () => {
      const person = await customer({ firstName: 'Quiet' });
      const prefs = await as(ownerA)
        .patch(api(`customers/${person}/notification-preferences`), { sms: false })
        .expect(200);
      expect(prefs.body.data).toMatchObject({
        enabled: { email: true, sms: false, push: true },
        reachable: { email: true, sms: true, push: false },
      });

      const { id } = await book(person);
      await runA();
      expect((await notificationsFor(id)).map((r) => r.channel)).toEqual(['EMAIL']);

      const read = await as(ownerA).get(api(`customers/${person}/notification-preferences`)).expect(200);
      expect(read.body.data.enabled.sms).toBe(false);
    });
  });

  // ===========================================================================
  describe('invalid or missing recipients', () => {
    it('records an invalid address as cancelled, with why, and never sends it', async () => {
      const person = await customer({ email: 'not-an-email', phone: '12345' });
      const { id } = await book(person);
      await runA();

      const rows = await notificationsFor(id);
      expect(rows.map((r) => [r.channel, r.status, r.failureReason])).toEqual([
        ['EMAIL', 'CANCELLED', 'Invalid email address.'],
        ['SMS', 'CANCELLED', 'Invalid phone number.'],
      ]);
      expect(email.delivered).toHaveLength(0);
      expect(sms.delivered).toHaveLength(0);
    });

    it('creates nothing for a customer with no contact details', async () => {
      const person = await customer({ email: null, phone: null });
      const { id } = await book(person);
      const result = await runA();
      expect(result.failed).toBe(0);
      expect(await notificationsFor(id)).toHaveLength(0);
      const event = await harness.prisma.outboxEvent.findFirstOrThrow({
        where: { type: 'appointment.created', payload: { equals: { appointmentId: id } } },
      });
      // Handled, not failed: there was simply nobody to tell.
      expect(event.status).toBe('PUBLISHED');
    });
  });

  // ===========================================================================
  describe('templates API', () => {
    it('lists templates with the catalog of types, variables and defaults', async () => {
      const res = await as(ownerA).get(api('notification-templates')).expect(200);
      const created = res.body.data.catalog.find((t: { type: string }) => t.type === 'appointment.created');
      expect(created).toMatchObject({
        label: 'Appointment booked',
        variables: expect.arrayContaining(['customerName', 'appointmentTime', 'companyName']),
        defaults: { EMAIL: { subject: expect.any(String), body: expect.any(String) } },
      });
    });

    it('previews with sample values', async () => {
      const res = await as(ownerA)
        .post(api('notification-templates/preview'), {
          type: 'appointment.reminder',
          channel: 'SMS',
          body: 'Hi {{customerName}}, {{serviceName}} at {{appointmentTime}}',
        })
        .expect(200);
      expect(res.body.data).toMatchObject({ subject: null, body: 'Hi Sara, Haircut at 10:00' });
    });

    it('refuses unknown or inapplicable variables, a missing subject and an overlong SMS', async () => {
      const bad = async (body: object, field: string) => {
        const res = await as(ownerA).post(api('notification-templates'), body).expect(400);
        expect(JSON.stringify(res.body.error.details)).toContain(field);
        return res;
      };
      const unknown = await bad(
        { type: 'appointment.cancelled', channel: 'SMS', body: 'Hi {{customerNmae}}' },
        'body',
      );
      expect(JSON.stringify(unknown.body.error.details)).toContain('Unknown variable {{customerNmae}}');
      await bad({ type: 'appointment.cancelled', channel: 'SMS', body: 'Balance {{giftCardBalance}}' }, 'body');
      await bad({ type: 'appointment.cancelled', channel: 'EMAIL', body: 'No subject' }, 'subject');
      await bad({ type: 'appointment.cancelled', channel: 'PUSH', body: 'No title' }, 'subject');
      await bad({ type: 'appointment.cancelled', channel: 'SMS', body: 'x'.repeat(481) }, 'body');
      await as(ownerA).post(api('notification-templates'), { type: 'nope', channel: 'SMS', body: 'x' }).expect(400);
    });

    it('allows one template per type and channel, and edits it', async () => {
      const first = await as(ownerA)
        .post(api('notification-templates'), {
          type: 'appointment.completed',
          channel: 'SMS',
          subject: 'ignored for SMS',
          body: 'Thanks, {{customerName}}!',
        })
        .expect(201);
      expect(first.body.data).toMatchObject({ subject: null, isActive: true, typeLabel: 'Appointment completed' });

      await as(ownerA)
        .post(api('notification-templates'), { type: 'appointment.completed', channel: 'SMS', body: 'Again' })
        .expect(409);

      const edited = await as(ownerA)
        .patch(api(`notification-templates/${first.body.data.id}`), { body: 'Thank you {{customerName}}', isActive: false })
        .expect(200);
      expect(edited.body.data).toMatchObject({ body: 'Thank you {{customerName}}', isActive: false });

      await as(ownerA)
        .patch(api(`notification-templates/${first.body.data.id}`), { body: '{{nope}}' })
        .expect(400);
      await as(ownerA)
        .patch(api(`notification-templates/${first.body.data.id}`), { type: 'appointment.created' })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('settings API', () => {
    it('returns the defaults, and saves offsets sorted', async () => {
      const read = await as(ownerA).get(api('notification-settings')).expect(200);
      expect(read.body.data).toMatchObject({
        channels: { email: true, sms: true, push: true },
        reminders: { enabled: true, offsetsMinutes: [1440, 120] },
      });
      expect(read.body.data.eventChannels['payment.completed']).toEqual(['EMAIL']);

      const saved = await as(ownerA)
        .patch(api('notification-settings'), {
          reminders: { offsetsMinutes: [60, 2880] },
          eventChannels: { 'appointment.completed': ['EMAIL', 'SMS'] },
        })
        .expect(200);
      expect(saved.body.data.reminders.offsetsMinutes).toEqual([2880, 60]);
      expect(saved.body.data.eventChannels['appointment.completed']).toEqual(['EMAIL', 'SMS']);
      // Types not mentioned keep their channels.
      expect(saved.body.data.eventChannels['appointment.created']).toEqual(['EMAIL', 'SMS', 'PUSH']);
    });

    it('validates what it is given', async () => {
      const patch = (body: object) => as(ownerA).patch(api('notification-settings'), body);
      await patch({}).expect(400);
      await patch({ reminders: { offsetsMinutes: [5] } }).expect(400);
      await patch({ reminders: { offsetsMinutes: [60, 60] } }).expect(400);
      await patch({ reminders: { offsetsMinutes: [60, 120, 180, 240, 300] } }).expect(400);
      await patch({ channels: { fax: true } }).expect(400);
      await patch({ eventChannels: { 'appointment.created': ['FAX'] } }).expect(400);
      await patch({ eventChannels: { 'made.up': ['EMAIL'] } }).expect(400);
    });
  });

  // ===========================================================================
  describe('history', () => {
    it('shows type, channel, masked recipient, status, sent time and retry state', async () => {
      const { id } = await book();
      email.failNext(1);
      await runA();

      const list = await as(ownerA).get(api(`notifications?appointmentId=${id}`)).expect(200);
      const byChannel = Object.fromEntries(
        list.body.data.items.map((n: { channel: string }) => [n.channel, n]),
      );
      expect(byChannel.EMAIL).toMatchObject({
        type: 'appointment.created',
        status: 'RETRYING',
        retryCount: 1,
        maxRetries: 3,
        failureReason: 'Simulated EMAIL failure',
        sentAt: null,
      });
      expect(byChannel.EMAIL.nextRetryAt).not.toBeNull();
      expect(byChannel.EMAIL.recipientAddress).toBe('c***@company-a.test');
      expect(byChannel.SMS).toMatchObject({ status: 'SENT', recipientAddress: '***0001' });
      expect(byChannel.SMS.sentAt).not.toBeNull();

      const detail = await as(ownerA).get(api(`notifications/${byChannel.SMS.id}`)).expect(200);
      expect(detail.body.data.body).toContain('Haircut booked for');
      expect(detail.body.data.recipientAddress).toBe('***0001');
      expect(detail.body.data).not.toHaveProperty('payload');
      expect(JSON.stringify(detail.body)).not.toContain('+97699000001');
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('keeps company B’s history, templates, settings and customers out of reach', async () => {
      // Something in B's queue and history.
      const theirTemplate = await as(ownerB)
        .post(api('notification-templates', world.companyB.id), {
          type: 'appointment.cancelled',
          channel: 'SMS',
          body: 'B: cancelled',
        })
        .expect(201);
      await harness.prisma.outboxEvent.create({
        data: {
          companyId: world.companyB.id,
          type: 'appointment.created',
          payload: { appointmentId: world.companyB.appointmentId },
        },
      });

      // A turning the handle does not touch B's queue.
      await runA();
      await as(ownerA).post(api('notifications/run')).expect(200);
      expect(
        await harness.prisma.outboxEvent.count({ where: { companyId: world.companyB.id, status: 'PENDING' } }),
      ).toBeGreaterThan(0);

      await scheduler.runOnce({ companyId: world.companyB.id });
      const theirs = await harness.prisma.notification.findFirstOrThrow({ where: { companyId: world.companyB.id } });

      await as(ownerA).get(api(`notifications/${theirs.id}`)).expect(404);
      const listed = await as(ownerA).get(api('notifications?limit=100')).expect(200);
      expect(listed.body.data.items.map((n: { id: string }) => n.id)).not.toContain(theirs.id);

      await as(ownerA)
        .patch(api(`notification-templates/${theirTemplate.body.data.id}`), { isActive: false })
        .expect(404);
      const templates = await as(ownerA).get(api('notification-templates')).expect(200);
      expect(templates.body.data.items.map((t: { id: string }) => t.id)).not.toContain(theirTemplate.body.data.id);

      await as(ownerA).get(api(`customers/${world.companyB.customerId}/notification-preferences`)).expect(404);
      await as(ownerA)
        .patch(api(`customers/${world.companyB.customerId}/notification-preferences`), { email: false })
        .expect(404);

      // Through B's path with A's token: not a member.
      await as(ownerA).get(api('notifications', world.companyB.id)).expect(404);
      await as(ownerA).get(api('notification-templates', world.companyB.id)).expect(404);
      await as(ownerA).patch(api('notification-settings', world.companyB.id), { channels: { sms: false } }).expect(404);

      await as(ownerA).patch(api('notification-settings'), { channels: { email: false } }).expect(200);
      const bSettings = await as(ownerB).get(api('notification-settings', world.companyB.id)).expect(200);
      expect(bSettings.body.data.channels.email).toBe(true);
    });

    it('exposes nothing through the public API', async () => {
      const pub = `/api/v1/public/companies/${world.companyA.slug}`;
      await request(http).get(`${pub}/notifications`).expect(404);
      await request(http).get(`${pub}/notification-templates`).expect(404);
      await request(http).get(`${pub}/notification-settings`).expect(404);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('rejects an anonymous caller', async () => {
      await request(http).get(api('notifications')).expect(401);
      await request(http).get(api('notification-templates')).expect(401);
      await request(http).patch(api('notification-settings')).send({ channels: { sms: false } }).expect(401);
    });

    it('lets a read-only member look but change nothing', async () => {
      const token = await member(SYSTEM_ROLES.READ_ONLY);
      await as(token).get(api('notifications')).expect(200);
      await as(token).get(api('notification-templates')).expect(200);
      await as(token).get(api('notification-settings')).expect(200);

      await as(token).patch(api('notification-settings'), { channels: { sms: false } }).expect(403);
      await as(token)
        .post(api('notification-templates'), { type: 'appointment.created', channel: 'SMS', body: 'x' })
        .expect(403);
      await as(token).post(api('notifications/run')).expect(403);
      await as(token)
        .patch(api(`customers/${world.companyA.customerId}/notification-preferences`), { sms: false })
        .expect(403);
    });

    it('lets a receptionist set a customer’s channels but not see the message history', async () => {
      const token = await member(SYSTEM_ROLES.RECEPTIONIST);
      const person = await customer({});
      await as(token)
        .patch(api(`customers/${person}/notification-preferences`), { email: false })
        .expect(200);
      await as(token).get(api('notifications')).expect(403);
      await as(token).get(api('notification-templates')).expect(403);
      await as(token).patch(api('notification-settings'), { channels: { sms: false } }).expect(403);
    });

    it('keeps an employee out entirely', async () => {
      const token = await member(SYSTEM_ROLES.EMPLOYEE);
      await as(token).get(api('notifications')).expect(403);
      await as(token).get(api('notification-settings')).expect(403);
    });
  });
});
