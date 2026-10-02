import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * DASHBOARD & REPORTS
 * ===========================================================================
 *
 * One small, fully known week — 3–7 March 2025 in Asia/Ulaanbaatar (UTC+8) —
 * so every figure can be asserted EXACTLY rather than as "at least". The
 * fixtures are written straight to the database so no business rule stands
 * between the test and the numbers it expects.
 *
 *   #   local time         branch  service  employee  status      total  customer
 *   A1  03-03 10:00        main    Haircut  Ari       COMPLETED   40000  c1
 *   A2  03-04 07:00 (*)    main    Massage  Bat       CANCELLED   50000  c2
 *   A3  03-04 11:00        North   Haircut  Ari       NO_SHOW     40000  c2
 *   A4  03-05 12:00        North   Massage  Bat       CONFIRMED   90000  c4
 *   A5  03-05 13:00        main    Haircut  Bat       COMPLETED   40000  c1
 *   A6  03-08 10:00        main    Haircut  Ari       COMPLETED   40000  c1   (outside the range)
 *   A7  03-05 15:00        main    Haircut  Ari       HOLD        40000  c1   (never counted)
 *
 *   (*) 03-03 23:00 UTC. Bucketing by UTC would put it on the 3rd; the
 *       company's day is the 4th.
 *
 * Customers: c1 created 2025-02-01; c2 03-03; c3 03-04 (never books); c4 03-05.
 */
