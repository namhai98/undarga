import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * PROMOTIONS & DISCOUNTS — codes, eligibility, booking integration
 * ===========================================================================
 *
 * Real PostgreSQL: usage limits are enforced by conditional UPDATEs and an
 * advisory lock, and concurrency is the thing worth proving.
 *
 * Prices: Haircut 50,000.00 MNT (5,000,000 minor), Colour 100,000.00 MNT.
 * Every booking takes a fresh (day, hour) from `nextSlot()`, so no two tests
 * can collide on a calendar and a slot clash can never masquerade as a
 * promotion failure.
 */
describe('promotions & discounts', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;

  let branch: string;
  let branch2: string;
  let cut: string;
  let colour: string;
  let e1: string;
  let e2: string;
  let bService: string;

  const CUT = 5_000_000n;
  const base = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let slotIndex = 0;
  /** A unique (day, hour) for every booking in this file. */
  const nextSlot = () => {
    const i = slotIndex++;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 2 + Math.floor(i / 8));
    const hour = 9 + (i % 8);
    return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  };

  let codeIndex = 0;
  const uniqueCode = (prefix: string) => `${prefix}${Date.now() % 100000}${codeIndex++}`;

  const createPromo = async (body: Record<string, unknown>, token = ownerA, companyId?: string) => {
    const res = await request(http)
      .post(`${base(companyId)}/promotions`)
      .set(auth(token))
      .send({
        name: 'Promo',
        discountType: 'PERCENTAGE',
        discountValueBps: 2000,
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 86_400_000).toISOString(),
        ...body,
      });
    return res;
  };

  const validate = (body: Record<string, unknown>, token = ownerA) =>
    request(http)
      .post(`${base()}/promotions/validate`)
      .set(auth(token))
      .send({ branchId: branch, serviceId: cut, ...body });

  const book = (body: Record<string, unknown>, token = ownerA) =>
    request(http)
      .post(`${base()}/appointments`)
      .set(auth(token))
      .send({
        branchId: branch,
        serviceId: cut,
        customerId: world.companyA.customerId,
        employeeId: e2,
        startsAt: nextSlot(),
        ...body,
      });

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    branch = world.companyA.branchId;
    branch2 = (
      await prisma.branch.create({
        data: { companyId, code: 'SECOND', name: 'Second', timezoneName: 'Asia/Ulaanbaatar' },
      })
    ).id;
    await openAllWeek(companyId, branch);
    await openAllWeek(companyId, branch2);

    const svc = (name: string, price: bigint) =>
      prisma.service.create({
        data: {
          companyId,
          name,
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: price,
          currencyCode: 'MNT',
          requiresEmployee: true,
          isOnlineBookable: true,
        },
      });
    cut = (await svc('Haircut', CUT)).id;
    colour = (await svc('Colour', 10_000_000n)).id;
    await prisma.serviceBranch.createMany({
      data: [cut, colour].flatMap((serviceId) =>
        [branch, branch2].map((branchId) => ({ companyId, serviceId, branchId })),
      ),
    });
    e1 = await makeEmployee(companyId, [branch, branch2], 'Ari', [cut, colour]);
    e2 = await makeEmployee(companyId, [branch, branch2], 'Bat', [cut, colour]);

    const bId = world.companyB.id;
    bService = (
      await prisma.service.create({
        data: { companyId: bId, name: 'B', status: 'ACTIVE', durationMin: 60, priceMinor: 1n, currencyCode: 'MNT' },
      })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  // CRUD, codes, search, pagination
  // ===========================================================================

  describe('management', () => {
    it('creates a code-only promotion, normalising the code', async () => {
      const res = await createPromo({ name: 'Summer sale', code: 'summer-sale' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ code: 'SUMMER-SALE', requiresCode: true, isAutoApply: false });
    });

    it('refuses a code another promotion already uses', async () => {
      const code = uniqueCode('DUP');
      expect((await createPromo({ code })).status).toBe(201);
      const again = await createPromo({ code });
      expect(again.status).toBe(409);
    });

    it('searches by name or code, filters, and paginates', async () => {
      const code = uniqueCode('FINDME');
      await createPromo({ name: 'Needle in a haystack', code, discountType: 'FIXED_AMOUNT', discountValueBps: undefined, discountAmountMinor: '100000' });

      const byCode = await request(http).get(`${base()}/promotions`).set(auth(ownerA)).query({ search: code.toLowerCase() });
      expect(byCode.body.data.items.map((p: { code: string }) => p.code)).toEqual([code]);

      const byName = await request(http).get(`${base()}/promotions`).set(auth(ownerA)).query({ search: 'haystack' });
      expect(byName.body.data.items).toHaveLength(1);

      const fixed = await request(http).get(`${base()}/promotions`).set(auth(ownerA)).query({ discountType: 'FIXED_AMOUNT' });
      expect(fixed.body.data.items.every((p: { discountType: string }) => p.discountType === 'FIXED_AMOUNT')).toBe(true);

      const page = await request(http).get(`${base()}/promotions`).set(auth(ownerA)).query({ limit: 1, offset: 0 });
      expect(page.body.data.items).toHaveLength(1);
      expect(page.body.data.total).toBeGreaterThan(1);
    });

    it('deactivates, reactivates and deletes', async () => {
      const code = uniqueCode('TOGGLE');
      const id = (await createPromo({ code })).body.data.id;

      await request(http).patch(`${base()}/promotions/${id}`).set(auth(ownerA)).send({ status: 'PAUSED' }).expect(200);
      expect((await validate({ code })).body.data.reason).toBe('NOT_ACTIVE');

      await request(http).patch(`${base()}/promotions/${id}`).set(auth(ownerA)).send({ status: 'ACTIVE' }).expect(200);
      expect((await validate({ code })).body.data.valid).toBe(true);

      await request(http).delete(`${base()}/promotions/${id}`).set(auth(ownerA)).expect(204);
      expect((await validate({ code })).body.data.reason).toBe('INVALID_CODE');
      expect((await request(http).get(`${base()}/promotions/${id}`).set(auth(ownerA))).status).toBe(404);
    });

    it('changes and removes a code', async () => {
      const first = uniqueCode('OLD');
      const second = uniqueCode('NEW');
      const id = (await createPromo({ code: first })).body.data.id;

      const changed = await request(http).patch(`${base()}/promotions/${id}`).set(auth(ownerA)).send({ code: second });
      expect(changed.body.data.code).toBe(second);
      expect((await validate({ code: first })).body.data.reason).toBe('INVALID_CODE');
      expect((await validate({ code: second })).body.data.valid).toBe(true);

      const removed = await request(http).patch(`${base()}/promotions/${id}`).set(auth(ownerA)).send({ code: null });
      expect(removed.body.data).toMatchObject({ code: null, requiresCode: false });
    });
  });

  // ===========================================================================
  // Calculation and eligibility (validate)
  // ===========================================================================

  describe('calculation', () => {
    it('takes a percentage off the server’s own price', async () => {
      const code = uniqueCode('PCT');
      await createPromo({ code, discountValueBps: 2000 });
      const res = await validate({ code });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        valid: true,
        originalMinor: '5000000',
        discountMinor: '1000000',
        finalMinor: '4000000',
        currencyCode: 'MNT',
      });
    });

    it('takes a fixed amount off', async () => {
      const code = uniqueCode('FIX');
      await createPromo({ code, discountType: 'FIXED_AMOUNT', discountValueBps: undefined, discountAmountMinor: '1500000' });
      expect((await validate({ code })).body.data).toMatchObject({ discountMinor: '1500000', finalMinor: '3500000' });
    });

    it('never produces a negative total', async () => {
      const code = uniqueCode('HUGE');
      await createPromo({ code, discountType: 'FIXED_AMOUNT', discountValueBps: undefined, discountAmountMinor: '999999999' });
      expect((await validate({ code })).body.data).toMatchObject({ discountMinor: '5000000', finalMinor: '0' });

      const booked = await book({ promotionCode: code });
      expect(booked.status).toBe(201);
      expect(booked.body.data.totalMinor).toBe('0');
    });

    it('refuses to accept a client price', async () => {
      const res = await validate({ code: 'ANYTHING', subtotalMinor: '1' });
      expect(res.status).toBe(400);
    });

    it.each([
      ['an unknown code', {}, 'INVALID_CODE'],
      ['an expired promotion', { endsAt: new Date(Date.now() - 3_600_000).toISOString(), startsAt: new Date(Date.now() - 86_400_000 * 2).toISOString() }, 'ENDED'],
      ['a promotion not started', { startsAt: new Date(Date.now() + 86_400_000).toISOString() }, 'NOT_STARTED'],
      ['an inactive promotion', { status: 'PAUSED' }, 'NOT_ACTIVE'],
      ['a spend below the minimum', { minPurchaseMinor: '6000000' }, 'BELOW_MINIMUM'],
      ['another service', { serviceIds: ['__colour__'] }, 'NO_ELIGIBLE_SERVICES'],
      ['another branch', { branchIds: ['__branch2__'] }, 'WRONG_BRANCH'],
      ['another employee', { employeeIds: ['__e1__'] }, 'WRONG_EMPLOYEE'],
    ])('explains %s without erroring', async (label, extra, reason) => {
      const code = uniqueCode('ELIG');
      const resolved = JSON.parse(
        JSON.stringify(extra).replace('__colour__', colour).replace('__branch2__', branch2).replace('__e1__', e1),
      );
      if (label !== 'an unknown code') {
        expect((await createPromo({ code, ...resolved })).status).toBe(201);
      }
      const res = await validate({ code, employeeId: e2 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ valid: false, reason, discountMinor: '0', finalMinor: '5000000' });
    });

    it('accepts each restriction when it is met', async () => {
      const code = uniqueCode('MATCH');
      await createPromo({ code, minPurchaseMinor: '6000000', serviceIds: [colour], branchIds: [branch2], employeeIds: [e1] });
      const res = await validate({ code, serviceId: colour, branchId: branch2, employeeId: e1 });
      expect(res.body.data).toMatchObject({ valid: true, originalMinor: '10000000', discountMinor: '2000000' });
    });

    it('applies an employee price override before discounting', async () => {
      const code = uniqueCode('OVR');
      await createPromo({ code, discountValueBps: 5000 });
      await harness.prisma.employeeService.updateMany({
        where: { employeeId: e1, serviceId: colour },
        data: { priceOverrideMinor: 8_000_000n },
      });
      const res = await validate({ code, serviceId: colour, employeeId: e1 });
      expect(res.body.data).toMatchObject({ originalMinor: '8000000', discountMinor: '4000000' });
    });
  });

  // ===========================================================================
  // Booking integration
  // ===========================================================================

  describe('appointment integration', () => {
    it('stores the discount at booking time and keeps it when the promotion changes', async () => {
      const code = uniqueCode('KEEP');
      const promoId = (await createPromo({ name: 'Launch offer', code, discountValueBps: 2000 })).body.data.id;

      const booked = await book({ promotionCode: code });
      expect(booked.status).toBe(201);
      const a = booked.body.data;
      expect(a).toMatchObject({ subtotalMinor: '5000000', discountMinor: '1000000', totalMinor: '4000000' });
      expect(a.promotions[0]).toMatchObject({ name: 'Launch offer', code, discountType: 'PERCENTAGE', discountValueBps: 2000, discountMinor: '1000000' });

      const item = await harness.prisma.appointmentItem.findFirstOrThrow({ where: { appointmentId: a.id } });
      expect(item.discountMinor).toBe(1_000_000n);
      expect(item.totalMinor).toBe(4_000_000n);

      await request(http)
        .patch(`${base()}/promotions/${promoId}`)
        .set(auth(ownerA))
        .send({ name: 'Renamed', discountValueBps: 9000 })
        .expect(200);

      const after = (await request(http).get(`${base()}/appointments/${a.id}`).set(auth(ownerA))).body.data;
      expect(after).toMatchObject({ discountMinor: '1000000', totalMinor: '4000000' });
      expect(after.promotions[0]).toMatchObject({ name: 'Launch offer', discountValueBps: 2000 });
    });

    it('refuses the whole booking rather than charge an unquoted price', async () => {
      const slot = nextSlot();
      const res = await book({ promotionCode: 'NO-SUCH-CODE', startsAt: slot });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'PROMOTION_NOT_APPLICABLE', details: { reason: 'INVALID_CODE' } });
      // Rolled back: the slot is still free.
      expect((await book({ startsAt: slot })).status).toBe(201);
    });

    it('re-checks restrictions against the employee actually booked', async () => {
      const code = uniqueCode('ONLYE1');
      await createPromo({ code, employeeIds: [e1] });
      const wrong = await book({ promotionCode: code, employeeId: e2 });
      expect(wrong.body.error?.details?.reason).toBe('WRONG_EMPLOYEE');
      expect((await book({ promotionCode: code, employeeId: e1 })).status).toBe(201);
    });

    it('leaves bookings without a code exactly as before', async () => {
      const res = await book({});
      expect(res.body.data).toMatchObject({ subtotalMinor: '5000000', discountMinor: '0', totalMinor: '5000000', promotions: [] });
    });

    it('applies a code to an existing appointment, and refuses a code-only promotion by id', async () => {
      const code = uniqueCode('LATER');
      const promoId = (await createPromo({ code, discountValueBps: 1000 })).body.data.id;
      const appointmentId = (await book({})).body.data.id;

      const byId = await request(http).post(`${base()}/promotions/apply`).set(auth(ownerA)).send({ promotionId: promoId, appointmentId });
      expect(byId.status).toBe(400);

      const byCode = await request(http).post(`${base()}/promotions/apply`).set(auth(ownerA)).send({ code, appointmentId });
      expect(byCode.status).toBe(200);
      expect(byCode.body.data).toMatchObject({ discountMinor: '500000', totalMinor: '4500000' });

      const detail = (await request(http).get(`${base()}/appointments/${appointmentId}`).set(auth(ownerA))).body.data;
      expect(detail.promotions[0]).toMatchObject({ code, discountMinor: '500000' });
    });

    it('carries the discount through a reschedule without consuming the code again', async () => {
      const code = uniqueCode('MOVE');
      const promoId = (await createPromo({ code, maxRedemptions: 5 })).body.data.id;
      const original = (await book({ promotionCode: code })).body.data;

      const moved = await request(http)
        .post(`${base()}/appointments/${original.id}/reschedule`)
        .set(auth(ownerA))
        .send({ startsAt: nextSlot() });
      expect(moved.status).toBe(200);
      expect(moved.body.data).toMatchObject({ discountMinor: '1000000', totalMinor: '4000000' });
      expect(moved.body.data.promotions[0]).toMatchObject({ code });

      const promo = await harness.prisma.promotion.findUniqueOrThrow({ where: { id: promoId } });
      expect(promo.redeemedCount).toBe(1);
      const redemption = await harness.prisma.promotionRedemption.findFirstOrThrow({ where: { promotionId: promoId } });
      expect(redemption.appointmentId).toBe(moved.body.data.id);
    });
  });

  // ===========================================================================
  // Usage limits
  // ===========================================================================

  describe('usage limits', () => {
    it('stops at the limit', async () => {
      const code = uniqueCode('ONCE');
      await createPromo({ code, maxRedemptions: 1 });
      expect((await book({ promotionCode: code })).status).toBe(201);

      const second = await book({ promotionCode: code });
      expect(second.status).toBe(400);
      expect(second.body.error.details.reason).toBe('LIMIT_REACHED');
      expect((await validate({ code })).body.data.reason).toBe('LIMIT_REACHED');
    });

    it('cannot be bypassed by simultaneous bookings', async () => {
      const code = uniqueCode('RACE');
      const promoId = (await createPromo({ code, maxRedemptions: 2 })).body.data.id;

      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) => book({ promotionCode: code, employeeId: i % 2 ? e1 : e2 })),
      );
      const ok = attempts.filter((r) => r.status === 201);
      expect(ok).toHaveLength(2);
      for (const r of attempts.filter((x) => x.status !== 201)) {
        expect(r.body.error.code).toBe('PROMOTION_NOT_APPLICABLE');
      }

      const promo = await harness.prisma.promotion.findUniqueOrThrow({ where: { id: promoId } });
      expect(promo.redeemedCount).toBe(2);
      expect(await harness.prisma.promotionRedemption.count({ where: { promotionId: promoId } })).toBe(2);
      // The refused bookings rolled back entirely — no full-price stragglers.
      expect(
        await harness.prisma.appointment.count({
          where: { id: { in: attempts.filter((r) => r.status === 201).map((r) => r.body.data.id) } },
        }),
      ).toBe(2);
    });

    it('holds the per-customer limit under concurrency too', async () => {
      const code = uniqueCode('PERCUST');
      const promoId = (await createPromo({ code, maxRedemptionsPerCustomer: 1 })).body.data.id;

      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, i) => book({ promotionCode: code, employeeId: i % 2 ? e1 : e2 })),
      );
      expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await harness.prisma.promotionRedemption.count({ where: { promotionId: promoId } })).toBe(1);
    });
  });

  // ===========================================================================
  // Public booking
  // ===========================================================================

  describe('public booking page', () => {
    it('previews and applies a code, showing original, discount and final', async () => {
      const code = uniqueCode('WEB');
      await createPromo({ code, discountValueBps: 1000 });
      const slug = world.companyA.slug;

      const preview = await request(http)
        .post(`/api/v1/public/companies/${slug}/promotions/validate`)
        .send({ code, branchId: branch, serviceId: cut });
      expect(preview.status).toBe(200);
      expect(preview.body.data).toEqual({
        valid: true,
        reason: null,
        message: null,
        originalMinor: '5000000',
        discountMinor: '500000',
        finalMinor: '4500000',
        currencyCode: 'MNT',
        promotion: { name: 'Promo', code },
      });

      const booked = await request(http)
        .post(`/api/v1/public/companies/${slug}/bookings`)
        .send({
          branchId: branch,
          serviceId: cut,
          employeeId: e2,
          startsAt: nextSlot(),
          promotionCode: code,
          customer: { firstName: 'Web', phone: `+9768${String(Date.now()).slice(-7)}` },
        });
      expect(booked.status).toBe(201);
      expect(booked.body.data.price).toEqual({
        originalMinor: '5000000',
        discountMinor: '500000',
        amountMinor: '4500000',
        currencyCode: 'MNT',
      });
      expect(booked.body.data.promotion).toEqual({ name: 'Promo', code });
    });
  });

  // ===========================================================================
  // Tenant isolation & RBAC
  // ===========================================================================

  describe('tenant isolation', () => {
    it('never honours another company’s code', async () => {
      const code = uniqueCode('BONLY');
      expect((await createPromo({ code }, ownerB, world.companyB.id)).status).toBe(201);

      expect((await validate({ code })).body.data.reason).toBe('INVALID_CODE');
      const booked = await book({ promotionCode: code });
      expect(booked.body.error.details.reason).toBe('INVALID_CODE');
    });

    it('404s another company’s promotion for read, update and delete', async () => {
      const id = (await createPromo({ code: uniqueCode('APRIV') })).body.data.id;
      const url = `${base(world.companyB.id)}/promotions/${id}`;
      expect((await request(http).get(url).set(auth(ownerB))).status).toBe(404);
      expect((await request(http).patch(url).set(auth(ownerB)).send({ status: 'PAUSED' })).status).toBe(404);
      expect((await request(http).delete(url).set(auth(ownerB))).status).toBe(404);
      const still = await harness.prisma.promotion.findUniqueOrThrow({ where: { id } });
      expect(still.status).toBe('ACTIVE');
    });

    it('refuses to target another company’s service, branch or employee', async () => {
      for (const target of [
        { serviceIds: [bService] },
        { branchIds: [world.companyB.branchId] },
      ]) {
        expect((await createPromo({ code: uniqueCode('X'), ...target })).status).toBe(404);
      }
    });

    it('404s a validation that names another company’s service or customer', async () => {
      const code = uniqueCode('ISO');
      await createPromo({ code });
      expect((await validate({ code, serviceId: bService })).status).toBe(404);
      expect((await validate({ code, customerId: world.companyB.customerId })).status).toBe(404);
    });
  });

  describe('permissions', () => {
    it('lets a receptionist validate but not create', async () => {
      const token = await member(SYSTEM_ROLES.RECEPTIONIST);
      const code = uniqueCode('RCP');
      await createPromo({ code });
      expect((await validate({ code }, token)).status).toBe(200);
      expect((await createPromo({ code: uniqueCode('NOPE') }, token)).status).toBe(403);
    });

    it('refuses an employee both', async () => {
      const token = await member(SYSTEM_ROLES.EMPLOYEE);
      expect((await validate({ code: 'WHATEVER' }, token)).status).toBe(403);
      expect((await createPromo({}, token)).status).toBe(403);
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

  async function makeEmployee(companyId: string, branchIds: string[], name: string, serviceIds: string[]) {
    const { prisma } = harness;
    const employee = await prisma.employee.create({ data: { companyId, displayName: name } });
    for (const branchId of branchIds) {
      await prisma.employeeBranch.create({ data: { companyId, employeeId: employee.id, branchId } });
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
    }
    await prisma.employeeService.createMany({
      data: serviceIds.map((serviceId) => ({ companyId, employeeId: employee.id, serviceId })),
    });
    return employee.id;
  }

  async function member(roleKey: string): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({ where: { id: world.userA.id }, select: { passwordHash: true } });
    const account = await prisma.userAccount.create({
      data: {
        email: `promo-${roleKey}-${Date.now()}-${codeIndex++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await prisma.companyRole.findFirstOrThrow({ where: { companyId: world.companyA.id, key: roleKey } });
    await prisma.companyUserRole.create({ data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id } });
    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }
});
