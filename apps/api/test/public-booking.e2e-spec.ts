import request from 'supertest';
import type { Server } from 'node:http';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * PUBLIC BOOKING — anonymous, against real PostgreSQL
 * ===========================================================================
 *
 * No request in this file carries a token. Everything a visitor can see or do
 * is established by the slug in the URL alone, so the interesting failures are
 * about what leaks (private services, other tenants, internal fields) and what
 * gets through (bad slots, double bookings, wrong staff).
 */
describe('public booking', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let branch: string;
  let closedBranch: string;
  let cut: string;
  let internal: string;
  let draft: string;
  let notOffered: string;
  let hair: string;
  let e1: string;
  let e2: string;
  let notBookable: string;
  let bService: string;
  let bEmployee: string;

  const SLUG = 'company-a';
  const base = (slug = SLUG) => `/api/v1/public/companies/${slug}`;
  const day = (n: number) => isoDaysAhead(30 + n);
  const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+08:00`;

  const customer = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Nomin',
    lastName: 'Bat',
    phone: `+9768${String(Date.now()).slice(-7)}`,
    email: `nomin-${Date.now()}@example.com`,
    ...overrides,
  });

  const book = (body: Record<string, unknown>, slug = SLUG) =>
    request(http)
      .post(`${base(slug)}/bookings`)
      .send({ branchId: branch, serviceId: cut, customer: customer(), ...body });

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    branch = world.companyA.branchId;
    await openAllWeek(companyId, branch);

    closedBranch = (
      await prisma.branch.create({
        data: { companyId, code: 'NOWEB', name: 'Phone-only branch', timezoneName: 'Asia/Ulaanbaatar' },
      })
    ).id;
    await openAllWeek(companyId, closedBranch);
    await prisma.branchSettings.create({
      data: { companyId, branchId: closedBranch, allowOnlineBooking: false },
    });

    hair = (await prisma.serviceCategory.create({ data: { companyId, name: 'Hair' } })).id;
    const svc = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.service.create({
        data: {
          companyId,
          name,
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 4500000n,
          currencyCode: 'MNT',
          requiresEmployee: true,
          isOnlineBookable: true,
          ...extra,
        },
      });
    cut = (await svc('Haircut', { categoryId: hair })).id;
    internal = (await svc('Staff training', { isOnlineBookable: false })).id;
    draft = (await svc('Coming soon', { status: 'DRAFT' })).id;
    notOffered = (await svc('Other branch only')).id;

    await prisma.serviceBranch.createMany({
      data: [cut, internal, draft].map((serviceId) => ({ companyId, serviceId, branchId: branch })),
    });
    await prisma.serviceBranch.create({ data: { companyId, serviceId: cut, branchId: closedBranch } });

    e1 = await makeEmployee(companyId, branch, 'Ari', [cut, internal, draft]);
    e2 = await makeEmployee(companyId, branch, 'Bat', [cut]);
    notBookable = await makeEmployee(companyId, branch, 'Manager', [cut], { isBookable: false });
    await prisma.employeeProfile.create({
      data: { companyId, employeeId: e1, jobTitle: 'Senior stylist', phone: '+97611111111' },
    });

    // Company B, for cross-tenant ids.
    const bId = world.companyB.id;
    await openAllWeek(bId, world.companyB.branchId);
    bService = (
      await prisma.service.create({
        data: {
          companyId: bId,
          name: 'B cut',
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 100n,
          currencyCode: 'MNT',
          isOnlineBookable: true,
        },
      })
    ).id;
    await prisma.serviceBranch.create({
      data: { companyId: bId, serviceId: bService, branchId: world.companyB.branchId },
    });
    bEmployee = await makeEmployee(bId, world.companyB.branchId, 'B person', [bService]);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  // Company access
  // ===========================================================================

  describe('company page', () => {
    it('shows the company and its online branches, without a login', async () => {
      const res = await request(http).get(base());
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Company A');
      expect(res.body.data.slug).toBe(SLUG);
      const names = res.body.data.branches.map((b: { name: string }) => b.name);
      expect(names).toContain('Company A main branch');
      expect(names).not.toContain('Phone-only branch');
    });

    it('exposes no internal company fields', async () => {
      const body = JSON.stringify((await request(http).get(base())).body);
      for (const field of ['legalName', 'taxNumber', 'registrationNumber', 'contactEmail', 'companyId', world.companyA.id]) {
        expect(body).not.toContain(field);
      }
    });

    it.each(['no-such-company', 'Company-A', 'a'])('404s for slug %s', async (slug) => {
      const res = await request(http).get(base(slug));
      expect([400, 404]).toContain(res.status);
    });

    it('404s for a company that is suspended or still being set up', async () => {
      for (const status of ['SUSPENDED', 'PENDING_SETUP'] as const) {
        const slug = `hidden-${status.toLowerCase().replace('_', '-')}`;
        await harness.prisma.company.create({
          data: {
            slug,
            legalName: 'Hidden LLC',
            displayName: 'Hidden',
            status,
            defaultTimezoneName: 'Asia/Ulaanbaatar',
            currencyCode: 'MNT',
          },
        });
        expect((await request(http).get(base(slug))).status).toBe(404);
      }
    });
  });

  // ===========================================================================
  // Service & employee filtering
  // ===========================================================================

  describe('service filtering', () => {
    it('lists only active, online-bookable services offered at the branch', async () => {
      const res = await request(http).get(`${base()}/branches/${branch}/services`);
      expect(res.status).toBe(200);
      const names = res.body.data.services.map((s: { name: string }) => s.name);
      expect(names).toEqual(['Haircut']);
      expect(res.body.data.categories).toEqual([{ id: hair, name: 'Hair' }]);
      expect(res.body.data.services[0]).toMatchObject({
        durationMin: 60,
        priceMinor: '4500000',
        currencyCode: 'MNT',
        categoryId: hair,
      });
    });

    it('404s for a branch not taking online bookings, or another company’s branch', async () => {
      expect((await request(http).get(`${base()}/branches/${closedBranch}/services`)).status).toBe(404);
      expect(
        (await request(http).get(`${base()}/branches/${world.companyB.branchId}/services`)).status,
      ).toBe(404);
    });

    it('lists only bookable staff, with name and job title only', async () => {
      const res = await request(http).get(`${base()}/branches/${branch}/services/${cut}/employees`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((e: { name: string }) => e.name)).toEqual(['Ari', 'Bat']);
      expect(res.body.data[0]).toEqual({ id: e1, name: 'Ari', jobTitle: 'Senior stylist' });
      expect(JSON.stringify(res.body)).not.toContain('+97611111111');
    });

    it.each([
      ['internal-only', () => internal],
      ['draft', () => draft],
      ['not offered here', () => notOffered],
      ['another company’s', () => bService],
    ])('404s the employee list of an %s service', async (_label, id) => {
      const res = await request(http).get(`${base()}/branches/${branch}/services/${id()}/employees`);
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // Availability
  // ===========================================================================

  describe('availability', () => {
    it('returns times from the engine, without internal fields', async () => {
      const res = await request(http)
        .get(`${base()}/availability`)
        .query({ branchId: branch, serviceId: cut, date: day(0) });
      expect(res.status).toBe(200);
      expect(res.body.data.timezone).toBe('Asia/Ulaanbaatar');
      expect(res.body.data.slots[0]).toEqual({
        startAt: at(day(0), '09:00'),
        endAt: at(day(0), '10:00'),
        employeeIds: [e1, e2].sort(),
      });
    });

    it('narrows to one employee when asked', async () => {
      const res = await request(http)
        .get(`${base()}/availability`)
        .query({ branchId: branch, serviceId: cut, date: day(0), employeeId: e2 });
      expect(res.body.data.slots.every((s: { employeeIds: string[] }) => s.employeeIds.join() === e2)).toBe(true);
    });

    it.each([
      ['an internal-only service', () => ({ serviceId: internal })],
      ['a draft service', () => ({ serviceId: draft })],
      ['another company’s service', () => ({ serviceId: bService })],
      ['a non-bookable employee', () => ({ employeeId: notBookable })],
      ['another company’s employee', () => ({ employeeId: bEmployee })],
    ])('404s for %s', async (_label, override) => {
      const res = await request(http)
        .get(`${base()}/availability`)
        .query({ branchId: branch, serviceId: cut, date: day(0), ...override() });
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // Booking
  // ===========================================================================

  describe('booking', () => {
    it('books and returns a confirmation with no internal ids', async () => {
      const res = await book({ employeeId: e1, startsAt: at(day(1), '10:00'), note: 'First visit' });

      expect(res.status).toBe(201);
      const c = res.body.data;
      expect(c).toMatchObject({
        status: 'CONFIRMED',
        startsAt: at(day(1), '10:00'),
        endsAt: at(day(1), '11:00'),
        timezone: 'Asia/Ulaanbaatar',
        branch: { name: 'Company A main branch' },
        service: { name: 'Haircut', durationMin: 60 },
        employee: { name: 'Ari' },
        price: { amountMinor: '4500000', currencyCode: 'MNT' },
        customer: { firstName: 'Nomin' },
      });
      expect(c.appointmentNumber).toMatch(/^APT-/);
      const serialised = JSON.stringify(c);
      for (const key of ['"id"', 'customerId', 'companyId', 'reserved', 'resourceIds']) {
        expect(serialised).not.toContain(key);
      }

      const row = await harness.prisma.appointment.findFirstOrThrow({
        where: { appointmentNumber: c.appointmentNumber },
        include: { customer: true },
      });
      expect(row.companyId).toBe(world.companyA.id);
      expect(row.source).toBe('ONLINE');
      expect(row.createdByType).toBe('SYSTEM');
      expect(row.customerNote).toBe('First visit');
      expect(row.customer.source).toBe('ONLINE');
    });

    it('assigns someone when no employee is chosen', async () => {
      const res = await book({ startsAt: at(day(1), '14:00') });
      expect(res.status).toBe(201);
      expect(['Ari', 'Bat']).toContain(res.body.data.employee.name);
    });

    it('reuses the company’s existing customer by phone, without editing it', async () => {
      const existing = await harness.prisma.companyCustomer.findUniqueOrThrow({
        where: { id: world.companyA.customerId },
      });
      const formatted = existing.phone!.replace(/^(\+976)(\d{4})(\d{4})$/, '$1 $2 $3');

      const before = await harness.prisma.companyCustomer.count({ where: { companyId: world.companyA.id } });
      const res = await book({
        employeeId: e2,
        startsAt: at(day(1), '15:00'),
        customer: { firstName: 'Somebody Else', phone: formatted },
      });
      expect(res.status).toBe(201);

      const after = await harness.prisma.companyCustomer.count({ where: { companyId: world.companyA.id } });
      expect(after).toBe(before);

      const appt = await harness.prisma.appointment.findFirstOrThrow({
        where: { appointmentNumber: res.body.data.appointmentNumber },
      });
      expect(appt.customerId).toBe(existing.id);
      const unchanged = await harness.prisma.companyCustomer.findUniqueOrThrow({ where: { id: existing.id } });
      expect(unchanged.firstName).toBe(existing.firstName);
    });

    it('reuses by email when the phone is new', async () => {
      const email = `repeat-${Date.now()}@example.com`;
      const first = await book({ employeeId: e2, startsAt: at(day(2), '09:00'), customer: customer({ email }) });
      const second = await book({ employeeId: e2, startsAt: at(day(2), '11:00'), customer: customer({ email }) });
      expect([first.status, second.status]).toEqual([201, 201]);

      const rows = await harness.prisma.appointment.findMany({
        where: {
          appointmentNumber: {
            in: [first.body.data.appointmentNumber, second.body.data.appointmentNumber],
          },
        },
        select: { customerId: true },
      });
      expect(new Set(rows.map((r) => r.customerId)).size).toBe(1);
    });

    it('never reuses another company’s customer with the same phone', async () => {
      const bCustomer = await harness.prisma.companyCustomer.findUniqueOrThrow({
        where: { id: world.companyB.customerId },
      });
      const res = await book({
        employeeId: e2,
        startsAt: at(day(2), '13:00'),
        customer: customer({ phone: bCustomer.phone, email: undefined }),
      });
      expect(res.status).toBe(201);
      const appt = await harness.prisma.appointment.findFirstOrThrow({
        where: { appointmentNumber: res.body.data.appointmentNumber },
        include: { customer: true },
      });
      expect(appt.companyId).toBe(world.companyA.id);
      expect(appt.customer.companyId).toBe(world.companyA.id);
      expect(appt.customerId).not.toBe(bCustomer.id);
    });

    it('refuses a blocked customer with a deliberately vague answer', async () => {
      const phone = '+97688001122';
      await harness.prisma.companyCustomer.create({
        data: { companyId: world.companyA.id, firstName: 'Blocked', phone, status: 'BLOCKED' },
      });
      const res = await book({ employeeId: e2, startsAt: at(day(2), '15:00'), customer: customer({ phone }) });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ONLINE_BOOKING_UNAVAILABLE');
      expect(res.body.error.message).not.toMatch(/block/i);
    });

    it.each([
      ['an off-grid time', () => at(day(3), '10:07')],
      ['a time outside business hours', () => at(day(3), '20:00')],
      ['a time in the past', () => '2020-01-06T10:00:00+08:00'],
    ])('refuses %s', async (_label, startsAt) => {
      const res = await book({ employeeId: e1, startsAt: startsAt() });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('refuses a slot that is already taken, and never creates a customer for it', async () => {
      const first = await book({ employeeId: e1, startsAt: at(day(3), '12:00') });
      expect(first.status).toBe(201);

      const phone = '+97677009900';
      const clash = await book({ employeeId: e1, startsAt: at(day(3), '12:30'), customer: customer({ phone }) });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SLOT_UNAVAILABLE');
      expect(await harness.prisma.companyCustomer.count({ where: { phone } })).toBe(0);
    });

    it('lets exactly one of several simultaneous bookings for one slot succeed', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          book({
            employeeId: e2,
            startsAt: at(day(4), '10:00'),
            customer: customer({ phone: `+9767700${1000 + i}`, email: undefined }),
          }),
        ),
      );
      expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of attempts.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(409);
        expect(['SLOT_TAKEN', 'SLOT_UNAVAILABLE']).toContain(r.body.error.code);
      }
    });

    it.each([
      ['an internal-only service', () => ({ serviceId: internal, employeeId: e1 })],
      ['a draft service', () => ({ serviceId: draft, employeeId: e1 })],
      ['a service not offered at the branch', () => ({ serviceId: notOffered })],
      ['a non-bookable employee', () => ({ employeeId: notBookable })],
      ['another company’s service', () => ({ serviceId: bService })],
      ['another company’s employee', () => ({ employeeId: bEmployee })],
      ['another company’s branch', () => ({ branchId: world.companyB.branchId })],
      ['a branch not taking online bookings', () => ({ branchId: closedBranch, employeeId: e1 })],
    ])('404s a booking for %s, creating nothing', async (_label, override) => {
      const phone = `+9766${String(Date.now()).slice(-7)}`;
      const res = await book({
        startsAt: at(day(5), '10:00'),
        customer: customer({ phone }),
        ...override(),
      });
      expect(res.status).toBe(404);
      expect(await harness.prisma.companyCustomer.count({ where: { phone } })).toBe(0);
    });

    it('cannot book company A’s service through company B’s page', async () => {
      const res = await book({ startsAt: at(day(5), '11:00') }, 'company-b');
      expect(res.status).toBe(404);
    });

    it.each([
      ['no phone', { customer: { firstName: 'X' } }],
      ['a bad email', { customer: { firstName: 'X', phone: '+97699887766', email: 'nope' } }],
      ['an empty name', { customer: { firstName: ' ', phone: '+97699887766' } }],
      ['a smuggled customerId', { customerId: '018f0000-0000-7000-8000-000000000001' }],
      ['a smuggled resourceId', { resourceId: '018f0000-0000-7000-8000-000000000001' }],
      ['a time without an offset', { startsAt: '2026-12-01T10:00:00' }],
    ])('rejects %s with 400', async (_label, override) => {
      const res = await book({ employeeId: e1, startsAt: at(day(6), '10:00'), ...override });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

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
    extra: { isBookable?: boolean } = {},
  ): Promise<string> {
    const { prisma } = harness;
    const employee = await prisma.employee.create({
      data: { companyId, displayName: name, status: 'ACTIVE', isBookable: extra.isBookable ?? true },
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
});

function isoDaysAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
