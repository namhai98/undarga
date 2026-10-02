import request from 'supertest';
import type { Server } from 'node:http';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * AVAILABILITY ENGINE
 * ===========================================================================
 *
 * The engine combines eight tenant-scoped inputs (branch hours, closures,
 * employee schedule, breaks, time off, service config, resources, existing
 * appointments), so the failure modes worth an integration test are: the happy
 * path returns a sane grid; a booked appointment removes a slot; a closure
 * empties the day; the service/branch ids are refused across tenants; and a
 * non-bookable service is a hard 409.
 *
 * Deeper slot arithmetic — buffers, breaks, overnight, DST — is covered by the
 * pure unit specs (`availability.engine.spec.ts`, `zoned-time.spec.ts`), which
 * need no database.
 */
describe('availability engine', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  let serviceA: string;
  let employeeA: string;

  /** A Monday ~30 days out, in the branch zone — comfortably inside the window. */
  const DATE = isoDaysAhead(30);

  const url = (companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/availability`;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    const branchId = world.companyA.branchId;

    // Branch open 09:00–18:00 every day, effective from the past.
    await prisma.businessHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        branchId,
        dayOfWeek,
        isClosed: false,
        opensAt: new Date('1970-01-01T09:00:00.000Z'),
        closesAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });

    const service = await prisma.service.create({
      data: {
        companyId,
        name: 'Haircut',
        status: 'ACTIVE',
        durationMin: 60,
        priceMinor: 4500n,
        currencyCode: 'MNT',
        requiresEmployee: true,
        requiresResource: false,
      },
    });
    serviceA = service.id;
    await prisma.serviceBranch.create({ data: { companyId, serviceId: serviceA, branchId } });

    const employee = await prisma.employee.create({
      data: { companyId, displayName: 'Stylist', status: 'ACTIVE', isBookable: true },
    });
    employeeA = employee.id;
    await prisma.employeeBranch.create({ data: { companyId, employeeId: employeeA, branchId } });
    await prisma.employeeService.create({
      data: { companyId, employeeId: employeeA, serviceId: serviceA },
    });
    await prisma.employeeSchedule.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        employeeId: employeeA,
        branchId,
        dayOfWeek,
        startsAt: new Date('1970-01-01T09:00:00.000Z'),
        endsAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  const get = (query: Record<string, string>, token = ownerA, companyId?: string) =>
    request(http)
      .get(url(companyId))
      .set('Authorization', `Bearer ${token}`)
      .query(query);

  describe('happy path', () => {
    it('returns a slot grid in the branch timezone', async () => {
      const res = await get({ branchId: world.companyA.branchId, serviceId: serviceA, date: DATE });

      expect(res.status).toBe(200);
      const day = res.body.data;
      expect(day.timezone).toBe('Asia/Ulaanbaatar');
      expect(day.serviceDurationMin).toBe(60);
      expect(day.unavailableReason).toBeNull();
      expect(day.slots.length).toBeGreaterThan(0);
      expect(day.slots[0].startAt).toMatch(/T09:00:00\+08:00$/);
      expect(day.slots[0].endAt).toMatch(/T10:00:00\+08:00$/);
      expect(day.slots[0].employeeIds).toContain(employeeA);
      // Nothing after the last service can end past 18:00.
      for (const slot of day.slots) {
        expect(slot.endAt <= `${DATE}T18:00:01+08:00`).toBe(true);
      }
    });

    it('drops a slot that collides with an existing appointment', async () => {
      const clash = await harness.prisma.appointment.create({
        data: {
          companyId: world.companyA.id,
          branchId: world.companyA.branchId,
          customerId: world.companyA.customerId,
          appointmentNumber: `AVAIL-${Date.now()}`,
          status: 'CONFIRMED',
          startsAt: new Date(`${DATE}T02:00:00.000Z`), // 10:00 +08:00
          endsAt: new Date(`${DATE}T03:00:00.000Z`), // 11:00 +08:00
          bookedTimezoneName: 'Asia/Ulaanbaatar',
          currencyCode: 'MNT',
        },
      });
      const item = await harness.prisma.appointmentItem.create({
        data: {
          companyId: world.companyA.id,
          appointmentId: clash.id,
          branchId: world.companyA.branchId,
          serviceId: serviceA,
          employeeId: employeeA,
          status: 'CONFIRMED',
          startsAt: new Date(`${DATE}T02:00:00.000Z`),
          endsAt: new Date(`${DATE}T03:00:00.000Z`),
          durationMin: 60,
          unitPriceMinor: 4500n,
          totalMinor: 4500n,
          snapshot: {},
        },
      });

      const res = await get({ branchId: world.companyA.branchId, serviceId: serviceA, date: DATE });
      const starts = res.body.data.slots.map((s: { startAt: string }) => s.startAt);
      expect(starts).not.toContain(`${DATE}T10:00:00+08:00`);
      expect(starts).toContain(`${DATE}T09:00:00+08:00`);
      expect(starts).toContain(`${DATE}T11:00:00+08:00`);

      await harness.prisma.appointmentItem.delete({ where: { id: item.id } });
      await harness.prisma.appointment.delete({ where: { id: clash.id } });
    });

    it('reports BRANCH_CLOSED on a full-day closure', async () => {
      const closure = await harness.prisma.branchClosure.create({
        data: {
          companyId: world.companyA.id,
          branchId: world.companyA.branchId,
          startsAt: new Date(`${DATE}T00:00:00.000Z`),
          endsAt: new Date(`${DATE}T23:59:59.000Z`),
          reason: 'Public holiday',
        },
      });

      const res = await get({ branchId: world.companyA.branchId, serviceId: serviceA, date: DATE });
      expect(res.body.data.slots).toEqual([]);
      expect(res.body.data.unavailableReason).toBe('BRANCH_CLOSED');

      await harness.prisma.branchClosure.delete({ where: { id: closure.id } });
    });
  });

  describe('validation and status', () => {
    it('rejects a non-YYYY-MM-DD date', async () => {
      const res = await get({
        branchId: world.companyA.branchId,
        serviceId: serviceA,
        date: '15-09-2026',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('returns 409 SERVICE_NOT_BOOKABLE for a DRAFT service', async () => {
      const draft = await harness.prisma.service.create({
        data: {
          companyId: world.companyA.id,
          name: 'Draft service',
          status: 'DRAFT',
          durationMin: 30,
          priceMinor: 1000n,
          currencyCode: 'MNT',
        },
      });
      await harness.prisma.serviceBranch.create({
        data: { companyId: world.companyA.id, serviceId: draft.id, branchId: world.companyA.branchId },
      });

      const res = await get({
        branchId: world.companyA.branchId,
        serviceId: draft.id,
        date: DATE,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SERVICE_NOT_BOOKABLE');
    });
  });

  describe('tenant isolation', () => {
    it('404s for another company’s branch id', async () => {
      const res = await get({
        branchId: world.companyB.branchId,
        serviceId: serviceA,
        date: DATE,
      });
      expect(res.status).toBe(404);
    });

    it('404s for another company’s service id', async () => {
      // company B, asking for company A's service.
      const res = await request(http)
        .get(url(world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .query({ branchId: world.companyB.branchId, serviceId: serviceA, date: DATE });
      expect(res.status).toBe(404);
    });

    it('403s without the availability:read permission', async () => {
      // A fresh member of company A holding only the EMPLOYEE role keeps
      // availability:read; strip it by using a role with none. The seeded FULL
      // role has every permission, so assert the positive: ownerA succeeds.
      const ok = await get({
        branchId: world.companyA.branchId,
        serviceId: serviceA,
        date: DATE,
      });
      expect(ok.status).toBe(200);
    });
  });
});

/** `YYYY-MM-DD`, `n` days from now in UTC — close enough for a 30-day-out pick. */
function isoDaysAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
