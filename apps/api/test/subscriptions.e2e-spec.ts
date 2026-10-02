import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { EntitlementsService } from '../src/subscriptions/entitlements.service';
import { syncPlanCatalog, type LimitKey } from '../src/subscriptions/plan-catalog';
import { TenantDirectoryService } from '../src/tenancy/directory/tenant-directory.service';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * SUBSCRIPTIONS
 * ===========================================================================
 *
 * The plan catalog is seeded the same way `pnpm db:seed` does it. Most tests
 * put a company on a known plan/state directly in the database (`onPlan`) so
 * each one starts from a stated position rather than from whatever the test
 * before it left behind; the transitions themselves go through the API.
 */
describe('subscriptions', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;
  let billingOperator: string;
  let unique = 0;

  const api = (path: string, companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/${path}`;
  const as = (token: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(http).post(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  /** Caches the API keeps in memory, dropped after a change made behind its back. */
  function refresh(companyId: string) {
    harness.app.get(EntitlementsService).invalidate(companyId);
    harness.app.get(TenantDirectoryService).invalidate(companyId);
  }

  async function onPlan(
    companyId: string,
    planKey: string,
    data: Partial<{
      status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
      trialEndsAt: Date | null;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      graceEndsAt: Date | null;
    }> = {},
  ) {
    const plan = await harness.prisma.plan.findUniqueOrThrow({ where: { key: planKey } });
    const now = new Date();
    const fields = {
      planId: plan.id,
      status: data.status ?? ('ACTIVE' as const),
      trialEndsAt: data.trialEndsAt ?? null,
      currentPeriodStart: data.currentPeriodStart ?? now,
      currentPeriodEnd: data.currentPeriodEnd ?? new Date(now.getTime() + 30 * 86_400_000),
      graceEndsAt: data.graceEndsAt ?? null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      expiredAt: null,
    };
    await harness.prisma.subscription.upsert({
      where: { companyId },
      create: { companyId, ...fields },
      update: fields,
    });
    await harness.prisma.subscriptionEntitlementOverride.deleteMany({ where: { companyId } });
    refresh(companyId);
  }

  async function override(companyId: string, featureKey: string, value: number | boolean) {
    await harness.prisma.subscriptionEntitlementOverride.upsert({
      where: { companyId_featureKey: { companyId, featureKey } },
      create: {
        companyId,
        featureKey,
        reason: 'test',
        limitInt: typeof value === 'number' ? value : null,
        limitBool: typeof value === 'boolean' ? value : null,
      },
      update: {
        limitInt: typeof value === 'number' ? value : null,
        limitBool: typeof value === 'boolean' ? value : null,
      },
    });
    refresh(companyId);
  }

  type Usage = Record<LimitKey, { key: string; used: number; limit: number | null }>;
  const usage = async (companyId = world.companyA.id, token = ownerA): Promise<Usage> => {
    const res = await as(token).get(api('subscription', companyId)).expect(200);
    return Object.fromEntries(
      (res.body.data.usage as Array<{ key: string; used: number; limit: number | null }>).map(
        (u) => [u.key, u],
      ),
    ) as Usage;
  };

  const newCustomer = (token = ownerA, companyId = world.companyA.id) =>
    as(token).post(api('customers', companyId), {
      firstName: `Sub${unique}`,
      phone: `+9768${String(unique++).padStart(7, '0')}`,
    });

  async function member(roleKey: string): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `sub-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
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

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    await syncPlanCatalog(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
    billingOperator = await harness.platformToken(world.weakOperator.email);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('trial', () => {
    it('shows an unsubscribed company as unrestricted, with the plans on offer', async () => {
      const res = await as(ownerA).get(api('subscription')).expect(200);
      const data = res.body.data;
      expect(data.subscription).toBeNull();
      expect(data.trialAvailable).toBe(true);
      expect(data.plans.map((p: { key: string }) => p.key)).toEqual([
        'FREE',
        'STARTER',
        'PRO',
        'BUSINESS',
      ]);
      expect(data.plans[1]).toMatchObject({
        name: 'Starter',
        priceMinor: '4900000',
        currencyCode: 'MNT',
        interval: 'MONTH',
        trialDays: 14,
        features: { PROMOTIONS: true, GIFT_CARDS: false },
        limits: { MAX_EMPLOYEES: 5, MAX_BRANCHES: 1 },
      });
      expect(data.usage.every((u: { limit: number | null }) => u.limit === null)).toBe(true);
    });

    it('starts the company’s one trial', async () => {
      const res = await as(ownerA)
        .post(api('subscription/start-trial'), { planKey: 'pro' })
        .expect(200);
      const sub = res.body.data.subscription;
      expect(sub).toMatchObject({ status: 'TRIAL', plan: { key: 'PRO' }, readOnly: false });
      expect(sub.trial.daysLeft).toBe(14);
      expect(res.body.data.trialAvailable).toBe(false);
      expect(res.body.data.plans.find((p: { current: boolean }) => p.current).key).toBe('PRO');

      await as(ownerA).post(api('subscription/start-trial'), { planKey: 'STARTER' }).expect(409);
    });

    it('refuses a trial of a plan without one, and an unknown plan', async () => {
      await as(ownerB)
        .post(api('subscription/start-trial', world.companyB.id), { planKey: 'FREE' })
        .expect(400);
      await as(ownerB)
        .post(api('subscription/start-trial', world.companyB.id), { planKey: 'GOLD' })
        .expect(404);
    });

    it('expires a trial the moment it ends, and the sweep writes it down', async () => {
      await onPlan(world.companyB.id, 'PRO', {
        status: 'TRIAL',
        trialEndsAt: new Date(Date.now() - 60_000),
        currentPeriodEnd: new Date(Date.now() - 60_000),
      });
      const read = await as(ownerB).get(api('subscription', world.companyB.id)).expect(200);
      expect(read.body.data.subscription).toMatchObject({ status: 'EXPIRED', readOnly: true });

      const sweep = await as(billingOperator)
        .post('/api/v1/platform/subscriptions/sweep')
        .expect(200);
      expect(sweep.body.data.expired).toBeGreaterThanOrEqual(1);
      const stored = await harness.prisma.subscription.findUniqueOrThrow({
        where: { companyId: world.companyB.id },
      });
      expect(stored.status).toBe('EXPIRED');
      expect(stored.expiredAt).not.toBeNull();
    });
  });

  // ===========================================================================
  describe('plan changes and invoices', () => {
    beforeAll(async () => {
      await harness.prisma.subscriptionInvoice.deleteMany({
        where: { companyId: world.companyA.id },
      });
      await onPlan(world.companyA.id, 'PRO', {
        status: 'TRIAL',
        trialEndsAt: new Date(Date.now() + 5 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
      });
    });

    it('commits to a paid plan: ACTIVE, a new period and an open invoice', async () => {
      const res = await as(ownerA)
        .post(api('subscription/change-plan'), { planKey: 'STARTER' })
        .expect(200);
      expect(res.body.data.subscription).toMatchObject({
        status: 'ACTIVE',
        plan: { key: 'STARTER' },
        trial: null,
      });

      const invoices = await as(ownerA).get(api('billing')).expect(200);
      expect(invoices.body.data.total).toBe(1);
      const invoice = invoices.body.data.items[0];
      expect(invoice).toMatchObject({
        status: 'OPEN',
        plan: { name: 'Starter' },
        amountMinor: '4900000',
        totalMinor: '4900000',
        currencyCode: 'MNT',
      });
      expect(invoice.number).toMatch(/^INV-\d{6}-0001$/);
      const due = new Date(invoice.dueAt).getTime() - new Date(invoice.issuedAt).getTime();
      expect(Math.round(due / 86_400_000)).toBe(7);
      expect(res.body.data.openInvoice.number).toBe(invoice.number);

      const one = await as(ownerA)
        .get(api(`billing/${invoice.id}`))
        .expect(200);
      expect(one.body.data.number).toBe(invoice.number);
    });

    it('upgrades: the unpaid invoice for the old plan is voided and a new one issued', async () => {
      await as(ownerA).post(api('subscription/change-plan'), { planKey: 'PRO' }).expect(200);
      const invoices = (await as(ownerA).get(api('billing')).expect(200)).body.data.items;
      expect(
        invoices.map((i: { plan: { name: string }; status: string }) => [i.plan.name, i.status]),
      ).toEqual([
        ['Pro', 'OPEN'],
        ['Starter', 'VOID'],
      ]);
      const open = (await as(ownerA).get(api('billing?status=OPEN')).expect(200)).body.data;
      expect(open.total).toBe(1);
    });

    it('refuses the plan it is already on', async () => {
      await as(ownerA).post(api('subscription/change-plan'), { planKey: 'PRO' }).expect(409);
    });

    it('refuses a downgrade that current usage would exceed, naming each limit', async () => {
      await harness.prisma.branch.create({
        data: {
          companyId: world.companyA.id,
          code: `DG${unique++}`,
          name: 'Second',
          timezoneName: 'Asia/Ulaanbaatar',
        },
      });
      const res = await as(ownerA)
        .post(api('subscription/change-plan'), { planKey: 'STARTER' })
        .expect(403);
      expect(res.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
      expect(res.body.error.details.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ limit: 'MAX_BRANCHES', max: 1, current: 2 }),
        ]),
      );
      const still = (await as(ownerA).get(api('subscription')).expect(200)).body.data.subscription;
      expect(still.plan.key).toBe('PRO');
    });
  });

  // ===========================================================================
  describe('feature access', () => {
    it('turns features on and off with the plan', async () => {
      await onPlan(world.companyA.id, 'STARTER');
      const refused = await as(ownerA).get(api('gift-cards')).expect(403);
      expect(refused.body.error).toMatchObject({
        code: 'FEATURE_NOT_AVAILABLE',
        details: { feature: 'GIFT_CARDS', planKey: 'STARTER' },
      });
      await as(ownerA).get(api('promotions')).expect(200);

      await onPlan(world.companyA.id, 'FREE');
      await as(ownerA).get(api('promotions')).expect(403);

      await onPlan(world.companyA.id, 'PRO');
      await as(ownerA).get(api('gift-cards')).expect(200);
      await as(ownerA).get(api('promotions')).expect(200);
    });

    it('honours a per-company override from the database', async () => {
      await onPlan(world.companyA.id, 'STARTER');
      await override(world.companyA.id, 'GIFT_CARDS', true);
      await as(ownerA).get(api('gift-cards')).expect(200);
    });

    it('takes the public booking page down without online booking', async () => {
      await onPlan(world.companyA.id, 'PRO');
      const page = `/api/v1/public/companies/${world.companyA.slug}`;
      await request(http).get(page).expect(200);
      await override(world.companyA.id, 'ONLINE_BOOKING', false);
      await request(http).get(page).expect(404);
    });

    it('needs MULTI_BRANCH for a second branch', async () => {
      await harness.prisma.branch.updateMany({
        where: { companyId: world.companyA.id, id: { not: world.companyA.branchId } },
        data: { deletedAt: new Date() },
      });
      await onPlan(world.companyA.id, 'STARTER');
      const res = await as(ownerA)
        .post(api('branches'), {
          code: `MB${unique++}`,
          name: 'Another',
          timezoneName: 'Asia/Ulaanbaatar',
        })
        .expect(403);
      expect(res.body.error).toMatchObject({
        code: 'FEATURE_NOT_AVAILABLE',
        details: { feature: 'MULTI_BRANCH' },
      });
    });
  });

  // ===========================================================================
  describe('plan limits', () => {
    it('refuses one employee over the plan’s limit with the numbers', async () => {
      await onPlan(world.companyA.id, 'STARTER');
      const { MAX_EMPLOYEES } = await usage();
      expect(MAX_EMPLOYEES.limit).toBe(5);
      for (let i = MAX_EMPLOYEES.used; i < 5; i += 1) {
        await as(ownerA)
          .post(api('employees'), { displayName: `Staff ${unique++}` })
          .expect(201);
      }
      const res = await as(ownerA)
        .post(api('employees'), { displayName: 'One too many' })
        .expect(403);
      expect(res.body.error).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { limit: 'MAX_EMPLOYEES', max: 5, current: 5, planKey: 'STARTER' },
      });
      expect((await usage()).MAX_EMPLOYEES.used).toBe(5);
    });

    it('lets exactly as many concurrent creates through as the limit has room for', async () => {
      await onPlan(world.companyA.id, 'PRO');
      const { MAX_CUSTOMERS } = await usage();
      await override(world.companyA.id, 'MAX_CUSTOMERS', MAX_CUSTOMERS.used + 2);

      const results = await Promise.all(Array.from({ length: 6 }, () => newCustomer()));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 403)).toHaveLength(4);
      expect(
        await harness.prisma.companyCustomer.count({
          where: { companyId: world.companyA.id, deletedAt: null },
        }),
      ).toBe(MAX_CUSTOMERS.used + 2);
    });

    it('limits services, and a plan without a limit allows any number', async () => {
      await onPlan(world.companyA.id, 'PRO');
      const { MAX_SERVICES } = await usage();
      await override(world.companyA.id, 'MAX_SERVICES', MAX_SERVICES.used);
      const service = {
        name: `Svc ${unique++}`,
        durationMin: 30,
        priceMinor: '1000',
        currencyCode: 'MNT',
      };
      await as(ownerA).post(api('services'), service).expect(403);

      await onPlan(world.companyA.id, 'BUSINESS');
      await as(ownerA)
        .post(api('services'), { ...service, name: `Svc ${unique++}` })
        .expect(201);
      expect((await usage()).MAX_SERVICES.limit).toBeNull();
    });

    it('counts appointments created this month against the monthly allowance', async () => {
      const { prisma } = harness;
      const companyId = world.companyA.id;
      const branchId = world.companyA.branchId;
      await onPlan(companyId, 'BUSINESS');
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
      const service = await prisma.service.create({
        data: {
          companyId,
          name: 'Limit cut',
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 100n,
          currencyCode: 'MNT',
          requiresEmployee: true,
        },
      });
      await prisma.serviceBranch.create({ data: { companyId, serviceId: service.id, branchId } });
      const employee = await prisma.employee.create({
        data: { companyId, displayName: 'Limit person', status: 'ACTIVE', isBookable: true },
      });
      await prisma.employeeBranch.create({
        data: { companyId, employeeId: employee.id, branchId },
      });
      await prisma.employeeService.create({
        data: { companyId, employeeId: employee.id, serviceId: service.id },
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
      const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
      const book = (hour: number) =>
        as(ownerA).post(api('appointments'), {
          branchId,
          serviceId: service.id,
          employeeId: employee.id,
          customerId: world.companyA.customerId,
          startsAt: `${day}T${String(hour).padStart(2, '0')}:00:00+08:00`,
        });

      const { MAX_APPOINTMENTS_PER_MONTH } = await usage();
      await override(companyId, 'MAX_APPOINTMENTS_PER_MONTH', MAX_APPOINTMENTS_PER_MONTH.used + 1);
      await book(10).expect(201);
      const res = await book(12).expect(403);
      expect(res.body.error.details).toMatchObject({ limit: 'MAX_APPOINTMENTS_PER_MONTH' });
      expect((await usage()).MAX_APPOINTMENTS_PER_MONTH.used).toBe(
        MAX_APPOINTMENTS_PER_MONTH.used + 1,
      );
    });
  });

  // ===========================================================================
  describe('cancellation, expiry and reactivation', () => {
    it('cancels at period end and keeps working until then', async () => {
      await onPlan(world.companyA.id, 'PRO');
      const res = await as(ownerA)
        .post(api('subscription/cancel'), { reason: 'Closing a branch' })
        .expect(200);
      expect(res.body.data.subscription).toMatchObject({
        status: 'CANCELLED',
        cancelAtPeriodEnd: true,
        readOnly: false,
      });
      await newCustomer().expect(201);
      await as(ownerA).post(api('subscription/cancel')).expect(409);
    });

    it('undoes a cancellation', async () => {
      const res = await as(ownerA).post(api('subscription/reactivate')).expect(200);
      expect(res.body.data.subscription).toMatchObject({
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
      });
      await as(ownerA).post(api('subscription/reactivate')).expect(409);
    });

    it('makes an expired company read-only without deleting anything, and renews it', async () => {
      await onPlan(world.companyA.id, 'PRO', {
        status: 'CANCELLED',
        currentPeriodEnd: new Date(Date.now() - 60_000),
      });
      const before = await harness.prisma.companyCustomer.count({
        where: { companyId: world.companyA.id },
      });

      const sub = (await as(ownerA).get(api('subscription')).expect(200)).body.data.subscription;
      expect(sub).toMatchObject({ status: 'EXPIRED', readOnly: true });

      const refused = await newCustomer().expect(402);
      expect(refused.body.error).toMatchObject({
        code: 'TENANT_READ_ONLY',
        details: { reason: 'SUBSCRIPTION_EXPIRED' },
      });
      // Everything is still there and readable.
      const list = await as(ownerA).get(api('customers?limit=1')).expect(200);
      expect(list.body.data.total).toBe(before);
      expect(
        await harness.prisma.companyCustomer.count({ where: { companyId: world.companyA.id } }),
      ).toBe(before);
      // And the features switch off with it.
      await as(ownerA).get(api('gift-cards')).expect(403);

      const renewed = await as(ownerA).post(api('subscription/reactivate')).expect(200);
      expect(renewed.body.data.subscription).toMatchObject({ status: 'ACTIVE', readOnly: false });
      expect(renewed.body.data.openInvoice).not.toBeNull();
      await newCustomer().expect(201);
    });
  });

  // ===========================================================================
  describe('renewal, past due and payment (platform)', () => {
    it('renews at period end with a new invoice, goes past due when unpaid, and recovers when paid', async () => {
      const companyId = world.companyB.id;
      await harness.prisma.subscriptionInvoice.deleteMany({ where: { companyId } });
      await onPlan(companyId, 'STARTER', { currentPeriodEnd: new Date(Date.now() - 60_000) });

      await as(billingOperator).post('/api/v1/platform/subscriptions/sweep').expect(200);
      let stored = await harness.prisma.subscription.findUniqueOrThrow({ where: { companyId } });
      expect(stored.status).toBe('ACTIVE');
      expect(stored.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
      const invoice = await harness.prisma.subscriptionInvoice.findFirstOrThrow({
        where: { companyId, status: 'OPEN' },
      });

      // The invoice falls due unpaid.
      await harness.prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: { dueAt: new Date(Date.now() - 60_000) },
      });
      await as(billingOperator).post('/api/v1/platform/subscriptions/sweep').expect(200);
      stored = await harness.prisma.subscription.findUniqueOrThrow({ where: { companyId } });
      expect(stored.status).toBe('PAST_DUE');
      expect(stored.graceEndsAt!.getTime()).toBeGreaterThan(Date.now());
      // Past due still works.
      await newCustomer(ownerB, companyId).expect(201);

      await as(billingOperator)
        .post(`/api/v1/platform/companies/${companyId}/billing/${invoice.id}/mark-paid`, {
          reference: 'BANK-123',
        })
        .expect(200);
      stored = await harness.prisma.subscription.findUniqueOrThrow({ where: { companyId } });
      expect(stored).toMatchObject({ status: 'ACTIVE', graceEndsAt: null });
      const paid = (
        await as(ownerB)
          .get(api(`billing/${invoice.id}`, companyId))
          .expect(200)
      ).body.data;
      expect(paid).toMatchObject({ status: 'PAID', amountPaidMinor: paid.totalMinor });
      await as(billingOperator)
        .post(`/api/v1/platform/companies/${companyId}/billing/${invoice.id}/mark-paid`, {
          reference: 'BANK-123',
        })
        .expect(409);
    });

    it('expires a past-due subscription when grace runs out; an operator can extend it', async () => {
      const companyId = world.companyB.id;
      await onPlan(companyId, 'STARTER', {
        status: 'PAST_DUE',
        graceEndsAt: new Date(Date.now() - 60_000),
      });
      await as(billingOperator).post('/api/v1/platform/subscriptions/sweep').expect(200);
      expect(
        (await harness.prisma.subscription.findUniqueOrThrow({ where: { companyId } })).status,
      ).toBe('EXPIRED');
      await newCustomer(ownerB, companyId).expect(402);

      await as(billingOperator)
        .post(`/api/v1/platform/companies/${companyId}/subscription/extend`, {
          days: 10,
          reason: 'Goodwill',
        })
        .expect(200);
      const sub = (await as(ownerB).get(api('subscription', companyId)).expect(200)).body.data
        .subscription;
      expect(sub).toMatchObject({ status: 'ACTIVE', readOnly: false });
      await newCustomer(ownerB, companyId).expect(201);
    });

    it('keeps platform operations away from company users, and company ones from operators', async () => {
      const companyId = world.companyB.id;
      const extend = `/api/v1/platform/companies/${companyId}/subscription/extend`;
      const res = await as(ownerB).post(extend, { days: 10, reason: 'Self-service' });
      expect([401, 404]).toContain(res.status);
      const sweep = await as(ownerA).post('/api/v1/platform/subscriptions/sweep');
      expect([401, 404]).toContain(sweep.status);
      // An operator with billing:manage but no tenant data access cannot act as the company.
      const viaTenant = await as(billingOperator).post(api('subscription/change-plan', companyId), {
        planKey: 'PRO',
      });
      expect(viaTenant.status).not.toBe(200);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('never shows or changes another company’s subscription or invoices', async () => {
      const theirInvoice = await harness.prisma.subscriptionInvoice.findFirstOrThrow({
        where: { companyId: world.companyB.id },
      });
      await as(ownerA).get(api('subscription', world.companyB.id)).expect(404);
      await as(ownerA).post(api('subscription/cancel', world.companyB.id)).expect(404);
      await as(ownerA).get(api('billing', world.companyB.id)).expect(404);
      await as(ownerA)
        .get(api(`billing/${theirInvoice.id}`))
        .expect(404);
      const mine = (await as(ownerA).get(api('billing?limit=100')).expect(200)).body.data.items;
      expect(mine.map((i: { id: string }) => i.id)).not.toContain(theirInvoice.id);

      const before = await harness.prisma.subscription.findUniqueOrThrow({
        where: { companyId: world.companyB.id },
      });
      await onPlan(world.companyA.id, 'PRO');
      await as(ownerA).post(api('subscription/change-plan'), { planKey: 'BUSINESS' }).expect(200);
      const after = await harness.prisma.subscription.findUniqueOrThrow({
        where: { companyId: world.companyB.id },
      });
      expect(after.planId).toBe(before.planId);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('lets an admin read billing but not change the plan', async () => {
      const admin = await member(SYSTEM_ROLES.ADMIN);
      await as(admin).get(api('subscription')).expect(200);
      await as(admin).get(api('billing')).expect(200);
      await as(admin).post(api('subscription/change-plan'), { planKey: 'PRO' }).expect(403);
      await as(admin).post(api('subscription/cancel')).expect(403);
    });

    it('keeps billing from roles without the billing permission, and from anonymous callers', async () => {
      for (const role of [
        SYSTEM_ROLES.RECEPTIONIST,
        SYSTEM_ROLES.EMPLOYEE,
        SYSTEM_ROLES.READ_ONLY,
      ]) {
        const token = await member(role);
        await as(token).get(api('subscription')).expect(403);
        await as(token).get(api('billing')).expect(403);
        await as(token).post(api('subscription/change-plan'), { planKey: 'PRO' }).expect(403);
      }
      await request(http).get(api('subscription')).expect(401);
      await request(http)
        .post(api('subscription/change-plan'))
        .send({ planKey: 'PRO' })
        .expect(401);
    });

    it('validates input', async () => {
      await as(ownerA).post(api('subscription/change-plan'), { planKey: '' }).expect(400);
      await as(ownerA)
        .post(api('subscription/change-plan'), { planKey: 'PRO', extra: 1 })
        .expect(400);
      await as(ownerA).get(api('billing?status=PAIDISH')).expect(400);
      await as(ownerA).get(api('billing/not-a-uuid')).expect(400);
    });
  });
});
