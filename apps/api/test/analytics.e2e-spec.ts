import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * NOTIFICATIONS, DASHBOARD AND REPORTS
 * ===========================================================================
 *
 * The notification pipeline is driven end to end here — event, outbox,
 * dispatcher, notification row, worker, provider — because every stage in it
 * exists to survive a replay, and only running the whole chain twice shows
 * whether it does.
 *
 * The dashboard and report tests exist mostly to pin the DEFINITIONS. "Revenue"
 * meaning settled payments rather than booked totals is a decision that is
 * invisible until somebody reconciles the two, and a test is the only place it
 * is written down executably.
 */
describe('analytics and notifications', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  let serviceA: string;
  let employeeA: string;

  let unique = 0;

  const url = (path: string, companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/${path}`;

  // The company's today: reports bucket days in its timezone (Asia/Ulaanbaatar,
  // UTC+8), so a UTC date would be yesterday for part of every day.
  const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());

  async function makeAppointment(options: {
    totalMinor?: bigint;
    status?: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    startsAt?: Date;
    companyId?: string;
    branchId?: string;
    customerId?: string;
    withItem?: boolean;
  } = {}) {
    const companyId = options.companyId ?? world.companyA.id;
    const branchId = options.branchId ?? world.companyA.branchId;
    const startsAt = options.startsAt ?? new Date();

    const appointment = await harness.prisma.appointment.create({
      data: {
        companyId,
        branchId,
        customerId: options.customerId ?? world.companyA.customerId,
        appointmentNumber: `AN-${Date.now()}-${unique++}`,
        status: options.status ?? 'CONFIRMED',
        paymentStatus: 'UNPAID',
        source: 'STAFF',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        bookedTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        subtotalMinor: options.totalMinor ?? 50_000n,
        totalMinor: options.totalMinor ?? 50_000n,
      },
    });

    if (options.withItem) {
      await harness.prisma.appointmentItem.create({
        data: {
          companyId,
          appointmentId: appointment.id,
          branchId,
          serviceId: serviceA,
          employeeId: employeeA,
          status: options.status === 'COMPLETED' ? 'COMPLETED' : 'CONFIRMED',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          durationMin: 60,
          unitPriceMinor: options.totalMinor ?? 50_000n,
          totalMinor: options.totalMinor ?? 50_000n,
          snapshot: { serviceName: 'Analytics service' },
        },
      });
    }

    return appointment.id;
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    serviceA = (
      await harness.prisma.service.create({
        data: {
          companyId: world.companyA.id,
          name: 'Analytics service',
          durationMin: 60,
          priceMinor: 50_000n,
          currencyCode: 'MNT',
        },
      })
    ).id;
    employeeA = (
      await harness.prisma.employee.create({
        data: { companyId: world.companyA.id, displayName: 'Analytics stylist' },
      })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('the notification pipeline', () => {
    async function payFor(appointmentId: string, amountMinor = '25000') {
      return request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor, method: 'CASH' })
        .expect(201);
    }

    it('a completed payment writes an outbox event', async () => {
      const appointmentId = await makeAppointment();
      await payFor(appointmentId);

      const event = await harness.prisma.outboxEvent.findFirst({
        where: { companyId: world.companyA.id, type: 'payment.completed' },
        orderBy: { occurredAt: 'desc' },
      });

      expect(event).not.toBeNull();
      expect(event?.status).toBe('PENDING');
      expect((event?.payload as Record<string, unknown>).appointmentId).toBe(appointmentId);
    });

    it('a failed payment writes none', async () => {
      // Nothing happened worth telling anybody about.
      const before = await harness.prisma.outboxEvent.count({
        where: { companyId: world.companyA.id, type: 'payment.completed' },
      });

      const appointmentId = await makeAppointment({ totalMinor: 10_013n });
      await request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '10013', method: 'ONLINE' })
        .expect(201);

      expect(
        await harness.prisma.outboxEvent.count({
          where: { companyId: world.companyA.id, type: 'payment.completed' },
        }),
      ).toBe(before);
    });

    it('runs the whole chain: event → notification → sent', async () => {
      const appointmentId = await makeAppointment();
      await payFor(appointmentId);

      const run = await request(http)
        .post(url('notifications/run'))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(run.body.data.dispatched).toBeGreaterThan(0);
      expect(run.body.data.sent).toBeGreaterThan(0);

      const list = await request(http)
        .get(url('notifications?type=payment.completed'))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const notification = list.body.data.items[0];
      expect(notification).toMatchObject({
        type: 'payment.completed',
        channel: 'EMAIL',
        status: 'SENT',
        provider: 'mock-email',
      });
      // The recipient address is masked: a staff member checking whether a
      // receipt went out does not need the customer's email.
      expect(notification.recipientAddress).toMatch(/^\w\*\*\*@/);
    });

    it('a replayed run sends nothing twice', async () => {
      /**
       * At-least-once is the only guarantee a queue cheaply offers, so the
       * dedupe key is the property that keeps that from meaning a customer gets
       * two receipts.
       */
      const appointmentId = await makeAppointment();
      await payFor(appointmentId);
      await request(http).post(url('notifications/run')).set('Authorization', `Bearer ${ownerA}`).expect(200);

      const after = await harness.prisma.notification.count({
        where: { companyId: world.companyA.id, appointmentId },
      });

      // Force the outbox row back to PENDING, exactly as a crashed dispatcher
      // would leave it, and run again.
      await harness.prisma.outboxEvent.updateMany({
        where: { companyId: world.companyA.id, type: 'payment.completed' },
        data: { status: 'PENDING', publishedAt: null },
      });
      await request(http).post(url('notifications/run')).set('Authorization', `Bearer ${ownerA}`).expect(200);

      expect(
        await harness.prisma.notification.count({
          where: { companyId: world.companyA.id, appointmentId },
        }),
      ).toBe(after);
    });

    it('does not send a text message for a payment receipt', async () => {
      // A receipt by SMS is how a business teaches its customers to ignore its
      // texts. Only the urgent events get one.
      const appointmentId = await makeAppointment();
      await payFor(appointmentId);
      await request(http).post(url('notifications/run')).set('Authorization', `Bearer ${ownerA}`).expect(200);

      const sms = await harness.prisma.notification.count({
        where: { companyId: world.companyA.id, appointmentId, channel: 'SMS' },
      });
      expect(sms).toBe(0);
    });

    it('respects an opt-out and creates no row at all', async () => {
      await harness.prisma.notificationPreference.create({
        data: {
          companyId: world.companyA.id,
          subjectType: 'CUSTOMER',
          subjectId: world.companyA.customerId,
          channel: 'EMAIL',
          type: 'payment.completed',
          isEnabled: false,
        },
      });

      const appointmentId = await makeAppointment();
      await payFor(appointmentId);
      await request(http).post(url('notifications/run')).set('Authorization', `Bearer ${ownerA}`).expect(200);

      // Suppressed at dispatch, so the table stays an honest record of what was
      // attempted rather than a graveyard of CANCELLED rows.
      expect(
        await harness.prisma.notification.count({
          where: { companyId: world.companyA.id, appointmentId },
        }),
      ).toBe(0);

      await harness.prisma.notificationPreference.deleteMany({
        where: { companyId: world.companyA.id, subjectId: world.companyA.customerId },
      });
    });

    it('never shows another company’s notifications', async () => {
      const theirs = await makeAppointment({
        companyId: world.companyB.id,
        branchId: world.companyB.branchId,
        customerId: world.companyB.customerId,
      });
      await request(http)
        .post(url('payments', world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ appointmentId: theirs, amountMinor: '25000', method: 'CASH' })
        .expect(201);
      await request(http).post(url('notifications/run')).set('Authorization', `Bearer ${ownerA}`).expect(200);

      const list = await request(http)
        .get(url('notifications?limit=100'))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const appointmentIds = list.body.data.items.map((n: { appointmentId: string }) => n.appointmentId);
      expect(appointmentIds).not.toContain(theirs);
    });

    it('needs a settings permission to turn the handle', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);

      await request(http).get(url('notifications')).set('Authorization', `Bearer ${reader}`).expect(200);
      await request(http).post(url('notifications/run')).set('Authorization', `Bearer ${reader}`).expect(403);
    });
  });

  // ===========================================================================
  describe('dashboard', () => {
    it('counts today by status and reports revenue as money TAKEN', async () => {
      /**
       * The definition that matters. Booked totals include bookings nobody paid
       * for; settled payments are what is actually in the business. Getting it
       * wrong silently inflates every figure on the screen.
       */
      const paid = await makeAppointment({ totalMinor: 80_000n, status: 'COMPLETED' });
      await makeAppointment({ totalMinor: 40_000n, status: 'CONFIRMED' });
      await makeAppointment({ status: 'CANCELLED' });

      await request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId: paid, amountMinor: '80000', method: 'CASH' })
        .expect(201);

      const res = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.appointments.today).toBeGreaterThanOrEqual(3);
      expect(res.body.data.appointments.cancelled).toBeGreaterThanOrEqual(1);
      // 80,000 taken; the 40,000 booked and unpaid is NOT revenue.
      expect(BigInt(res.body.data.revenue.collectedMinor)).toBeGreaterThanOrEqual(80_000n);
      expect(BigInt(res.body.data.outstanding.amountMinor)).toBeGreaterThanOrEqual(40_000n);
    });

    it('subtracts refunds from revenue', async () => {
      const appointmentId = await makeAppointment({ totalMinor: 60_000n });
      const payment = await request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '60000', method: 'CASH' })
        .expect(201);

      const before = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      await request(http)
        .post(url(`payments/${payment.body.data.id}/refund`))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '20000', reason: 'Dashboard test' })
        .expect(200);

      const after = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(BigInt(after.body.data.revenue.netMinor)).toBe(
        BigInt(before.body.data.revenue.netMinor) - 20_000n,
      );
    });

    it('reports the outstanding gift-card liability', async () => {
      // An owner should be able to see what they owe in stored value without
      // asking an accountant.
      const before = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      await request(http)
        .post(url('gift-cards'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ initialBalanceMinor: '150000' })
        .expect(201);

      const after = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(BigInt(after.body.data.giftCards.outstandingLiabilityMinor)).toBe(
        BigInt(before.body.data.giftCards.outstandingLiabilityMinor) + 150_000n,
      );
    });

    it('counts new customers today', async () => {
      const before = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      await request(http)
        .post(url('customers'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Fresh', phone: `+9769${String(Date.now() % 10000000).padStart(7, '0')}` })
        .expect(201);

      const after = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(after.body.data.customers.newToday).toBe(before.body.data.customers.newToday + 1);
    });

    it('narrows every figure consistently when a branch is named', async () => {
      const otherBranch = await harness.prisma.branch.create({
        data: {
          companyId: world.companyA.id,
          code: `B${unique++}`,
          name: 'Quiet branch',
          timezoneName: 'Asia/Ulaanbaatar',
        },
      });

      const res = await request(http)
        .get(url(`dashboard?date=${TODAY}&branchId=${otherBranch.id}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      // A brand-new branch with nothing in it: a report where half the numbers
      // respect the filter and half do not is worse than no filter at all.
      expect(res.body.data.appointments.today).toBe(0);
      expect(res.body.data.revenue.collectedMinor).toBe('0');
      expect(res.body.data.branchId).toBe(otherBranch.id);
    });

    it('does not move company B’s dashboard when company A takes money', async () => {
      const before = await request(http)
        .get(url(`dashboard?date=${TODAY}`, world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .expect(200);

      const appointmentId = await makeAppointment({ totalMinor: 55_000n });
      await request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '55000', method: 'CASH' })
        .expect(201);

      const after = await request(http)
        .get(url(`dashboard?date=${TODAY}`, world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .expect(200);

      // A delta rather than an absolute. Both companies are seeded with their
      // own money, so "B shows zero" would be testing the fixture instead of
      // the isolation.
      expect(after.body.data.revenue.collectedMinor).toBe(before.body.data.revenue.collectedMinor);
      expect(after.body.data.appointments.today).toBe(before.body.data.appointments.today);
    });

    it('cannot be read through another company’s path', async () => {
      await request(http)
        .get(url(`dashboard?date=${TODAY}`, world.companyB.id))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('opens to report:read, withholding money explicitly rather than blanking it', async () => {
      /**
       * BRANCH_MANAGER holds `report:read` and not `report:revenue:read`. It
       * gets the dashboard with the counts, and the money fields come back null
       * with `restricted` saying so — never as zeros that look like data.
       */
      const manager = await memberWithRole(SYSTEM_ROLES.BRANCH_MANAGER);

      const res = await request(http)
        .get(url(`dashboard?date=${TODAY}`))
        .set('Authorization', `Bearer ${manager}`)
        .expect(200);
      expect(res.body.data.appointments.today).toBeGreaterThan(0);
      expect(res.body.data.revenue).toBeNull();
      expect(res.body.data.outstanding).toBeNull();
      expect(res.body.data.amountsVisible).toBe(false);
      expect(res.body.data.restricted).toEqual(expect.arrayContaining(['revenue', 'amounts']));
      expect(res.body.data.giftCards.outstandingLiabilityMinor).toBeNull();

      await request(http)
        .get(url(`reports/revenue?from=${TODAY}&to=${TODAY}`))
        .set('Authorization', `Bearer ${manager}`)
        .expect(403);
    });
  });

  // ===========================================================================
  describe('reports', () => {
    it('revenue by date, net of refunds', async () => {
      const appointmentId = await makeAppointment({ totalMinor: 90_000n });
      await request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '90000', method: 'CARD' })
        .expect(201);

      const res = await request(http)
        .get(url(`reports/revenue?from=${TODAY}&to=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items[0]).toMatchObject({ date: TODAY });
      expect(BigInt(res.body.data.totals.collectedMinor)).toBeGreaterThanOrEqual(90_000n);
    });

    it('payment methods, with fees separated from what was taken', async () => {
      const appointmentId = await makeAppointment({ totalMinor: 70_000n });
      await request(http)
        .post(url('payments'))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '70000', method: 'ONLINE' })
        .expect(201);

      const res = await request(http)
        .get(url(`reports/payment-methods?from=${TODAY}&to=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const online = res.body.data.items.find((i: { method: string }) => i.method === 'ONLINE');
      expect(BigInt(online.feesMinor)).toBeGreaterThan(0n);
      expect(BigInt(online.collectedMinor)).toBeGreaterThanOrEqual(70_000n);
    });

    it('refuses a backwards range and one longer than a year', async () => {
      for (const range of ['from=2026-12-01&to=2026-01-01', 'from=2020-01-01&to=2026-01-01']) {
        await request(http)
          .get(url(`reports/revenue?${range}`))
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(400);
      }
    });

    it('never leaks another company’s figures', async () => {
      const before = await request(http)
        .get(url(`reports/revenue?from=${TODAY}&to=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const theirs = await makeAppointment({
        totalMinor: 999_000n,
        companyId: world.companyB.id,
        branchId: world.companyB.branchId,
        customerId: world.companyB.customerId,
      });
      await request(http)
        .post(url('payments', world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ appointmentId: theirs, amountMinor: '999000', method: 'CASH' })
        .expect(201);

      const after = await request(http)
        .get(url(`reports/revenue?from=${TODAY}&to=${TODAY}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      // A delta, not an absolute. Company A has its own takings from the tests
      // above, so an absolute assertion would test the fixture rather than the
      // isolation.
      expect(after.body.data.totals.collectedMinor).toBe(before.body.data.totals.collectedMinor);
    });

    it('rejects an anonymous caller', async () => {
      await request(http).get(url(`dashboard`)).expect(401);
      await request(http).get(url(`reports/revenue?from=${TODAY}&to=${TODAY}`)).expect(401);
    });
  });

  // ===========================================================================

  async function memberWithRole(roleKey: string): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `an-${roleKey}-${Date.now()}-${unique++}@example.com`,
        fullName: `${roleKey} Person`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await harness.prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
    });
    await harness.prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });

    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }
});