describe('dashboard and reports', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let owner: string;
  let ownerB: string;

  let main: string;
  let north: string;
  let haircut: string;
  let massage: string;
  let ari: string;
  let bat: string;
  let c1: string;
  let c2: string;
  let c4: string;
  const appt: Record<string, string> = {};
  let promo: string;

  let unique = 0;
  const RANGE = 'from=2025-03-03&to=2025-03-07';

  const api = (path: string, companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/${path}`;
  const get = (path: string, token = owner) =>
    request(http).get(path).set('Authorization', `Bearer ${token}`);
  const report = async (name: string, query = '', token = owner) => {
    const res = await get(api(`reports/${name}?${RANGE}${query}`), token);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  /** A local wall-clock time in Ulaanbaatar as an instant. */
  const ub = (local: string) => new Date(`${local}+08:00`);

  async function appointment(
    key: string,
    o: {
      at: string;
      branchId: string;
      serviceId: string;
      employeeId: string;
      status: 'COMPLETED' | 'CANCELLED' | 'NO_SHOW' | 'CONFIRMED' | 'HOLD';
      total: bigint;
      customerId: string;
      companyId?: string;
    },
  ) {
    const companyId = o.companyId ?? world.companyA.id;
    const startsAt = ub(o.at);
    const endsAt = new Date(startsAt.getTime() + 3_600_000);
    const row = await harness.prisma.appointment.create({
      data: {
        companyId,
        branchId: o.branchId,
        customerId: o.customerId,
        appointmentNumber: `RPT-${unique++}`,
        status: o.status,
        paymentStatus: 'UNPAID',
        source: 'STAFF',
        startsAt,
        endsAt,
        bookedTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        subtotalMinor: o.total,
        totalMinor: o.total,
        ...(o.status === 'HOLD' ? { holdExpiresAt: new Date(Date.now() + 600_000) } : {}),
      },
    });
    await harness.prisma.appointmentItem.create({
      data: {
        companyId,
        appointmentId: row.id,
        branchId: o.branchId,
        serviceId: o.serviceId,
        employeeId: o.employeeId,
        status: o.status,
        startsAt,
        endsAt,
        durationMin: 60,
        unitPriceMinor: o.total,
        totalMinor: o.total,
        snapshot: {},
      },
    });
    appt[key] = row.id;
    return row.id;
  }

  async function customer(firstName: string, createdAt: string, companyId = world.companyA.id) {
    const row = await harness.prisma.companyCustomer.create({
      data: {
        companyId,
        firstName,
        lastName: 'Secret',
        email: `${firstName.toLowerCase()}@private.test`,
        phone: `+9768${String(unique++).padStart(7, '0')}`,
        createdAt: ub(createdAt),
      },
    });
    return row.id;
  }

  async function member(roleKey: string, branchScope: string[] = []): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `rpt-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
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
    for (const branchId of branchScope) {
      await prisma.companyUserBranch.create({
        data: { companyId: world.companyA.id, companyUserId: membership.id, branchId },
      });
    }
    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    owner = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    const { prisma } = harness;
    const companyId = world.companyA.id;
    main = world.companyA.branchId;
    north = (
      await prisma.branch.create({
        data: { companyId, code: 'NORTH', name: 'North', timezoneName: 'Asia/Ulaanbaatar' },
      })
    ).id;
    const service = (name: string) =>
      prisma.service.create({
        data: { companyId, name, durationMin: 60, priceMinor: 40_000n, currencyCode: 'MNT' },
      });
    haircut = (await service('Haircut')).id;
    massage = (await service('Massage')).id;
    ari = (await prisma.employee.create({ data: { companyId, displayName: 'Ari' } })).id;
    bat = (await prisma.employee.create({ data: { companyId, displayName: 'Bat' } })).id;

    c1 = await customer('Alpha', '2025-02-01T09:00:00');
    c2 = await customer('Bravo', '2025-03-03T09:00:00');
    await customer('Charlie', '2025-03-04T09:00:00');
    c4 = await customer('Delta', '2025-03-05T09:00:00');

    const base = { customerId: c1 };
    await appointment('A1', {
      ...base,
      at: '2025-03-03T10:00:00',
      branchId: main,
      serviceId: haircut,
      employeeId: ari,
      status: 'COMPLETED',
      total: 40_000n,
    });
    await appointment('A2', {
      at: '2025-03-04T07:00:00',
      branchId: main,
      serviceId: massage,
      employeeId: bat,
      status: 'CANCELLED',
      total: 50_000n,
      customerId: c2,
    });
    await appointment('A3', {
      at: '2025-03-04T11:00:00',
      branchId: north,
      serviceId: haircut,
      employeeId: ari,
      status: 'NO_SHOW',
      total: 40_000n,
      customerId: c2,
    });
    await appointment('A4', {
      at: '2025-03-05T12:00:00',
      branchId: north,
      serviceId: massage,
      employeeId: bat,
      status: 'CONFIRMED',
      total: 90_000n,
      customerId: c4,
    });
    await appointment('A5', {
      ...base,
      at: '2025-03-05T13:00:00',
      branchId: main,
      serviceId: haircut,
      employeeId: bat,
      status: 'COMPLETED',
      total: 40_000n,
    });
    await appointment('A6', {
      ...base,
      at: '2025-03-08T10:00:00',
      branchId: main,
      serviceId: haircut,
      employeeId: ari,
      status: 'COMPLETED',
      total: 40_000n,
    });
    await appointment('A7', {
      ...base,
      at: '2025-03-05T15:00:00',
      branchId: main,
      serviceId: haircut,
      employeeId: ari,
      status: 'HOLD',
      total: 40_000n,
    });

    // Company B, same week: must never appear in A's figures.
    const bService = await prisma.service.create({
      data: {
        companyId: world.companyB.id,
        name: 'B cut',
        durationMin: 60,
        priceMinor: 1n,
        currencyCode: 'MNT',
      },
    });
    const bEmployee = await prisma.employee.create({
      data: { companyId: world.companyB.id, displayName: 'B person' },
    });
    await appointment('B1', {
      companyId: world.companyB.id,
      at: '2025-03-05T10:00:00',
      branchId: world.companyB.branchId,
      serviceId: bService.id,
      employeeId: bEmployee.id,
      status: 'COMPLETED',
      total: 999_000n,
      customerId: world.companyB.customerId,
    });

    // One promotion, redeemed on A1 (main) and A4 (North).
    promo = (
      await prisma.promotion.create({
        data: {
          companyId,
          name: 'Spring 10%',
          discountType: 'PERCENTAGE',
          discountValueBps: 1000,
          currencyCode: 'MNT',
          status: 'ACTIVE',
          startsAt: ub('2025-01-01T00:00:00'),
          maxRedemptions: 100,
          redeemedCount: 2,
        },
      })
    ).id;
    await prisma.promotionRedemption.createMany({
      data: [
        {
          companyId,
          promotionId: promo,
          appointmentId: appt.A1!,
          customerId: c1,
          discountMinor: 4_000n,
          redeemedAt: ub('2025-03-03T10:05:00'),
        },
        {
          companyId,
          promotionId: promo,
          appointmentId: appt.A4!,
          customerId: c4,
          discountMinor: 9_000n,
          redeemedAt: ub('2025-03-05T12:05:00'),
        },
      ],
    });

    // Gift cards: two issued in the range (one already expired), one before it
    // and disabled. Redemptions on A1 (main) and A4 (North), and a refund on A1.
    const card = (
      last4: string,
      o: { issued: string; status: 'ACTIVE' | 'DISABLED'; balance: bigint; expires?: string },
    ) =>
      prisma.giftCard.create({
        data: {
          companyId,
          codeHash: `rpt-${last4}-${unique++}`,
          codeLast4: last4,
          status: o.status,
          initialBalanceMinor: 100_000n,
          currentBalanceMinor: o.balance,
          currencyCode: 'MNT',
          issuedAt: ub(o.issued),
          expiresAt: o.expires ? ub(o.expires) : null,
        },
      });
    const g1 = await card('AAAA', {
      issued: '2025-03-03T09:00:00',
      status: 'ACTIVE',
      balance: 75_000n,
    });
    await card('BBBB', {
      issued: '2025-03-04T09:00:00',
      status: 'ACTIVE',
      balance: 60_000n,
      expires: '2025-03-06T00:00:00',
    });
    await card('CCCC', { issued: '2025-02-01T09:00:00', status: 'DISABLED', balance: 30_000n });
    await prisma.giftCardTransaction.createMany({
      data: [
        {
          companyId,
          giftCardId: g1.id,
          type: 'REDEEM',
          amountMinor: -10_000n,
          balanceAfterMinor: 90_000n,
          currencyCode: 'MNT',
          appointmentId: appt.A1!,
          performedByType: 'COMPANY_USER',
          occurredAt: ub('2025-03-03T11:00:00'),
        },
        {
          companyId,
          giftCardId: g1.id,
          type: 'REFUND',
          amountMinor: 5_000n,
          balanceAfterMinor: 95_000n,
          currencyCode: 'MNT',
          appointmentId: appt.A1!,
          performedByType: 'COMPANY_USER',
          occurredAt: ub('2025-03-03T12:00:00'),
        },
        {
          companyId,
          giftCardId: g1.id,
          type: 'REDEEM',
          amountMinor: -20_000n,
          balanceAfterMinor: 75_000n,
          currencyCode: 'MNT',
          appointmentId: appt.A4!,
          performedByType: 'COMPANY_USER',
          occurredAt: ub('2025-03-05T12:30:00'),
        },
      ],
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('appointments report', () => {
    it('totals, rates and booked value for the range', async () => {
      const data = await report('appointments');
      expect(data.range).toEqual({
        from: '2025-03-03',
        to: '2025-03-07',
        timezone: 'Asia/Ulaanbaatar',
      });
      expect(data.totals).toMatchObject({
        total: 5,
        confirmed: 1,
        completed: 2,
        cancelled: 1,
        noShow: 1,
        completionRateBps: 4000,
        cancellationRateBps: 2000,
        noShowRateBps: 2000,
        // Not cancelled: 40k + 40k + 90k + 40k. HOLD and out-of-range excluded.
        bookedValueMinor: '210000',
      });
      expect(data.amountsVisible).toBe(true);
    });

    it('buckets days in the company’s timezone and zero-fills the range', async () => {
      const data = await report('appointments');
      expect(data.byDay).toEqual([
        { date: '2025-03-03', total: 1, completed: 1, cancelled: 0, noShow: 0, other: 0 },
        // A2 starts at 23:00 UTC on the 3rd — the 4th in Ulaanbaatar.
        { date: '2025-03-04', total: 2, completed: 0, cancelled: 1, noShow: 1, other: 0 },
        { date: '2025-03-05', total: 2, completed: 1, cancelled: 0, noShow: 0, other: 1 },
        { date: '2025-03-06', total: 0, completed: 0, cancelled: 0, noShow: 0, other: 0 },
        { date: '2025-03-07', total: 0, completed: 0, cancelled: 0, noShow: 0, other: 0 },
      ]);
    });

    it('breaks down by service, employee and branch with names', async () => {
      const data = await report('appointments');
      const pick = (rows: Array<{ name: string; bookings: number }>) =>
        Object.fromEntries(rows.map((r) => [r.name, r.bookings]));
      expect(pick(data.byService.items)).toEqual({ Haircut: 3, Massage: 2 });
      expect(pick(data.byEmployee.items)).toEqual({ Bat: 3, Ari: 2 });
      expect(pick(data.byBranch.items)).toEqual({ 'Company A main branch': 3, North: 2 });
      expect(data.byService.items[0]).toMatchObject({
        name: 'Haircut',
        completed: 2,
        noShow: 1,
        cancelled: 0,
        bookedValueMinor: '120000',
      });
      expect(data.byService.total).toBe(2);
    });

    it('filters by date', async () => {
      const res = await get(api('reports/appointments?from=2025-03-04&to=2025-03-04')).expect(200);
      expect(res.body.data.totals.total).toBe(2);
      expect(res.body.data.byDay).toHaveLength(1);
    });

    it('filters by branch, employee, service and status — alone and together', async () => {
      expect((await report('appointments', `&branchId=${north}`)).totals.total).toBe(2);
      expect((await report('appointments', `&employeeId=${bat}`)).totals.total).toBe(3);
      expect((await report('appointments', `&serviceId=${massage}`)).totals.total).toBe(2);
      expect((await report('appointments', '&status=COMPLETED')).totals).toMatchObject({
        total: 2,
        completed: 2,
      });
      expect((await report('appointments', '&status=CANCELLED,NO_SHOW')).totals.total).toBe(2);
      const both = await report('appointments', `&branchId=${main}&employeeId=${bat}`);
      expect(both.totals.total).toBe(2); // A2, A5
      expect(both.byEmployee.items.map((r: { name: string }) => r.name)).toEqual(['Bat']);
      expect(both.filters).toMatchObject({ branchIds: [main], employeeId: bat });
    });

    it('pages the breakdowns', async () => {
      const first = await report('appointments', '&limit=1');
      expect(first.byService).toMatchObject({ total: 2, limit: 1, offset: 0 });
      expect(first.byService.items.map((r: { name: string }) => r.name)).toEqual(['Haircut']);
      const second = await report('appointments', '&limit=1&offset=1');
      expect(second.byService.items.map((r: { name: string }) => r.name)).toEqual(['Massage']);
    });

    it('rejects bad filters', async () => {
      await get(api(`reports/appointments?${RANGE}&status=HOLD`)).expect(400);
      await get(api(`reports/appointments?${RANGE}&status=nope`)).expect(400);
      await get(api(`reports/appointments?${RANGE}&limit=500`)).expect(400);
      await get(api('reports/appointments?from=2025-03-07&to=2025-03-03')).expect(400);
      await get(api('reports/appointments?from=2023-01-01&to=2025-03-03')).expect(400);
      await get(api(`reports/appointments?${RANGE}&branchId=nope`)).expect(400);
    });
  });

  // ===========================================================================
  describe('customers report', () => {
    it('new, active, returning and growth without filters', async () => {
      const data = await report('customers');
      expect(data.filtered).toBe(false);
      expect(data.totals).toEqual({
        newCustomers: 3, // c2, c3, c4
        activeCustomers: 3, // c1, c2 (the no-show still booked), c4 — not cancelled-only
        returningCustomers: 1, // c1 existed before the range
        totalCustomers: 4,
        startingTotal: 1,
      });
      expect(
        data.byDay.map((d: { newCustomers: number; totalCustomers: number }) => [
          d.newCustomers,
          d.totalCustomers,
        ]),
      ).toEqual([
        [1, 2],
        [1, 3],
        [1, 4],
        [0, 4],
        [0, 4],
      ]);
    });

    it('with a branch filter counts only customers who booked there, and drops the company-wide total', async () => {
      const data = await report('customers', `&branchId=${north}`);
      expect(data.filtered).toBe(true);
      expect(data.totals).toMatchObject({
        newCustomers: 2,
        activeCustomers: 2,
        totalCustomers: null,
      });
      expect(data.byDay[0].totalCustomers).toBeNull();
    });

    it('never names a customer', async () => {
      const data = await report('customers');
      const text = JSON.stringify(data);
      for (const secret of ['Alpha', 'Bravo', 'Delta', 'Secret', '@private.test', '+9768']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  // ===========================================================================
  describe('services report', () => {
    it('ranks services with share and a zero-filled trend of the top services', async () => {
      const data = await report('services');
      expect(data.totals).toEqual({ bookings: 5, services: 2 });
      expect(
        data.items.items.map((r: { name: string; bookings: number; shareBps: number }) => [
          r.name,
          r.bookings,
          r.shareBps,
        ]),
      ).toEqual([
        ['Haircut', 3, 6000],
        ['Massage', 2, 4000],
      ]);
      expect(data.trend.services.map((s: { name: string }) => s.name)).toEqual([
        'Haircut',
        'Massage',
      ]);
      expect(data.trend.days).toHaveLength(5);
      expect(data.trend.days[2]).toEqual({
        date: '2025-03-05',
        counts: { [haircut]: 1, [massage]: 1 },
      });
    });

    it('filters by employee and status', async () => {
      const data = await report('services', `&employeeId=${ari}&status=COMPLETED`);
      expect(data.items.items).toHaveLength(1);
      expect(data.items.items[0]).toMatchObject({ name: 'Haircut', bookings: 1 });
    });
  });

  // ===========================================================================
  describe('promotions report', () => {
    it('usage, discount and usage by promotion', async () => {
      const data = await report('promotions');
      expect(data.totals).toEqual({
        redemptions: 2,
        customers: 2,
        promotionsUsed: 1,
        discountMinor: '13000',
      });
      expect(data.byPromotion.items[0]).toMatchObject({
        promotionId: promo,
        name: 'Spring 10%',
        discountType: 'PERCENTAGE',
        redemptions: 2,
        discountMinor: '13000',
        usage: { redeemed: 2, limit: 100 },
      });
      expect(data.byDay.find((d: { date: string }) => d.date === '2025-03-05')).toMatchObject({
        redemptions: 1,
        discountMinor: '9000',
      });
    });

    it('follows the branch and service filters through the redeemed appointment', async () => {
      expect((await report('promotions', `&branchId=${north}`)).totals).toMatchObject({
        redemptions: 1,
        discountMinor: '9000',
      });
      expect((await report('promotions', `&serviceId=${haircut}`)).totals.redemptions).toBe(1);
      expect((await report('promotions', '&status=CANCELLED')).totals.redemptions).toBe(0);
    });
  });

  // ===========================================================================
  describe('gift cards report', () => {
    it('issued, card states, balances and redemption activity', async () => {
      const data = await report('gift-cards');
      expect(data.issued).toEqual({ count: 2, initialValueMinor: '200000' });
      expect(data.cards).toMatchObject({
        active: 1,
        expired: 1,
        disabled: 1,
        depleted: 0,
        void: 0,
        outstandingBalanceMinor: '75000',
        expiredBalanceMinor: '60000',
      });
      expect(data.redemptions.totals).toEqual({
        redemptions: 2,
        redeemedMinor: '30000',
        refunds: 1,
        refundedMinor: '5000',
      });
      expect(data.redemptions.byDay[0]).toMatchObject({
        date: '2025-03-03',
        redemptions: 1,
        refunds: 1,
      });
      expect(data.appliedFilters).toMatchObject({ branch: true, employee: false });
    });

    it('narrows redemption activity by branch', async () => {
      const data = await report('gift-cards', `&branchId=${north}`);
      expect(data.redemptions.totals).toMatchObject({
        redemptions: 1,
        redeemedMinor: '20000',
        refunds: 0,
      });
      // Inventory stays company-wide for a caller who is not branch-confined.
      expect(data.inventoryVisible).toBe(true);
    });
  });

  // ===========================================================================
  describe('dashboard', () => {
    it('today’s figures, the company’s day, popular services and activity', async () => {
      const res = await get(api('dashboard?date=2025-03-05')).expect(200);
      const data = res.body.data;
      expect(data).toMatchObject({
        date: '2025-03-05',
        timezone: 'Asia/Ulaanbaatar',
        restricted: [],
      });
      // A4 confirmed, A5 completed; A7 is a HOLD and does not count.
      expect(data.appointments).toMatchObject({ today: 2, completed: 1, cancelled: 0, noShow: 0 });
      expect(typeof data.appointments.upcoming).toBe('number');
      expect(data.customers.newToday).toBe(1); // c4
      expect(
        data.popularServices.map((s: { name: string; bookings: number }) => [s.name, s.bookings]),
      ).toEqual([
        ['Haircut', 3],
        ['Massage', 1], // A2 was cancelled
      ]);
      expect(data.promotions).toMatchObject({
        redemptions: 2,
        discountMinor: '13000',
        topPromotion: { name: 'Spring 10%', redemptions: 2 },
      });
      expect(data.giftCards).toMatchObject({ redemptions: 2, redeemedMinor: '30000' });
      expect(data.revenue).not.toBeNull();
    });

    it('narrows everything to a branch', async () => {
      const data = (await get(api(`dashboard?date=2025-03-05&branchId=${north}`)).expect(200)).body
        .data;
      expect(data.appointments).toMatchObject({ today: 1, completed: 0 });
      expect(data.customers.newToday).toBe(1); // c4 booked at North
      expect(data.promotions.redemptions).toBe(1);
      expect(data.giftCards.redemptions).toBe(1);
    });

    it('is all zeros for a day with nothing in it', async () => {
      const data = (await get(api('dashboard?date=2024-01-01')).expect(200)).body.data;
      expect(data.appointments).toMatchObject({ today: 0, completed: 0, cancelled: 0, noShow: 0 });
      expect(data.customers.newToday).toBe(0);
    });
  });

  // ===========================================================================
  describe('empty datasets', () => {
    it('returns zero-filled, well-formed reports for a range with no activity', async () => {
      const q = 'from=2024-01-01&to=2024-01-07';
      const appointments = (await get(api(`reports/appointments?${q}`)).expect(200)).body.data;
      expect(appointments.totals).toMatchObject({
        total: 0,
        completionRateBps: 0,
        bookedValueMinor: '0',
      });
      expect(appointments.byDay).toHaveLength(7);
      expect(appointments.byService).toEqual({ items: [], total: 0, limit: 10, offset: 0 });

      const services = (await get(api(`reports/services?${q}`)).expect(200)).body.data;
      expect(services.trend).toMatchObject({ services: [] });
      const promotions = (await get(api(`reports/promotions?${q}`)).expect(200)).body.data;
      expect(promotions.totals).toMatchObject({ redemptions: 0, discountMinor: '0' });
      const cards = (await get(api(`reports/gift-cards?${q}`)).expect(200)).body.data;
      expect(cards.redemptions.totals.redemptions).toBe(0);
      const customers = (await get(api(`reports/customers?${q}`)).expect(200)).body.data;
      expect(customers.totals.newCustomers).toBe(0);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('never counts another company’s activity', async () => {
      const a = await report('appointments');
      expect(a.totals.total).toBe(5);
      expect(JSON.stringify(a)).not.toContain('B cut');

      const b = (
        await get(api(`reports/appointments?${RANGE}`, world.companyB.id), ownerB).expect(200)
      ).body.data;
      expect(b.totals.total).toBe(1);
      expect(b.byService.items.map((r: { name: string }) => r.name)).toEqual(['B cut']);
    });

    it('404s another company’s ids as filters, and another company’s path', async () => {
      const bService = await harness.prisma.service.findFirstOrThrow({
        where: { companyId: world.companyB.id },
      });
      const bEmployee = await harness.prisma.employee.findFirstOrThrow({
        where: { companyId: world.companyB.id },
      });
      await get(api(`reports/appointments?${RANGE}&branchId=${world.companyB.branchId}`)).expect(
        404,
      );
      await get(api(`reports/appointments?${RANGE}&serviceId=${bService.id}`)).expect(404);
      await get(api(`reports/appointments?${RANGE}&employeeId=${bEmployee.id}`)).expect(404);
      await get(api(`dashboard?branchId=${world.companyB.branchId}`)).expect(404);
      await get(api(`reports/appointments?${RANGE}`, world.companyB.id)).expect(404);
      await get(api('dashboard', world.companyB.id)).expect(404);
    });
  });

  // ===========================================================================
  describe('permissions and branch scope', () => {
    it('shows counts without money to a role without report:revenue:read', async () => {
      const manager = await member(SYSTEM_ROLES.BRANCH_MANAGER);
      const data = await report('appointments', '', manager);
      expect(data.amountsVisible).toBe(false);
      expect(data.totals).toMatchObject({ total: 5, bookedValueMinor: null });
      expect(data.byService.items[0].bookedValueMinor).toBeNull();
      expect((await report('promotions', '', manager)).totals.discountMinor).toBeNull();
      expect((await report('gift-cards', '', manager)).cards.outstandingBalanceMinor).toBeNull();

      const dashboard = (await get(api('dashboard?date=2025-03-05'), manager).expect(200)).body
        .data;
      expect(dashboard.appointments.today).toBe(2);
      expect(dashboard.revenue).toBeNull();
      expect(dashboard.promotions.discountMinor).toBeNull();
      expect(dashboard.restricted).toEqual(['revenue', 'amounts']);

      await get(api(`reports/revenue?${RANGE}`), manager).expect(403);
      await get(api(`reports/payment-methods?${RANGE}`), manager).expect(403);
    });

    it('confines a branch-scoped member to their branches', async () => {
      const northOnly = await member(SYSTEM_ROLES.BRANCH_MANAGER, [north]);

      const data = await report('appointments', '', northOnly);
      expect(data.totals.total).toBe(2);
      expect(data.filters.branchIds).toEqual([north]);
      expect(data.byBranch.items.map((r: { name: string }) => r.name)).toEqual(['North']);

      await get(api(`reports/appointments?${RANGE}&branchId=${main}`), northOnly).expect(404);
      await get(api(`reports/appointments?${RANGE}&branchId=${north}`), northOnly).expect(200);

      const cards = await report('gift-cards', '', northOnly);
      expect(cards).toMatchObject({ inventoryVisible: false, issued: null, cards: null });
      expect(cards.redemptions.totals.redemptions).toBe(1);

      const customers = await report('customers', '', northOnly);
      expect(customers.totals).toMatchObject({ newCustomers: 2, totalCustomers: null });

      const dashboard = (await get(api('dashboard?date=2025-03-05'), northOnly).expect(200)).body
        .data;
      expect(dashboard.appointments.today).toBe(1);
      expect(dashboard.restricted).toContain('giftCardInventory');
      expect(dashboard.giftCards.activeCards).toBeNull();
      await get(api(`dashboard?branchId=${main}`), northOnly).expect(404);
    });

    it('lets a read-only member read reports, without money', async () => {
      const reader = await member(SYSTEM_ROLES.READ_ONLY);
      const data = await report('services', '', reader);
      expect(data.amountsVisible).toBe(false);
    });

    it('keeps reports away from roles without report:read, and from anonymous callers', async () => {
      const receptionist = await member(SYSTEM_ROLES.RECEPTIONIST);
      await get(api(`reports/appointments?${RANGE}`), receptionist).expect(403);
      await get(api('dashboard'), receptionist).expect(403);
      const employee = await member(SYSTEM_ROLES.EMPLOYEE);
      await get(api(`reports/customers?${RANGE}`), employee).expect(403);
      await request(http)
        .get(api(`reports/gift-cards?${RANGE}`))
        .expect(401);
      await request(http).get(api('dashboard')).expect(401);
    });
  });
});
