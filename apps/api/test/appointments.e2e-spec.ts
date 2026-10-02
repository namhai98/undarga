import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * APPOINTMENT ENGINE
 * ===========================================================================
 *
 * Runs against real PostgreSQL with 001_hardening.sql applied, because the
 * property that matters most — no double booking under concurrency — is
 * enforced by an exclusion constraint and advisory locks that no mock can
 * reproduce.
 *
 * Each block uses its own calendar day so bookings in one block can never be
 * what makes an assertion in another pass or fail.
 */
describe('appointment engine', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;

  let haircut: string;
  let massage: string;
  let e1: string;
  let e2: string;
  let roomType: string;
  let room1: string;
  let customerA: string;

  // Company B fixtures, for ID manipulation.
  let serviceB: string;
  let employeeB: string;
  let resourceB: string;

  const TZ_OFFSET = '+08:00'; // Asia/Ulaanbaatar, no DST
  const day = (n: number) => isoDaysAhead(30 + n);
  const at = (d: string, hhmm: string) => `${d}T${hhmm}:00${TZ_OFFSET}`;

  const base = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/appointments`;

  const post = (path: string, body: object, token = ownerA) =>
    request(http).post(path).set('Authorization', `Bearer ${token}`).send(body);
  const get = (path: string, token = ownerA, query: Record<string, string | number> = {}) =>
    request(http).get(path).set('Authorization', `Bearer ${token}`).query(query);

  const book = (body: Record<string, unknown>, token = ownerA) =>
    post(base(), {
      branchId: world.companyA.branchId,
      customerId: customerA,
      serviceId: haircut,
      ...body,
    }, token);

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    const branchId = world.companyA.branchId;
    customerA = world.companyA.customerId;

    await openAllWeek(companyId, branchId);

    haircut = (
      await prisma.service.create({
        data: {
          companyId,
          name: 'Haircut',
          status: 'ACTIVE',
          durationMin: 60,
          bufferAfterMin: 15,
          priceMinor: 4500n,
          currencyCode: 'MNT',
          requiresEmployee: true,
        },
      })
    ).id;

    roomType = (
      await prisma.resourceType.create({
        data: { companyId, key: 'massage-room', name: 'Massage room', kind: 'ROOM' },
      })
    ).id;
    massage = (
      await prisma.service.create({
        data: {
          companyId,
          name: 'Massage',
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 9000n,
          currencyCode: 'MNT',
          requiresEmployee: true,
          requiresResource: true,
        },
      })
    ).id;
    await prisma.serviceResourceRequirement.create({
      data: { companyId, serviceId: massage, resourceTypeId: roomType, quantity: 1 },
    });
    room1 = (
      await prisma.resource.create({
        data: { companyId, branchId, resourceTypeId: roomType, name: 'Room 1' },
      })
    ).id;

    await prisma.serviceBranch.createMany({
      data: [
        { companyId, serviceId: haircut, branchId },
        { companyId, serviceId: massage, branchId },
      ],
    });

    e1 = await makeEmployee(companyId, branchId, 'Ari', [haircut, massage]);
    e2 = await makeEmployee(companyId, branchId, 'Bat', [haircut, massage]);

    // Company B: a complete, adjacent set of ids to try to smuggle across.
    const bId = world.companyB.id;
    const bBranch = world.companyB.branchId;
    await openAllWeek(bId, bBranch);
    serviceB = (
      await prisma.service.create({
        data: {
          companyId: bId,
          name: 'B service',
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 100n,
          currencyCode: 'MNT',
        },
      })
    ).id;
    await prisma.serviceBranch.create({ data: { companyId: bId, serviceId: serviceB, branchId: bBranch } });
    employeeB = await makeEmployee(bId, bBranch, 'B person', [serviceB]);
    const bType = await prisma.resourceType.create({
      data: { companyId: bId, key: 'room', name: 'Room', kind: 'ROOM' },
    });
    resourceB = (
      await prisma.resource.create({
        data: { companyId: bId, branchId: bBranch, resourceTypeId: bType.id, name: 'B room' },
      })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  // Creation and validation
  // ===========================================================================

  describe('create', () => {
    const d = () => day(0);

    it('books a slot the availability engine offers, deriving end, price and status', async () => {
      const res = await book({ employeeId: e1, startsAt: at(d(), '10:00'), customerNote: 'Short' });

      expect(res.status).toBe(201);
      const a = res.body.data;
      expect(a.status).toBe('CONFIRMED'); // company default: auto-confirm
      expect(a.startsAt).toBe(at(d(), '10:00'));
      expect(a.endsAt).toBe(at(d(), '11:00')); // from the 60-minute service
      expect(a.reservedTo).toBe(at(d(), '11:15')); // plus the 15-minute buffer
      expect(a.timezone).toBe('Asia/Ulaanbaatar');
      expect(a.employee.id).toBe(e1);
      expect(a.appointmentNumber).toMatch(/^APT-\d{8}-[A-Z0-9]{6}$/);
      expect(a.totalMinor).toBe('4500');
      expect(a.snapshot).toMatchObject({
        serviceName: 'Haircut',
        durationMin: 60,
        priceMinor: '4500',
        currencyCode: 'MNT',
        employeeName: 'Ari',
      });
      expect(a.history).toHaveLength(1);
      expect(a.history[0]).toMatchObject({ fromStatus: null, toStatus: 'CONFIRMED' });

      const audit = await harness.prisma.auditLog.findFirst({
        where: { action: 'appointment.created', resourceId: a.id },
      });
      expect(audit).not.toBeNull();
    });

    it('keeps the service snapshot when the service is later renamed and repriced', async () => {
      const res = await book({ employeeId: e2, startsAt: at(d(), '15:00') });
      expect(res.status).toBe(201);

      await harness.prisma.service.update({
        where: { id: haircut },
        data: { name: 'Haircut (new menu)', priceMinor: 9999n },
      });
      const detail = await get(`${base()}/${res.body.data.id}`);
      expect(detail.body.data.service.name).toBe('Haircut');
      expect(detail.body.data.snapshot.priceMinor).toBe('4500');
      expect(detail.body.data.totalMinor).toBe('4500');

      await harness.prisma.service.update({
        where: { id: haircut },
        data: { name: 'Haircut', priceMinor: 4500n },
      });
    });

    it.each([
      ['a local time without an offset', { startsAt: '2026-12-01T10:00:00' }],
      ['an unknown field', { startsAt: '2026-12-01T10:00:00+08:00', endsAt: 'x' }],
      ['a non-uuid employee', { startsAt: '2026-12-01T10:00:00+08:00', employeeId: 'nope' }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await book(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an employee who does not provide the service', async () => {
      const outsider = await makeEmployee(world.companyA.id, world.companyA.branchId, 'Cai', []);
      const res = await book({ employeeId: outsider, startsAt: at(d(), '16:00') });
      expect(res.status).toBe(400);
      expect(res.body.error.details.issues.employeeId).toMatch(/does not provide/);
    });

    it('rejects a time that is not on the slot grid', async () => {
      const res = await book({ employeeId: e2, startsAt: at(d(), '12:07') });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('rejects a time in the past', async () => {
      const res = await book({ employeeId: e2, startsAt: '2020-01-06T10:00:00+08:00' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
      expect(res.body.error.details.reason).toBe('DATE_IN_PAST');
    });

    it('rejects a time outside business hours', async () => {
      const res = await book({ employeeId: e2, startsAt: at(d(), '20:00') });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });
  });

  // ===========================================================================
  // Employee conflicts — e1 holds 10:00–11:00, reserved to 11:15, on day(0)
  // ===========================================================================

  describe('employee conflicts', () => {
    const d = () => day(0);

    it.each([
      ['an exact overlap', '10:00'],
      ['a partial overlap', '10:30'],
      ['a nested overlap', '10:15'],
      ['a start inside the buffer', '11:00'],
      ['an end inside the existing booking', '09:15'],
    ])('refuses %s', async (_label, hhmm) => {
      const res = await book({ employeeId: e1, startsAt: at(d(), hhmm) });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
      expect(res.body.error.details.reason).toBe('EMPLOYEE_NOT_AVAILABLE');
    });

    it('allows the first start after the buffer', async () => {
      const res = await book({ employeeId: e1, startsAt: at(d(), '11:15') });
      expect(res.status).toBe(201);
    });

    it('allows another employee at the same time', async () => {
      const res = await book({ employeeId: e2, startsAt: at(d(), '10:00') });
      expect(res.status).toBe(201);
    });
  });

  // ===========================================================================
  // Resource conflicts — day(1)
  // ===========================================================================

  describe('resource conflicts', () => {
    const d = () => day(1);

    it('assigns the room and refuses a second booking needing it', async () => {
      const first = await book({ serviceId: massage, employeeId: e1, startsAt: at(d(), '14:00') });
      expect(first.status).toBe(201);
      expect(first.body.data.resources).toEqual([{ id: room1, name: 'Room 1' }]);

      // e2 is free, but the only room is not.
      const second = await book({ serviceId: massage, employeeId: e2, startsAt: at(d(), '14:30') });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('books the second room once one exists', async () => {
      const room2 = await harness.prisma.resource.create({
        data: {
          companyId: world.companyA.id,
          branchId: world.companyA.branchId,
          resourceTypeId: roomType,
          name: 'Room 2',
        },
      });
      const res = await book({ serviceId: massage, employeeId: e2, startsAt: at(d(), '14:30') });
      expect(res.status).toBe(201);
      expect(res.body.data.resources).toEqual([{ id: room2.id, name: 'Room 2' }]);
    });

    it('refuses a named resource that is already taken', async () => {
      const res = await book({
        serviceId: massage,
        employeeId: e2,
        resourceId: room1,
        startsAt: at(d(), '16:00'),
      });
      expect(res.status).toBe(201);

      const clash = await book({
        serviceId: massage,
        employeeId: e1,
        resourceId: room1,
        startsAt: at(d(), '16:30'),
      });
      expect(clash.status).toBe(409);
      expect(clash.body.error.details.reason).toBe('RESOURCE_NOT_AVAILABLE');
    });

    it('rejects a resource the service does not use', async () => {
      const res = await book({ employeeId: e1, resourceId: room1, startsAt: at(d(), '09:00') });
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // Concurrency — real PostgreSQL, day(2)
  // ===========================================================================

  describe('concurrent booking', () => {
    const d = () => day(2);

    it('lets exactly one of several simultaneous requests for one slot succeed', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 6 }, () => book({ employeeId: e2, startsAt: at(d(), '10:00') })),
      );

      const statuses = attempts.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(5);
      for (const r of attempts.filter((x) => x.status === 409)) {
        expect(['SLOT_TAKEN', 'SLOT_UNAVAILABLE']).toContain(r.body.error.code);
      }

      const live = await harness.prisma.appointmentItem.count({
        where: {
          companyId: world.companyA.id,
          employeeId: e2,
          blocksCalendar: true,
          startsAt: new Date(at(d(), '10:00')),
        },
      });
      expect(live).toBe(1);
    });

    it('lets simultaneous OVERLAPPING (not identical) requests produce exactly one booking', async () => {
      const attempts = await Promise.all([
        book({ employeeId: e1, startsAt: at(d(), '13:00') }),
        book({ employeeId: e1, startsAt: at(d(), '13:30') }),
        book({ employeeId: e1, startsAt: at(d(), '12:30') }),
      ]);
      expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    });

    it('is enforced by the database even when the application is bypassed', async () => {
      // Two raw inserts racing on the owner connection: no availability check,
      // no advisory lock. Only the exclusion constraint stands between them.
      const { prisma } = harness;
      const companyId = world.companyA.id;
      const branchId = world.companyA.branchId;
      const start = new Date(at(d(), '15:00'));
      const end = new Date(at(d(), '16:00'));

      const shells = await Promise.all(
        [1, 2].map((n) =>
          prisma.appointment.create({
            data: {
              companyId,
              branchId,
              customerId: customerA,
              appointmentNumber: `RAW-${Date.now()}-${n}`,
              status: 'CONFIRMED',
              startsAt: start,
              endsAt: end,
              bookedTimezoneName: 'Asia/Ulaanbaatar',
              currencyCode: 'MNT',
            },
          }),
        ),
      );

      const results = await Promise.allSettled(
        shells.map((shell, i) =>
          prisma.appointmentItem.create({
            data: {
              companyId,
              appointmentId: shell.id,
              branchId,
              serviceId: haircut,
              employeeId: e1,
              status: 'CONFIRMED',
              // Partial overlap: 15:00–16:00 and 15:30–16:30.
              startsAt: new Date(start.getTime() + i * 30 * 60_000),
              endsAt: new Date(end.getTime() + i * 30 * 60_000),
              durationMin: 60,
              unitPriceMinor: 1n,
              totalMinor: 1n,
              snapshot: {},
            },
          }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(rejected.reason)).toContain('23P01');
      expect(String(rejected.reason)).toContain('appointment_item_employee_no_overlap');
    });
  });

  // ===========================================================================
  // Status transitions — day(3)
  // ===========================================================================

  describe('status transitions', () => {
    const d = () => day(3);

    it('walks CONFIRMED → IN_PROGRESS → COMPLETED and refuses anything else', async () => {
      const id = (await book({ employeeId: e1, startsAt: at(d(), '09:00') })).body.data.id;
      const act = (verb: string) => post(`${base()}/${id}/${verb}`, {});

      expect((await act('confirm')).body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect((await act('complete')).body.error.code).toBe('INVALID_STATUS_TRANSITION');

      const started = await act('start');
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe('IN_PROGRESS');

      const completed = await act('complete');
      expect(completed.status).toBe(200);
      expect(completed.body.data.status).toBe('COMPLETED');
      expect(completed.body.data.completedAt).not.toBeNull();

      // Terminal.
      const cancel = await post(`${base()}/${id}/cancel`, { reason: 'Too late' });
      expect(cancel.status).toBe(409);
      expect((await act('start')).status).toBe(409);

      expect(completed.body.data.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        'CONFIRMED',
        'IN_PROGRESS',
        'COMPLETED',
      ]);

      const audited = await harness.prisma.auditLog.count({
        where: {
          resourceId: id,
          action: { in: ['appointment.started', 'appointment.completed'] },
        },
      });
      expect(audited).toBe(2);
    });

    it('starts PENDING when the company does not auto-confirm, then confirms', async () => {
      await harness.prisma.companySettings.update({
        where: { companyId: world.companyA.id },
        data: { autoConfirmBookings: false },
      });
      try {
        const created = await book({ employeeId: e2, startsAt: at(d(), '09:00') });
        expect(created.body.data.status).toBe('PENDING');
        expect(created.body.data.confirmedAt).toBeNull();

        const confirmed = await post(`${base()}/${created.body.data.id}/confirm`, {});
        expect(confirmed.body.data.status).toBe('CONFIRMED');
        expect(confirmed.body.data.confirmedAt).not.toBeNull();
      } finally {
        await harness.prisma.companySettings.update({
          where: { companyId: world.companyA.id },
          data: { autoConfirmBookings: true },
        });
      }
    });

    it('marks a no-show only after the start time, releasing the slot', async () => {
      const id = (await book({ employeeId: e1, startsAt: at(d(), '12:00') })).body.data.id;

      const early = await post(`${base()}/${id}/no-show`, {});
      expect(early.status).toBe(400);

      // Wind the clock back on this one appointment.
      await harness.prisma.appointment.update({
        where: { id },
        data: { startsAt: new Date(Date.now() - 60 * 60_000) },
      });
      const noShow = await post(`${base()}/${id}/no-show`, { reason: 'Did not arrive' });
      expect(noShow.status).toBe(200);
      expect(noShow.body.data.status).toBe('NO_SHOW');

      const item = await harness.prisma.appointmentItem.findFirstOrThrow({
        where: { appointmentId: id },
      });
      expect(item.blocksCalendar).toBe(false);
    });
  });

  // ===========================================================================
  // Cancel and reschedule — day(4)
  // ===========================================================================

  describe('cancellation', () => {
    const d = () => day(4);

    it('requires a reason', async () => {
      const id = (await book({ employeeId: e1, startsAt: at(d(), '09:00') })).body.data.id;
      const res = await post(`${base()}/${id}/cancel`, {});
      expect(res.status).toBe(400);
    });

    it('keeps the row, records who and why, and frees the employee and the room', async () => {
      const created = await book({ serviceId: massage, employeeId: e2, startsAt: at(d(), '11:00') });
      expect(created.status).toBe(201);
      const id = created.body.data.id;

      const res = await post(`${base()}/${id}/cancel`, { reason: 'Customer is ill' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(res.body.data.cancellation).toMatchObject({
        reason: 'Customer is ill',
        byType: 'COMPANY_USER',
      });
      expect(res.body.data.cancellation.cancelledAt).toBeTruthy();

      const item = await harness.prisma.appointmentItem.findFirstOrThrow({
        where: { appointmentId: id },
        include: { resources: true },
      });
      expect(item.blocksCalendar).toBe(false);
      expect(item.resources.every((r) => r.blocksCalendar === false)).toBe(true);

      // Not deleted.
      expect(await harness.prisma.appointment.count({ where: { id } })).toBe(1);

      // The slot is free again — same employee, same room, same time.
      const again = await book({
        serviceId: massage,
        employeeId: e2,
        resourceId: created.body.data.resources[0].id,
        startsAt: at(d(), '11:00'),
      });
      expect(again.status).toBe(201);
    });
  });

  describe('reschedule', () => {
    const d = () => day(4);

    it('cancels the original and creates a linked successor, even overlapping itself', async () => {
      const original = (await book({ employeeId: e1, startsAt: at(d(), '14:00') })).body.data;

      // 14:15 overlaps the original's own 14:00–15:15 reservation. The
      // appointment being moved must not block itself.
      const res = await post(`${base()}/${original.id}/reschedule`, {
        startsAt: at(d(), '14:15'),
        reason: 'Running late',
      });
      expect(res.status).toBe(200);
      const moved = res.body.data;
      expect(moved.id).not.toBe(original.id);
      expect(moved.startsAt).toBe(at(d(), '14:15'));
      expect(moved.employee.id).toBe(e1);
      expect(moved.rescheduledFrom.id).toBe(original.id);

      const old = (await get(`${base()}/${original.id}`)).body.data;
      expect(old.status).toBe('CANCELLED');
      expect(old.cancellation.reason).toMatch(/^RESCHEDULED/);
      expect(old.rescheduledTo.id).toBe(moved.id);

      const audit = await harness.prisma.auditLog.findFirst({
        where: { action: 'appointment.rescheduled', resourceId: original.id },
      });
      expect(audit).not.toBeNull();
    });

    it('refuses to move onto a slot someone else holds, leaving the original intact', async () => {
      const blocker = await book({ employeeId: e2, startsAt: at(d(), '16:00') });
      expect(blocker.status).toBe(201);
      const mine = (await book({ employeeId: e2, startsAt: at(d(), '09:00') })).body.data;

      const res = await post(`${base()}/${mine.id}/reschedule`, { startsAt: at(d(), '16:00') });
      expect(res.status).toBe(409);

      // Atomic: the failed reschedule did not cancel the original.
      const still = (await get(`${base()}/${mine.id}`)).body.data;
      expect(still.status).toBe('CONFIRMED');
    });

    it('refuses to reschedule a cancelled appointment', async () => {
      const id = (await book({ employeeId: e2, startsAt: at(d(), '12:00') })).body.data.id;
      await post(`${base()}/${id}/cancel`, { reason: 'x' });
      const res = await post(`${base()}/${id}/reschedule`, { startsAt: at(d(), '13:00') });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });
  });

  // ===========================================================================
  // Listing, auto-assignment — day(5)
  // ===========================================================================

  describe('listing', () => {
    const d = () => day(5);

    it('assigns the first eligible employee deterministically when none is named', async () => {
      const res = await book({ startsAt: at(d(), '10:00') });
      expect(res.status).toBe(201);
      expect(res.body.data.employee.id).toBe([e1, e2].sort()[0]);
    });

    it('filters by employee, status, date range and paginates', async () => {
      await book({ employeeId: e2, startsAt: at(d(), '12:00') });
      await book({ employeeId: e2, startsAt: at(d(), '14:00') });

      const byEmployee = await get(base(), ownerA, { employeeId: e2, from: d(), to: d() });
      expect(byEmployee.status).toBe(200);
      expect(byEmployee.body.data.items.length).toBeGreaterThanOrEqual(2);
      expect(
        byEmployee.body.data.items.every((a: { employee: { id: string } }) => a.employee.id === e2),
      ).toBe(true);

      const paged = await get(base(), ownerA, { from: d(), to: d(), limit: 1 });
      expect(paged.body.data.items).toHaveLength(1);
      expect(paged.body.data.total).toBeGreaterThanOrEqual(3);

      const cancelled = await get(base(), ownerA, { status: 'CANCELLED', from: day(4), to: day(4) });
      expect(
        cancelled.body.data.items.every((a: { status: string }) => a.status === 'CANCELLED'),
      ).toBe(true);

      const bad = await get(base(), ownerA, { status: 'NOT_A_STATUS' });
      expect(bad.status).toBe(400);
    });

    it('narrows an :own caller to their own appointments', async () => {
      const token = await memberLinkedTo(e1, SYSTEM_ROLES.EMPLOYEE);
      const res = await get(base(), token, { from: d(), to: d() });
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      expect(
        res.body.data.items.every((a: { employee: { id: string } }) => a.employee.id === e1),
      ).toBe(true);

      const someoneElses = (await get(base(), ownerA, { employeeId: e2, from: d(), to: d() })).body
        .data.items[0].id;
      expect((await get(`${base()}/${someoneElses}`, token)).status).toBe(404);
    });
  });

  // ===========================================================================
  // Tenant isolation — ID manipulation
  // ===========================================================================

  describe('tenant isolation', () => {
    let appointmentA: string;

    beforeAll(async () => {
      appointmentA = (await book({ employeeId: e1, startsAt: at(day(6), '10:00') })).body.data.id;
    });

    it.each(['', '/confirm', '/start', '/complete', '/no-show'])(
      'company B cannot reach company A’s appointment via %s',
      async (suffix) => {
        const res = suffix
          ? await post(`${base(world.companyB.id)}/${appointmentA}${suffix}`, {}, ownerB)
          : await get(`${base(world.companyB.id)}/${appointmentA}`, ownerB);
        expect(res.status).toBe(404);
      },
    );

    it('company B cannot cancel or reschedule company A’s appointment', async () => {
      const cancel = await post(
        `${base(world.companyB.id)}/${appointmentA}/cancel`,
        { reason: 'x' },
        ownerB,
      );
      expect(cancel.status).toBe(404);
      const move = await post(
        `${base(world.companyB.id)}/${appointmentA}/reschedule`,
        { startsAt: at(day(6), '12:00') },
        ownerB,
      );
      expect(move.status).toBe(404);

      const untouched = await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appointmentA } });
      expect(untouched.status).toBe('CONFIRMED');
    });

    it('company A cannot book with company B’s ids', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['customer', { customerId: world.companyB.customerId }],
        ['service', { serviceId: serviceB }],
        ['branch', { branchId: world.companyB.branchId }],
        ['employee', { employeeId: employeeB }],
        ['resource', { serviceId: massage, employeeId: e1, resourceId: resourceB }],
      ];
      for (const [label, override] of cases) {
        const res = await book({ employeeId: e1, startsAt: at(day(6), '15:00'), ...override });
        expect({ label, status: res.status }).toEqual({ label, status: 404 });
      }
    });

    it('company B’s list never contains company A’s appointments', async () => {
      const res = await get(base(world.companyB.id), ownerB, { limit: 100 });
      const ids = res.body.data.items.map((a: { id: string }) => a.id);
      expect(ids).not.toContain(appointmentA);
    });
  });

  // ===========================================================================
  // Fixtures
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
  ): Promise<string> {
    const { prisma } = harness;
    const employee = await prisma.employee.create({
      data: { companyId, displayName: name, status: 'ACTIVE', isBookable: true },
    });
    await prisma.employeeBranch.create({ data: { companyId, employeeId: employee.id, branchId } });
    if (serviceIds.length) {
      await prisma.employeeService.createMany({
        data: serviceIds.map((serviceId) => ({ companyId, employeeId: employee.id, serviceId })),
      });
    }
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

  /** A member of company A with one system role, whose login is linked to `employeeId`. */
  async function memberLinkedTo(employeeId: string, roleKey: string): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `appt-${roleKey}-${Date.now()}@example.com`,
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
    await prisma.employee.update({ where: { id: employeeId }, data: { userAccountId: account.id } });

    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }
});

function isoDaysAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
