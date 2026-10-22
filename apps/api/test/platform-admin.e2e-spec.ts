import request from 'supertest';
import type { Server } from 'node:http';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * PLATFORM ADMIN
 * ===========================================================================
 *
 * The module that is SUPPOSED to read across tenants, which makes its
 * authorization boundary the one worth testing hardest.
 *
 * Three separate things have to hold, and a test for each:
 *
 *   1. REALM      a staff token is refused at the audience check, before any
 *                 permission is consulted. There is no company permission that
 *                 opens these routes.
 *   2. PERMISSION a platform operator without the right platform grant is
 *                 refused — platform permissions are not one undifferentiated
 *                 "is an operator" flag.
 *   3. EXPOSURE   what comes back is counts and company users, never a
 *                 tenant's customers.
 */
describe('platform admin', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  /** Full console: list + suspend + audit. */
  let admin: string;
  /** Support: data read/write, company list — but NOT suspend or audit. */
  let support: string;
  /** Billing only: no company permissions at all. */
  let weak: string;
  /** A company OWNER. The most privileged possible staff token. */
  let ownerA: string;

  let unique = 0;

  const url = (path: string) => `/api/v1/platform/${path}`;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    admin = await harness.platformToken(world.platformAdmin.email);
    support = await harness.platformToken(world.operator.email);
    weak = await harness.platformToken(world.weakOperator.email);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  /** Put a company back the way the suite found it. */
  async function restore(companyId: string) {
    await harness.prisma.company.update({
      where: { id: companyId },
      data: { status: 'ACTIVE', suspendedAt: null },
    });
  }

  // ===========================================================================
  describe('the realm boundary', () => {
    const routes = [
      ['get', 'dashboard'],
      ['get', 'companies'],
      ['get', 'audit-logs'],
    ] as const;

    it.each(routes)('refuses an anonymous %s /%s', async (method, path) => {
      await request(http)[method](url(path)).expect(401);
    });

    it.each(routes)('refuses a company OWNER on %s /%s', async (method, path) => {
      /**
       * The headline property. `ownerA` holds every company permission there
       * is — `seedWorld` gives them a role with the entire catalogue — and it
       * buys nothing here, because the token's AUDIENCE is wrong. Platform
       * access is not the top of the company ladder; it is a different ladder.
       */
      const res = await request(http)[method](url(path)).set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_AUDIENCE_MISMATCH');
    });

    it('refuses a company owner on a company-scoped platform route', async () => {
      await request(http)
        .get(url(`companies/${world.companyA.id}`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(401);

      // Even on their OWN company, which is the tempting special case.
      await request(http)
        .get(url(`companies/${world.companyA.id}/users`))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(401);
    });

    it('refuses a staff token on the status change, and changes nothing', async () => {
      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ status: 'SUSPENDED', reason: 'Should never happen' })
        .expect(401);

      const after = await harness.prisma.company.findUniqueOrThrow({
        where: { id: world.companyB.id },
      });
      expect(after.status).toBe('ACTIVE');
    });
  });

  // ===========================================================================
  describe('platform permissions are not one flag', () => {
    it('refuses an operator with no company permissions', async () => {
      // `weakOperator` holds only `platform:billing:manage`. Being an operator
      // is not the same as being allowed to see the tenants.
      for (const path of ['dashboard', 'companies', 'audit-logs']) {
        const res = await request(http).get(url(path)).set('Authorization', `Bearer ${weak}`);
        expect(res.status).toBe(403);
      }
    });

    it('separates reading the audit trail from listing companies', async () => {
      /**
       * `operator` holds `platform:company:list` and `platform:company:data:*`
       * but not `platform:audit:read`. Reading the history of everything every
       * tenant has ever done is a larger grant than listing them.
       */
      await request(http).get(url('companies')).set('Authorization', `Bearer ${support}`).expect(200);
      await request(http).get(url('audit-logs')).set('Authorization', `Bearer ${support}`).expect(403);
    });

    it('separates suspending a company from reading it', async () => {
      await request(http)
        .get(url(`companies/${world.companyA.id}`))
        .set('Authorization', `Bearer ${support}`)
        .expect(200);

      await request(http)
        .patch(url(`companies/${world.companyA.id}/status`))
        .set('Authorization', `Bearer ${support}`)
        .send({ status: 'SUSPENDED', reason: 'Support should not be able to do this' })
        .expect(403);

      const after = await harness.prisma.company.findUniqueOrThrow({
        where: { id: world.companyA.id },
      });
      expect(after.status).toBe('ACTIVE');
    });
  });

  // ===========================================================================
  describe('company list', () => {
    it('returns every company, across tenants', async () => {
      const res = await request(http)
        .get(url('companies?limit=100'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const ids = res.body.data.items.map((c: { id: string }) => c.id);
      // The whole point of the module: both tenants, from one token.
      expect(ids).toContain(world.companyA.id);
      expect(ids).toContain(world.companyB.id);
      expect(res.body.data.total).toBeGreaterThanOrEqual(2);
    });

    it('carries counts, not contents', async () => {
      const res = await request(http)
        .get(url('companies?limit=100'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const company = res.body.data.items.find((c: { id: string }) => c.id === world.companyA.id);
      expect(company).toMatchObject({
        slug: 'company-a',
        status: 'ACTIVE',
        userCount: expect.any(Number),
        branchCount: expect.any(Number),
      });
      // An operator sizes a tenant; they do not read it.
      expect(company).not.toHaveProperty('customers');
      expect(company).not.toHaveProperty('appointments');
    });

    it('searches name, slug and contact email', async () => {
      for (const term of ['Company A', 'company-a']) {
        const res = await request(http)
          .get(url(`companies?search=${encodeURIComponent(term)}`))
          .set('Authorization', `Bearer ${admin}`)
          .expect(200);
        expect(res.body.data.items.map((c: { id: string }) => c.id)).toContain(world.companyA.id);
      }
    });

    it('filters by status', async () => {
      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'Filter test' })
        .expect(200);

      const suspended = await request(http)
        .get(url('companies?status=SUSPENDED&limit=100'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(suspended.body.data.items.map((c: { id: string }) => c.id)).toContain(world.companyB.id);

      const active = await request(http)
        .get(url('companies?status=ACTIVE&limit=100'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(active.body.data.items.map((c: { id: string }) => c.id)).not.toContain(
        world.companyB.id,
      );

      await restore(world.companyB.id);
    });

    it('paginates and sorts', async () => {
      const res = await request(http)
        .get(url('companies?limit=1&sortBy=displayName&sortOrder=asc'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data).toMatchObject({ limit: 1, offset: 0 });
      expect(res.body.data.total).toBeGreaterThan(1);
    });

    it('rejects an unknown query parameter', async () => {
      await request(http)
        .get(url('companies?includeDeleted=true'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(400);
    });
  });

  // ===========================================================================
  describe('company detail', () => {
    it('reports the counts an operator needs to size a tenant', async () => {
      const res = await request(http)
        .get(url(`companies/${world.companyA.id}`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.counts).toMatchObject({
        branches: expect.any(Number),
        employees: expect.any(Number),
        services: expect.any(Number),
        customers: expect.any(Number),
        appointments: expect.any(Number),
        activeUsers: expect.any(Number),
      });
      // Company A is seeded with a customer and two appointments.
      expect(res.body.data.counts.customers).toBeGreaterThanOrEqual(1);
      expect(res.body.data.counts.appointments).toBeGreaterThanOrEqual(1);
    });

    it('never returns a tenant’s customer data', async () => {
      /**
       * The exposure property. Company A's seeded customer has a real name,
       * email and phone, and none of them may appear anywhere in this payload —
       * a console that leaked them would turn one compromised operator account
       * into a breach of every tenant at once.
       */
      const customer = await harness.prisma.companyCustomer.findFirstOrThrow({
        where: { companyId: world.companyA.id },
      });

      const res = await request(http)
        .get(url(`companies/${world.companyA.id}`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(customer.firstName);
      expect(body).not.toContain(customer.email);
      expect(body).not.toContain(customer.phone);
    });

    it('includes recent activity as a shape, not a payload', async () => {
      await request(http)
        .patch(url(`companies/${world.companyA.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'Activity shape test' })
        .expect(200);
      await restore(world.companyA.id);

      const res = await request(http)
        .get(url(`companies/${world.companyA.id}`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const entry = res.body.data.recentActivity[0];
      expect(entry).toMatchObject({ action: expect.any(String), actorType: 'PLATFORM_USER' });
      // What changed is the tenant's business; THAT it changed is the operator's.
      expect(entry).not.toHaveProperty('before');
      expect(entry).not.toHaveProperty('after');
    });

    it('404s for a company that does not exist', async () => {
      await request(http)
        .get(url('companies/018f0000-0000-7000-8000-0000000000ff'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('status management', () => {
    it('suspends, and records the reason on the audit trail', async () => {
      const res = await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'Non-payment after three reminders' })
        .expect(200);

      expect(res.body.data.status).toBe('SUSPENDED');
      expect(res.body.data.suspendedAt).not.toBeNull();

      const entry = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'platform.company.suspended', resourceId: world.companyB.id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(entry.actorType).toBe('PLATFORM_USER');
      // Filed against the company it happened to, so the tenant can see it on
      // their own audit screen rather than it vanishing into a platform row.
      expect(entry.companyId).toBe(world.companyB.id);
      expect(JSON.stringify(entry.metadata)).toContain('Non-payment after three reminders');

      await restore(world.companyB.id);
    });

    it('reactivates a suspended company and clears suspendedAt', async () => {
      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'Temporarily off' })
        .expect(200);

      const res = await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'ACTIVE', reason: 'Paid up' })
        .expect(200);

      expect(res.body.data.status).toBe('ACTIVE');
      // Left behind, a stale `suspendedAt` makes an ACTIVE company read as
      // suspended to anybody scanning the table.
      expect(res.body.data.suspendedAt).toBeNull();
    });

    it('brings a cancelled company back — the only path that can', async () => {
      /**
       * `POST /companies/:id/deactivate` is deliberately one-way: a CANCELED
       * company is not-found to `MembershipService`, so its owner can no longer
       * reach anything, including a reactivate button. This endpoint is the
       * only way back, which is a large part of why the module exists.
       */
      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'CANCELED', reason: 'Customer asked to close' })
        .expect(200);

      const res = await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'ACTIVE', reason: 'Changed their mind' })
        .expect(200);

      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('requires a reason, and a usable one', async () => {
      for (const body of [
        { status: 'SUSPENDED' },
        { status: 'SUSPENDED', reason: 'no' },
        { status: 'SUSPENDED', reason: '   ' },
      ]) {
        await request(http)
          .patch(url(`companies/${world.companyB.id}/status`))
          .set('Authorization', `Bearer ${admin}`)
          .send(body)
          .expect(400);
      }
    });

    it('refuses PENDING_SETUP as a target', async () => {
      // It means "provisioned, owner has not accepted" — a fact about history,
      // not a state anybody can put a company back into.
      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'PENDING_SETUP', reason: 'Should be refused' })
        .expect(400);
    });

    it('refuses a no-op', async () => {
      const res = await request(http)
        .patch(url(`companies/${world.companyA.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'ACTIVE', reason: 'Already active' })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('refuses an unknown status value', async () => {
      await request(http)
        .patch(url(`companies/${world.companyA.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'DISABLED', reason: 'Not a value in this schema' })
        .expect(400);
    });

    it('a suspended company cannot be reached by its own staff', async () => {
      /**
       * The reason a status change is worth auditing: it takes a whole company
       * offline. Proving it end to end also proves the tenant-directory cache
       * was invalidated — without that line the company keeps working for the
       * rest of the TTL, silently.
       */
      await request(http)
        .patch(url(`companies/${world.companyA.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'End-to-end check' })
        .expect(200);

      const res = await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/customers`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBeGreaterThanOrEqual(400);

      await request(http)
        .patch(url(`companies/${world.companyA.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'ACTIVE', reason: 'Restoring after the check' })
        .expect(200);

      // And it works again immediately, rather than after a cache expiry.
      await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/customers`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
    });
  });

  // ===========================================================================
  describe('company users', () => {
    it('lists the people who can sign in, with their roles', async () => {
      const res = await request(http)
        .get(url(`companies/${world.companyA.id}/users`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const member = res.body.data.items.find(
        (u: { userAccountId: string }) => u.userAccountId === world.userA.id,
      );
      expect(member).toMatchObject({
        email: world.userA.email,
        membershipStatus: 'ACTIVE',
        roles: expect.arrayContaining(['FULL']),
      });
    });

    it('never returns a credential', async () => {
      const res = await request(http)
        .get(url(`companies/${world.companyA.id}/users`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const body = JSON.stringify(res.body);
      for (const forbidden of ['passwordHash', 'mfaSecret', 'tokenHash', 'refreshToken']) {
        expect(body).not.toContain(forbidden);
      }
    });

    it('shows only the named company’s members', async () => {
      const res = await request(http)
        .get(url(`companies/${world.companyA.id}/users?limit=100`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      // userB belongs to company B only, and userAB belongs to both — so the
      // list must contain the second and not the first.
      const ids = res.body.data.items.map((u: { userAccountId: string }) => u.userAccountId);
      expect(ids).not.toContain(world.userB.id);
      expect(ids).toContain(world.userAB.id);
    });

    it('filters and paginates', async () => {
      const res = await request(http)
        .get(url(`companies/${world.companyA.id}/users?status=ACTIVE&limit=1`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].membershipStatus).toBe('ACTIVE');
    });

    it('404s for a company that does not exist', async () => {
      await request(http)
        .get(url('companies/018f0000-0000-7000-8000-0000000000ff/users'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('subscription and usage', () => {
    it('reports no subscription without inventing one', async () => {
      const res = await request(http)
        .get(url(`companies/${world.companyB.id}/subscription`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.subscription).toBeNull();
      expect(res.body.data.usage).toEqual([]);
    });

    it('reports the plan, its limits and this period’s usage against them', async () => {
      // The catalogue is empty after a truncate, so the whole chain has to be
      // built: features, a plan, its entitlements, a subscription and a counter.
      await harness.prisma.feature.createMany({
        data: [
          { key: 'MAX_EMPLOYEES', name: 'Employees', valueType: 'LIMIT', unit: 'employees' },
          { key: 'ONLINE_BOOKING', name: 'Online booking', valueType: 'BOOLEAN' },
        ],
        skipDuplicates: true,
      });

      const plan = await harness.prisma.plan.create({
        data: {
          key: `TEST${unique++}`,
          name: 'Test plan',
          priceMinor: 5_000_000n,
          currencyCode: 'MNT',
          interval: 'MONTH',
          entitlements: {
            create: [
              { featureKey: 'MAX_EMPLOYEES', limitInt: 10 },
              { featureKey: 'ONLINE_BOOKING', limitBool: true },
            ],
          },
        },
      });

      await harness.prisma.subscription.create({
        data: {
          companyId: world.companyA.id,
          planId: plan.id,
          status: 'TRIAL',
          trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      });

      const periodKey = new Date().toISOString().slice(0, 7);
      await harness.prisma.usageCounter.create({
        data: { companyId: world.companyA.id, metric: 'ACTIVE_EMPLOYEES', periodKey, value: 4n },
      });

      const res = await request(http)
        .get(url(`companies/${world.companyA.id}/subscription`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.subscription).toMatchObject({
        status: 'TRIAL',
        planKey: plan.key,
        planName: 'Test plan',
      });
      expect(res.body.data.entitlements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ featureKey: 'MAX_EMPLOYEES', limitInt: 10 }),
        ]),
      );
      expect(res.body.data.usage).toEqual(
        expect.arrayContaining([expect.objectContaining({ metric: 'ACTIVE_EMPLOYEES', used: 4 })]),
      );
    });

    it('lets a negotiated override beat the plan', async () => {
      // What the override table is for: without it, bespoke enterprise limits
      // end up hardcoded against customer names.
      await harness.prisma.subscriptionEntitlementOverride.create({
        data: {
          companyId: world.companyA.id,
          featureKey: 'MAX_EMPLOYEES',
          limitInt: 500,
          reason: 'Negotiated at signature',
        },
      });

      const res = await request(http)
        .get(url(`companies/${world.companyA.id}/subscription`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const entitlement = res.body.data.entitlements.find(
        (e: { featureKey: string }) => e.featureKey === 'MAX_EMPLOYEES',
      );
      expect(entitlement).toMatchObject({ limitInt: 500, overridden: true });
    });

    it('filters the company list by subscription status and plan', async () => {
      const byStatus = await request(http)
        .get(url('companies?subscriptionStatus=TRIAL&limit=100'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(byStatus.body.data.items.map((c: { id: string }) => c.id)).toContain(
        world.companyA.id,
      );
      // Company B has no subscription at all, so it is correctly excluded.
      expect(byStatus.body.data.items.map((c: { id: string }) => c.id)).not.toContain(
        world.companyB.id,
      );
    });
  });

  // ===========================================================================
  describe('dashboard', () => {
    it('counts companies by status, including the brief’s DISABLED', async () => {
      const res = await request(http)
        .get(url('dashboard'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.companies).toMatchObject({
        total: expect.any(Number),
        active: expect.any(Number),
        suspended: expect.any(Number),
        // `CANCELED` in the schema; the brief calls it DISABLED.
        disabled: expect.any(Number),
        pendingSetup: expect.any(Number),
      });
      expect(res.body.data.companies.total).toBeGreaterThanOrEqual(2);
    });

    it('moves when a company is suspended', async () => {
      const before = await request(http)
        .get(url('dashboard'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'Dashboard check' })
        .expect(200);

      const after = await request(http)
        .get(url('dashboard'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(after.body.data.companies.suspended).toBe(
        before.body.data.companies.suspended + 1,
      );
      expect(after.body.data.companies.active).toBe(before.body.data.companies.active - 1);
      // The total does not move: a suspended company is still a company.
      expect(after.body.data.companies.total).toBe(before.body.data.companies.total);

      await restore(world.companyB.id);
    });

    it('reports users, appointments and subscriptions', async () => {
      const res = await request(http)
        .get(url('dashboard'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.users.total).toBeGreaterThanOrEqual(3);
      expect(res.body.data.appointments.total).toBeGreaterThanOrEqual(2);
      expect(res.body.data.subscriptions).toMatchObject({
        trial: expect.any(Number),
        active: expect.any(Number),
        trialsEndingWithin7Days: expect.any(Number),
      });
    });

    it('exposes no tenant business data', async () => {
      const customer = await harness.prisma.companyCustomer.findFirstOrThrow({
        where: { companyId: world.companyA.id },
      });

      const res = await request(http)
        .get(url('dashboard'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(customer.firstName);
      expect(body).not.toContain(customer.email);
    });
  });

  // ===========================================================================
  describe('audit logs', () => {
    it('spans every tenant', async () => {
      for (const companyId of [world.companyA.id, world.companyB.id]) {
        await request(http)
          .patch(url(`companies/${companyId}/status`))
          .set('Authorization', `Bearer ${admin}`)
          .send({ status: 'SUSPENDED', reason: `Audit span check ${unique++}` })
          .expect(200);
        await restore(companyId);
      }

      const res = await request(http)
        .get(url('audit-logs?action=platform.company.suspended&limit=100'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const companyIds = new Set(res.body.data.items.map((r: { companyId: string }) => r.companyId));
      expect(companyIds.has(world.companyA.id)).toBe(true);
      expect(companyIds.has(world.companyB.id)).toBe(true);
    });

    it('surfaces an operator’s reason and nothing else from the payload', async () => {
      await request(http)
        .patch(url(`companies/${world.companyB.id}/status`))
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED', reason: 'A very specific operator note' })
        .expect(200);
      await restore(world.companyB.id);

      const res = await request(http)
        .get(url(`audit-logs?companyId=${world.companyB.id}&action=platform.company.suspended`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      const entry = res.body.data.items[0];
      expect(entry.reason).toBe('A very specific operator note');
      // The before/after payloads stay in the database for the tenant's own
      // audit screen; an operator sees that something changed, not what.
      expect(entry).not.toHaveProperty('before');
      expect(entry).not.toHaveProperty('after');
      expect(entry).not.toHaveProperty('metadata');
    });

    it('does not leak a reason-shaped key out of a tenant’s own audit metadata', async () => {
      /**
       * `platformReason` is guarded on the `platform.` action prefix precisely
       * so a feature module that happens to put a `reason` in its metadata —
       * a gift-card void, say — does not have it republished to operators.
       */
      await harness.prisma.$executeRaw`SELECT 1`;
      const res = await request(http)
        .get(url(`audit-logs?companyId=${world.companyA.id}&limit=100`))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      for (const entry of res.body.data.items) {
        if (!String(entry.action).startsWith('platform.')) {
          expect(entry.reason).toBeNull();
        }
      }
    });

    it('filters by company, actor type and date', async () => {
      const res = await request(http)
        .get(
          url(
            `audit-logs?companyId=${world.companyA.id}&actorType=PLATFORM_USER` +
              `&from=${new Date().toISOString().slice(0, 10)}`,
          ),
        )
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(
        res.body.data.items.every(
          (r: { companyId: string; actorType: string }) =>
            r.companyId === world.companyA.id && r.actorType === 'PLATFORM_USER',
        ),
      ).toBe(true);
    });

    it('paginates', async () => {
      const res = await request(http)
        .get(url('audit-logs?limit=2'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      expect(res.body.data).toMatchObject({ limit: 2, offset: 0 });
    });

    it('rejects an unknown filter', async () => {
      await request(http)
        .get(url('audit-logs?userId=whoever'))
        .set('Authorization', `Bearer ${admin}`)
        .expect(400);
    });
  });

  // ===========================================================================
  describe('tenant isolation is untouched', () => {
    it('a platform operator token still cannot use a company route', async () => {
      /**
       * Platform access does not degrade into company access. `MembershipService`
       * requires `platform:company:data:read` explicitly for a tenant route,
       * and the console permissions do not include it.
       */
      const res = await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/customers`)
        .set('Authorization', `Bearer ${admin}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(200);
    });

    it('company A still cannot see company B after all of this', async () => {
      const theirCustomer = await harness.prisma.companyCustomer.findFirstOrThrow({
        where: { companyId: world.companyB.id },
      });

      await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/customers/${theirCustomer.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });
  });
});
