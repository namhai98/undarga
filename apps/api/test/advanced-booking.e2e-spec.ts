import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * ADVANCED BOOKING
 * ===========================================================================
 *
 * Recurring series, booking rules, employee time off, resource availability
 * and the per-service concurrency cap — all through the one appointment
 * engine, against real PostgreSQL (the locks and exclusion constraints are
 * what stop double booking, and no mock reproduces them).
 *
 * Each block books on its own calendar days so blocks never interfere.
 */
describe('advanced booking', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let owner: string;
  let ownerB: string;

  let cut: string;
  let massage: string;
  let capped: string;
  let roomType: string;
  let room: string;
  let e1: string;
  let e2: string;
  let customer: string;

  const day = (n: number) => isoDaysAhead(30 + n);
  const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+08:00`;
  const company = (id = world.companyA.id) => `/api/v1/companies/${id}`;

  const post = (path: string, body: object, token = owner) =>
    request(http).post(path).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (path: string, body: object, token = owner) =>
    request(http).patch(path).set('Authorization', `Bearer ${token}`).send(body);
  const put = (path: string, body: object, token = owner) =>
    request(http).put(path).set('Authorization', `Bearer ${token}`).send(body);
  const get = (path: string, query: Record<string, string> = {}, token = owner) =>
    request(http).get(path).set('Authorization', `Bearer ${token}`).query(query);
  const del = (path: string, token = owner) =>
    request(http).delete(path).set('Authorization', `Bearer ${token}`);

  const book = (body: Record<string, unknown>, token = owner) =>
    post(
      `${company()}/appointments`,
      {
        branchId: world.companyA.branchId,
        customerId: customer,
        serviceId: cut,
        ...body,
      },
      token,
    );

  const series = (body: Record<string, unknown>, path = 'recurring') =>
    post(`${company()}/appointments/${path}`, {
      branchId: world.companyA.branchId,
      customerId: customer,
      serviceId: cut,
      ...body,
    });

  const settings = (body: Record<string, unknown>) => patch(`${company()}/booking-settings`, body);

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    owner = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    const branchId = world.companyA.branchId;
    customer = world.companyA.customerId;
    await openAllWeek(companyId, branchId);

    const svc = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.service.create({
        data: {
          companyId,
          name,
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 4500n,
          currencyCode: 'MNT',
          requiresEmployee: true,
          isOnlineBookable: true,
          ...extra,
        },
      });
    cut = (await svc('Haircut')).id;
    capped = (await svc('Consultation', { maxConcurrentBookings: 1 })).id;
    massage = (await svc('Massage', { requiresResource: true })).id;

    roomType = (
      await prisma.resourceType.create({
        data: { companyId, key: 'treatment-room', name: 'Treatment room', kind: 'ROOM' },
      })
    ).id;
    await prisma.serviceResourceRequirement.create({
      data: { companyId, serviceId: massage, resourceTypeId: roomType, quantity: 1 },
    });

    await prisma.serviceBranch.createMany({
      data: [cut, capped, massage].map((serviceId) => ({ companyId, serviceId, branchId })),
    });
    e1 = await makeEmployee(companyId, branchId, 'Ari', [cut, capped, massage]);
    e2 = await makeEmployee(companyId, branchId, 'Bat', [cut, capped, massage]);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  // Booking settings and rules
  // ===========================================================================

  describe('booking settings', () => {
    afterEach(async () => {
      await settings({
        minimumBookingNoticeMinutes: 60,
        maximumAdvanceBookingDays: 90,
        cancellationDeadlineHours: 24,
        reschedulingAllowed: true,
        rescheduleDeadlineHours: null,
      });
    });

    it('reads the defaults and saves changes, audited', async () => {
      const read = await get(`${company()}/booking-settings`);
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({
        minimumBookingNoticeMinutes: 60,
        maximumAdvanceBookingDays: 90,
        cancellationDeadlineHours: 24,
        reschedulingAllowed: true,
      });

      const res = await settings({ cancellationDeadlineHours: 48, rescheduleDeadlineHours: null });
      expect(res.status).toBe(200);
      expect(res.body.data.cancellationDeadlineHours).toBe(48);
      expect(res.body.data.effectiveRescheduleDeadlineHours).toBe(48);
      expect(
        await harness.prisma.auditLog.count({
          where: { action: 'company.booking_settings_updated', companyId: world.companyA.id },
        }),
      ).toBeGreaterThan(0);
    });

    it('rejects out-of-range values', async () => {
      const res = await settings({ maximumAdvanceBookingDays: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('is per company: another company cannot read or change it', async () => {
      expect((await get(`${company()}/booking-settings`, {}, ownerB)).status).toBe(404);
      const res = await request(http)
        .patch(`${company()}/booking-settings`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ reschedulingAllowed: false });
      expect(res.status).toBe(404);
    });

    it('refuses a booking inside the minimum notice', async () => {
      await settings({ minimumBookingNoticeMinutes: 43_200 }); // 30 days
      const res = await book({ employeeId: e1, startsAt: at(isoDaysAhead(3), '10:00') });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('MINIMUM_NOTICE');
      expect(res.body.error.message).toMatch(/notice/);
    });

    it('refuses a booking beyond the advance window', async () => {
      await settings({ maximumAdvanceBookingDays: 10 });
      const res = await book({ employeeId: e1, startsAt: at(day(0), '10:00') });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('BEYOND_BOOKING_WINDOW');
    });

    it('applies the same rules to public booking', async () => {
      await settings({ maximumAdvanceBookingDays: 10 });
      const res = await request(http)
        .post('/api/v1/public/companies/company-a/bookings')
        .send({
          branchId: world.companyA.branchId,
          serviceId: cut,
          startsAt: at(day(0), '11:00'),
          customer: {
            firstName: 'Web',
            phone: '+97688112233',
            email: `web-${Date.now()}@example.com`,
          },
        });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('BEYOND_BOOKING_WINDOW');
    });

    it('a service override wins over the company setting', async () => {
      await harness.prisma.service.update({
        where: { id: cut },
        data: { maxAdvanceBookingDays: 5 },
      });
      try {
        const res = await book({ employeeId: e1, startsAt: at(day(0), '12:00') });
        expect(res.body.error.details.reason).toBe('BEYOND_BOOKING_WINDOW');
        const avail = await get(`${company()}/availability`, {
          branchId: world.companyA.branchId,
          serviceId: cut,
          date: day(0),
        });
        expect(avail.body.data.rules.maximumAdvanceDays).toBe(5);
        expect(avail.body.data.slots).toHaveLength(0);
      } finally {
        await harness.prisma.service.update({
          where: { id: cut },
          data: { maxAdvanceBookingDays: null },
        });
      }
    });
  });

  describe('cancellation and rescheduling rules', () => {
    // Within 30 days of now, so a 720-hour deadline has already passed.
    const soon = () => isoDaysAhead(6);

    afterEach(async () => {
      await settings({
        cancellationDeadlineHours: 24,
        reschedulingAllowed: true,
        rescheduleDeadlineHours: null,
      });
    });

    it('refuses a late cancellation unless confirmed, and records it as late', async () => {
      const appt = (await book({ employeeId: e1, startsAt: at(soon(), '10:00') })).body.data;
      await settings({ cancellationDeadlineHours: 720 });

      const refused = await post(`${company()}/appointments/${appt.id}/cancel`, {
        reason: 'Customer called',
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BOOKING_RULE_VIOLATION');
      expect(refused.body.error.details.rule).toBe('CANCELLATION_DEADLINE');

      const ok = await post(`${company()}/appointments/${appt.id}/cancel`, {
        reason: 'Customer called',
        lateCancellation: true,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('CANCELLED');
      expect(ok.body.data.cancellation.reason).toMatch(/late cancellation/);
    });

    it('an employee cannot override the deadline', async () => {
      const appt = (await book({ employeeId: e1, startsAt: at(soon(), '12:00') })).body.data;
      await settings({ cancellationDeadlineHours: 720 });
      const token = await memberLinkedTo(e1, SYSTEM_ROLES.EMPLOYEE);
      const res = await post(
        `${company()}/appointments/${appt.id}/cancel`,
        { reason: 'Sick', lateCancellation: true },
        token,
      );
      expect(res.status).toBe(403);
    });

    it('refuses rescheduling when the business switched it off', async () => {
      const appt = (await book({ employeeId: e1, startsAt: at(day(40), '10:00') })).body.data;
      await settings({ reschedulingAllowed: false });
      const res = await post(`${company()}/appointments/${appt.id}/reschedule`, {
        startsAt: at(day(40), '12:00'),
      });
      expect(res.status).toBe(422);
      expect(res.body.error.details.rule).toBe('RESCHEDULING_DISABLED');
    });

    it('refuses a late change unless confirmed', async () => {
      const appt = (await book({ employeeId: e2, startsAt: at(soon(), '14:00') })).body.data;
      await settings({ rescheduleDeadlineHours: 720 });
      const refused = await post(`${company()}/appointments/${appt.id}/reschedule`, {
        startsAt: at(soon(), '16:00'),
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error.details.rule).toBe('RESCHEDULE_DEADLINE');

      const ok = await post(`${company()}/appointments/${appt.id}/reschedule`, {
        startsAt: at(soon(), '16:00'),
        lateChange: true,
      });
      expect(ok.status).toBe(200);
    });

    it('the new time must still respect the booking window', async () => {
      const appt = (await book({ employeeId: e1, startsAt: at(day(41), '10:00') })).body.data;
      await settings({ maximumAdvanceBookingDays: 90 });
      const res = await post(`${company()}/appointments/${appt.id}/reschedule`, {
        startsAt: at(isoDaysAhead(200), '10:00'),
      });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('BEYOND_BOOKING_WINDOW');
    });
  });

  // ===========================================================================
  // Recurring series
  // ===========================================================================

  describe('recurring series', () => {
    const start = () => day(2);

    it('previews every occurrence without creating anything', async () => {
      const res = await series(
        {
          employeeId: e1,
          startsAt: at(start(), '10:00'),
          recurrence: { frequency: 'WEEKLY', count: 4 },
        },
        'recurring/preview',
      );
      expect(res.status).toBe(200);
      expect(res.body.data.occurrences).toHaveLength(4);
      expect(res.body.data.bookableCount).toBe(4);
      expect(
        await harness.prisma.appointmentSeries.count({ where: { companyId: world.companyA.id } }),
      ).toBe(0);
    });

    it('creates a weekly series in one go and shows it', async () => {
      const res = await series({
        employeeId: e1,
        startsAt: at(start(), '10:00'),
        recurrence: { frequency: 'WEEKLY', count: 3 },
      });
      expect(res.status).toBe(201);
      const s = res.body.data;
      expect(s.status).toBe('ACTIVE');
      expect(s.recurrence).toMatchObject({
        frequency: 'WEEKLY',
        interval: 1,
        count: 3,
        localStartTime: '10:00',
      });
      expect(s.occurrences.map((o: { startsAt: string }) => o.startsAt)).toEqual([
        at(start(), '10:00'),
        at(isoDaysAhead(32 + 7), '10:00'),
        at(isoDaysAhead(32 + 14), '10:00'),
      ]);
      expect(s.occurrences.every((o: { seriesId: string }) => o.seriesId === s.id)).toBe(true);

      const view = await get(`${company()}/appointment-series/${s.id}`);
      expect(view.status).toBe(200);
      expect(view.body.data.counts).toEqual({ total: 3, upcoming: 3, cancelled: 0 });

      // One notification for the whole series, not one per date.
      const events = await harness.prisma.outboxEvent.count({
        where: {
          companyId: world.companyA.id,
          type: 'appointment.created',
          payload: { path: ['seriesId'], equals: s.id },
        },
      });
      expect(events).toBe(1);
    });

    it('refuses the whole series when one date conflicts, creating nothing', async () => {
      // Occupy the third date first.
      await book({ employeeId: e2, startsAt: at(isoDaysAhead(33 + 14), '15:00') });
      const before = await harness.prisma.appointment.count({
        where: { companyId: world.companyA.id },
      });

      const res = await series({
        employeeId: e2,
        startsAt: at(day(3), '15:00'),
        recurrence: { frequency: 'WEEKLY', count: 3 },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SERIES_CONFLICT');
      expect(res.body.error.details.occurrences).toHaveLength(1);
      expect(res.body.error.details.occurrences[0].date).toBe(isoDaysAhead(33 + 14));
      expect(
        await harness.prisma.appointment.count({ where: { companyId: world.companyA.id } }),
      ).toBe(before);
    });

    it('with onConflict: skip, books the free dates and reports the rest', async () => {
      const res = await series({
        employeeId: e2,
        startsAt: at(day(3), '15:00'),
        recurrence: { frequency: 'WEEKLY', count: 3 },
        onConflict: 'skip',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.occurrences).toHaveLength(2);
      expect(res.body.data.skipped).toHaveLength(1);
    });

    it('daily with an end date, and selected weekdays', async () => {
      const daily = await series(
        {
          employeeId: e1,
          startsAt: at(day(4), '13:00'),
          recurrence: { frequency: 'DAILY', endDate: day(6) },
        },
        'recurring/preview',
      );
      expect(daily.body.data.occurrences).toHaveLength(3);

      const weekdays = await series(
        {
          employeeId: e1,
          startsAt: at(day(4), '13:00'),
          recurrence: { frequency: 'WEEKLY', weekdays: [1, 3, 5], count: 6 },
        },
        'recurring/preview',
      );
      const days = weekdays.body.data.occurrences.map((o: { date: string }) =>
        new Date(`${o.date}T00:00:00Z`).getUTCDay(),
      );
      expect(days.every((d: number) => [1, 3, 5].includes(d))).toBe(true);
      expect(weekdays.body.data.occurrences).toHaveLength(6);
    });

    it('validates the rule', async () => {
      const both = await series({
        startsAt: at(day(4), '13:00'),
        recurrence: { frequency: 'DAILY', endDate: day(6), count: 2 },
      });
      expect(both.status).toBe(400);
      const tooMany = await series({
        startsAt: at(day(4), '13:00'),
        recurrence: { frequency: 'DAILY', count: 53 },
      });
      expect(tooMany.status).toBe(400);
      const weekdaysOnDaily = await series({
        startsAt: at(day(4), '13:00'),
        recurrence: { frequency: 'DAILY', weekdays: [1], count: 2 },
      });
      expect(weekdaysOnDaily.status).toBe(400);
    });

    it('applies booking rules to every occurrence', async () => {
      await settings({ maximumAdvanceBookingDays: 40 });
      try {
        const res = await series({
          employeeId: e1,
          startsAt: at(day(5), '16:00'),
          recurrence: { frequency: 'WEEKLY', count: 3 },
        });
        expect(res.status).toBe(409);
        const reasons = res.body.error.details.occurrences.map((o: { reason: string }) => o.reason);
        expect(reasons).toContain('BEYOND_BOOKING_WINDOW');
      } finally {
        await settings({ maximumAdvanceBookingDays: 90 });
      }
    });

    it('cancels one occurrence, then all future ones', async () => {
      const s = (
        await series({
          employeeId: e1,
          startsAt: at(day(7), '09:00'),
          recurrence: { frequency: 'DAILY', count: 4 },
        })
      ).body.data;
      const [first, second] = s.occurrences;

      const one = await post(`${company()}/appointment-series/${s.id}/cancel`, {
        scope: 'occurrence',
        appointmentId: second.id,
        reason: 'Holiday',
      });
      expect(one.status).toBe(200);
      expect(one.body.data.counts).toEqual({ total: 4, upcoming: 3, cancelled: 1 });
      expect(one.body.data.status).toBe('ACTIVE');

      const future = await post(`${company()}/appointment-series/${s.id}/cancel`, {
        scope: 'future',
        from: first.startsAt,
        reason: 'Moved away',
      });
      expect(future.status).toBe(200);
      expect(future.body.data.counts.upcoming).toBe(0);
      expect(future.body.data.status).toBe('CANCELLED');
    });

    it('counts a rescheduled occurrence once, not as a cancellation plus a new one', async () => {
      const s = (
        await series({
          employeeId: e2,
          startsAt: at(day(23), '09:00'),
          recurrence: { frequency: 'DAILY', count: 3 },
        })
      ).body.data;
      const moved = await post(`${company()}/appointments/${s.occurrences[1].id}/reschedule`, {
        startsAt: at(day(24), '15:00'),
      });
      expect(moved.status).toBe(200);

      const view = (await get(`${company()}/appointment-series/${s.id}`)).body.data;
      // The original stays listed (cancelled) next to its replacement…
      expect(view.occurrences).toHaveLength(4);
      // …but the series still has three dates, all of them booked.
      expect(view.counts).toEqual({ total: 3, upcoming: 3, cancelled: 0 });
    });

    it('marks the series cancelled when every occurrence is cancelled one by one', async () => {
      const s = (
        await series({
          employeeId: e1,
          startsAt: at(day(10), '09:00'),
          recurrence: { frequency: 'DAILY', count: 2 },
        })
      ).body.data;
      // Through the ordinary appointment route, not the series card.
      for (const o of s.occurrences) {
        expect(
          (await post(`${company()}/appointments/${o.id}/cancel`, { reason: 'Moving away' })).status,
        ).toBe(200);
      }
      const row = await harness.prisma.appointmentSeries.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.status).toBe('CANCELLED');
      expect(row.cancelledAt).not.toBeNull();
    });

    it('ends a series that ran its course without calling it cancelled', async () => {
      const s = (
        await series({
          employeeId: e1,
          startsAt: at(day(10), '13:00'),
          recurrence: { frequency: 'DAILY', count: 2 },
        })
      ).body.data;
      const [first, second] = s.occurrences;
      await post(`${company()}/appointments/${first.id}/start`, {}).expect(200);
      await post(`${company()}/appointments/${first.id}/complete`, {}).expect(200);
      expect(
        (await harness.prisma.appointmentSeries.findUniqueOrThrow({ where: { id: s.id } })).status,
      ).toBe('ACTIVE');
      await post(`${company()}/appointments/${second.id}/cancel`, { reason: 'Done' }).expect(200);

      const row = await harness.prisma.appointmentSeries.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.status).toBe('ENDED');
      expect(row.cancelledAt).toBeNull();
    });

    it('refuses an occurrence from another series', async () => {
      const a = (
        await series({
          employeeId: e2,
          startsAt: at(day(8), '09:00'),
          recurrence: { frequency: 'DAILY', count: 2 },
        })
      ).body.data;
      const b = (
        await series({
          employeeId: e2,
          startsAt: at(day(8), '11:00'),
          recurrence: { frequency: 'DAILY', count: 2 },
        })
      ).body.data;
      const res = await post(`${company()}/appointment-series/${a.id}/cancel`, {
        scope: 'occurrence',
        appointmentId: b.occurrences[0].id,
        reason: 'x',
      });
      expect(res.status).toBe(404);
    });

    it('is invisible to another company', async () => {
      const s = (
        await series({
          employeeId: e1,
          startsAt: at(day(9), '09:00'),
          recurrence: { frequency: 'DAILY', count: 2 },
        })
      ).body.data;
      expect(
        (await get(`${company(world.companyB.id)}/appointment-series/${s.id}`, {}, ownerB)).status,
      ).toBe(404);
      const res = await post(
        `${company(world.companyB.id)}/appointment-series/${s.id}/cancel`,
        { scope: 'future', reason: 'x' },
        ownerB,
      );
      expect(res.status).toBe(404);
      // And company B cannot book a series for company A's customer.
      const cross = await post(
        `${company(world.companyB.id)}/appointments/recurring`,
        {
          branchId: world.companyB.branchId,
          customerId: customer,
          serviceId: cut,
          startsAt: at(day(9), '13:00'),
          recurrence: { frequency: 'DAILY', count: 2 },
        },
        ownerB,
      );
      expect(cross.status).toBe(404);
    });
  });

  // ===========================================================================
  // Employee time off
  // ===========================================================================

  describe('time off', () => {
    const d = () => day(12);

    it('a manager records approved time off, which removes those times from availability', async () => {
      const res = await post(`${company()}/time-off`, {
        employeeId: e1,
        type: 'VACATION',
        startsAt: at(d(), '00:00'),
        endsAt: at(isoDaysAhead(43), '00:00'),
        reason: 'Family trip',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('APPROVED');

      const avail = await get(`${company()}/availability`, {
        branchId: world.companyA.branchId,
        serviceId: cut,
        date: d(),
        employeeId: e1,
      });
      expect(avail.body.data.slots).toHaveLength(0);
      expect(avail.body.data.employeesUnavailable[0]).toMatchObject({ employeeId: e1 });
      // Times only — the reason is not repeated in availability.
      expect(JSON.stringify(avail.body.data)).not.toContain('Family trip');

      const booking = await book({ employeeId: e1, startsAt: at(d(), '10:00') });
      expect(booking.status).toBe(409);
      expect(booking.body.error.details.reason).toBe('EMPLOYEE_TIME_OFF');
    });

    it('public booking is refused without saying why the employee is away', async () => {
      const res = await request(http)
        .post('/api/v1/public/companies/company-a/bookings')
        .send({
          branchId: world.companyA.branchId,
          serviceId: cut,
          employeeId: e1,
          startsAt: at(d(), '11:00'),
          customer: {
            firstName: 'Web',
            phone: '+97688112244',
            email: `web2-${Date.now()}@example.com`,
          },
        });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).not.toBe('EMPLOYEE_TIME_OFF');
      expect(JSON.stringify(res.body)).not.toMatch(/vacation|Family trip|time.off/i);

      const avail = await request(http)
        .get('/api/v1/public/companies/company-a/availability')
        .query({ branchId: world.companyA.branchId, serviceId: cut, date: d() });
      expect(avail.body.data.employeesUnavailable).toBeUndefined();
    });

    it('refuses time off over booked appointments unless confirmed', async () => {
      const appt = (await book({ employeeId: e2, startsAt: at(day(14), '10:00') })).body.data;
      const body = {
        employeeId: e2,
        type: 'SICK',
        startsAt: at(day(14), '09:00'),
        endsAt: at(day(14), '18:00'),
      };
      const refused = await post(`${company()}/time-off`, body);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('TIME_OFF_CONFLICT');
      expect(refused.body.error.details.appointments[0].appointmentId).toBe(appt.id);

      const ok = await post(`${company()}/time-off`, { ...body, allowConflicts: true });
      expect(ok.status).toBe(201);
      expect(ok.body.data.conflicts).toHaveLength(1);
      // The appointment is not cancelled behind anyone's back.
      const still = await get(`${company()}/appointments/${appt.id}`);
      expect(still.body.data.status).toBe('CONFIRMED');
    });

    it('an employee requests their own time off as pending; a manager approves it', async () => {
      const token = await memberLinkedTo(e2, SYSTEM_ROLES.EMPLOYEE);
      const req = await post(
        `${company()}/time-off`,
        {
          employeeId: e2,
          type: 'PERSONAL',
          startsAt: at(day(16), '09:00'),
          endsAt: at(day(16), '13:00'),
        },
        token,
      );
      expect(req.status).toBe(201);
      expect(req.body.data.status).toBe('PENDING');

      // Pending time off does not block bookings yet.
      const avail = await get(`${company()}/availability`, {
        branchId: world.companyA.branchId,
        serviceId: cut,
        date: day(16),
        employeeId: e2,
      });
      expect(
        avail.body.data.slots.some((s: { startAt: string }) => s.startAt === at(day(16), '10:00')),
      ).toBe(true);

      // Cannot approve their own, nor request someone else's.
      expect(
        (await patch(`${company()}/time-off/${req.body.data.id}`, { status: 'APPROVED' }, token))
          .status,
      ).toBe(403);
      const forOther = await post(
        `${company()}/time-off`,
        {
          employeeId: e1,
          type: 'PERSONAL',
          startsAt: at(day(16), '09:00'),
          endsAt: at(day(16), '10:00'),
        },
        token,
      );
      expect(forOther.status).toBe(403);

      // Without an employeeId it is their own.
      const own = await post(
        `${company()}/time-off`,
        { type: 'TRAINING', startsAt: at(day(17), '09:00'), endsAt: at(day(17), '10:00') },
        token,
      );
      expect(own.status).toBe(201);
      expect(own.body.data).toMatchObject({ employeeId: e2, status: 'PENDING' });
      // A manager must say whose it is.
      const noEmployee = await post(`${company()}/time-off`, {
        type: 'TRAINING',
        startsAt: at(day(17), '09:00'),
        endsAt: at(day(17), '10:00'),
      });
      expect(noEmployee.status).toBe(400);

      // Sees only their own.
      const list = await get(`${company()}/time-off`, {}, token);
      expect(list.body.data.items.every((t: { employeeId: string }) => t.employeeId === e2)).toBe(
        true,
      );

      const approved = await patch(`${company()}/time-off/${req.body.data.id}`, {
        status: 'APPROVED',
      });
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('APPROVED');
      const after = await get(`${company()}/availability`, {
        branchId: world.companyA.branchId,
        serviceId: cut,
        date: day(16),
        employeeId: e2,
      });
      expect(
        after.body.data.slots.some((s: { startAt: string }) => s.startAt === at(day(16), '10:00')),
      ).toBe(false);

      // Cancelling it frees the time again.
      expect((await del(`${company()}/time-off/${req.body.data.id}`)).status).toBe(200);
      const freed = await get(`${company()}/availability`, {
        branchId: world.companyA.branchId,
        serviceId: cut,
        date: day(16),
        employeeId: e2,
      });
      expect(
        freed.body.data.slots.some((s: { startAt: string }) => s.startAt === at(day(16), '10:00')),
      ).toBe(true);
    });

    it('validates periods and stays inside the company', async () => {
      const backwards = await post(`${company()}/time-off`, {
        employeeId: e1,
        type: 'OTHER',
        startsAt: at(day(18), '12:00'),
        endsAt: at(day(18), '10:00'),
      });
      expect(backwards.status).toBe(400);

      const cross = await post(
        `${company(world.companyB.id)}/time-off`,
        {
          employeeId: e1,
          type: 'OTHER',
          startsAt: at(day(18), '10:00'),
          endsAt: at(day(18), '12:00'),
        },
        ownerB,
      );
      expect(cross.status).toBe(404);
      const list = await get(`${company(world.companyB.id)}/time-off`, {}, ownerB);
      expect(list.body.data.items.some((t: { employeeId: string }) => t.employeeId === e1)).toBe(
        false,
      );
    });
  });

  // ===========================================================================
  // Resources
  // ===========================================================================

  describe('resources', () => {
    it('creates a resource, limits it to weekly windows, and books inside them only', async () => {
      const created = await post(`${company()}/resources`, {
        branchId: world.companyA.branchId,
        resourceTypeId: roomType,
        name: 'Room 1',
      });
      expect(created.status).toBe(201);
      room = created.body.data.id;

      const rules = Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        startsAt: '09:00',
        endsAt: '12:00',
      }));
      const saved = await put(`${company()}/resources/${room}/availability`, { rules });
      expect(saved.status).toBe(200);
      expect(saved.body.data.rules).toHaveLength(7);

      const avail = await get(`${company()}/availability`, {
        branchId: world.companyA.branchId,
        serviceId: massage,
        date: day(20),
      });
      const starts = avail.body.data.slots.map((s: { startAt: string }) => s.startAt);
      expect(starts).toContain(at(day(20), '10:00'));
      expect(starts).not.toContain(at(day(20), '14:00'));

      const outside = await book({
        serviceId: massage,
        employeeId: e1,
        startsAt: at(day(20), '14:00'),
      });
      expect(outside.status).toBe(409);
      const inside = await book({
        serviceId: massage,
        employeeId: e1,
        startsAt: at(day(20), '10:00'),
      });
      expect(inside.status).toBe(201);
    });

    it('an unavailable period blocks booking, and refuses over booked appointments', async () => {
      const add = await post(`${company()}/resources/${room}/unavailability`, {
        startsAt: at(day(21), '00:00'),
        endsAt: at(day(22), '00:00'),
        reason: 'MAINTENANCE',
      });
      expect(add.status).toBe(201);
      const res = await book({
        serviceId: massage,
        employeeId: e1,
        startsAt: at(day(21), '10:00'),
      });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('RESOURCE_UNAVAILABLE');

      // Over the booking made in the previous test.
      const over = await post(`${company()}/resources/${room}/unavailability`, {
        startsAt: at(day(20), '09:00'),
        endsAt: at(day(20), '12:00'),
      });
      expect(over.status).toBe(409);
      expect(over.body.error.details.appointments).toHaveLength(1);

      // Removing it frees the day again.
      expect(
        (await del(`${company()}/resources/${room}/unavailability/${add.body.data.id}`)).status,
      ).toBe(200);
      expect(
        (await book({ serviceId: massage, employeeId: e1, startsAt: at(day(21), '10:00') })).status,
      ).toBe(201);
    });

    it('cannot be read or changed by another company', async () => {
      expect(
        (await get(`${company(world.companyB.id)}/resources/${room}`, {}, ownerB)).status,
      ).toBe(404);
      expect(
        (
          await put(
            `${company(world.companyB.id)}/resources/${room}/availability`,
            { rules: [] },
            ownerB,
          )
        ).status,
      ).toBe(404);
    });

    it('an employee may read resources but not change them', async () => {
      const token = await memberLinkedTo(e1, SYSTEM_ROLES.EMPLOYEE);
      expect((await get(`${company()}/resources`, {}, token)).status).toBe(200);
      expect(
        (await put(`${company()}/resources/${room}/availability`, { rules: [] }, token)).status,
      ).toBe(403);
    });
  });

  // ===========================================================================
  // Concurrency
  // ===========================================================================

  describe('concurrency', () => {
    it('two simultaneous bookings for the same employee and time: exactly one wins', async () => {
      const body = { employeeId: e1, startsAt: at(day(25), '10:00') };
      const results = await Promise.all([book(body), book(body), book(body)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
    });

    it('a capped service takes at most N overlapping bookings across staff', async () => {
      const first = await book({
        serviceId: capped,
        employeeId: e1,
        startsAt: at(day(26), '10:00'),
      });
      expect(first.status).toBe(201);
      const second = await book({
        serviceId: capped,
        employeeId: e2,
        startsAt: at(day(26), '10:00'),
      });
      expect(second.status).toBe(409);
      expect(second.body.error.details.reason).toBe('MAX_CONCURRENT_BOOKINGS');
      // A different time is fine.
      expect(
        (await book({ serviceId: capped, employeeId: e2, startsAt: at(day(26), '12:00') })).status,
      ).toBe(201);
    });

    it('the cap holds when the bookings race', async () => {
      const results = await Promise.all([
        book({ serviceId: capped, employeeId: e1, startsAt: at(day(27), '10:00') }),
        book({ serviceId: capped, employeeId: e2, startsAt: at(day(27), '10:00') }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('two overlapping series racing for the same employee: one wins, the other creates nothing', async () => {
      const body = {
        employeeId: e2,
        startsAt: at(day(28), '15:00'),
        recurrence: { frequency: 'DAILY', count: 3 },
      };
      const results = await Promise.all([series(body), series(body)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const count = await harness.prisma.appointment.count({
        where: {
          companyId: world.companyA.id,
          seriesId: { not: null },
          startsAt: { gte: new Date(at(day(28), '00:00')) },
        },
      });
      expect(count).toBe(3);
    });
  });

  // ===========================================================================
  // helpers
  // ===========================================================================

  async function openAllWeek(companyId: string, branchId: string) {
    await harness.prisma.businessHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        branchId,
        dayOfWeek,
        opensAt: new Date('1970-01-01T09:00:00.000Z'),
        closesAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
  }

  async function makeEmployee(
    companyId: string,
    branchId: string,
    name: string,
    serviceIds: string[],
  ) {
    const { prisma } = harness;
    const employee = await prisma.employee.create({
      data: { companyId, displayName: name, status: 'ACTIVE', isBookable: true },
    });
    await prisma.employeeBranch.create({ data: { companyId, employeeId: employee.id, branchId } });
    await prisma.employeeService.createMany({
      data: serviceIds.map((serviceId) => ({ companyId, employeeId: employee.id, serviceId })),
    });
    await prisma.employeeSchedule.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        employeeId: employee.id,
        branchId,
        dayOfWeek,
        startsAt: new Date('1970-01-01T09:00:00.000Z'),
        endsAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
    return employee.id;
  }

  /** A member of company A with one system role, linked to `employeeId`. */
  async function memberLinkedTo(employeeId: string, roleKey: string): Promise<string> {
    const { prisma } = harness;
    const linked = await prisma.employee.findFirstOrThrow({
      where: { id: employeeId },
      select: { userAccountId: true },
    });
    if (linked.userAccountId) {
      const account = await prisma.userAccount.findFirstOrThrow({
        where: { id: linked.userAccountId },
      });
      return harness.staffTokenForCompany(account.email, world.companyA.id);
    }
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `adv-${roleKey}-${employeeId.slice(-6)}-${Date.now()}@example.com`,
        fullName: `${roleKey} Person`,
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
    await prisma.employee.update({
      where: { id: employeeId },
      data: { userAccountId: account.id },
    });
    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }
});

function isoDaysAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
