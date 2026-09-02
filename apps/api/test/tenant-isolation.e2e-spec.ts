import request from 'supertest';
import type { Server } from 'node:http';
import { TenantJobRunner, type TenantJob } from '../src/jobs/tenant-job.runner';
import { RequestContextService } from '../src/tenancy/context/request-context.service';
import { MembershipService } from '../src/tenancy/membership/membership.service';
import { TenantDirectoryService } from '../src/tenancy/directory/tenant-directory.service';
import { seedWorld, type SeededWorld } from './support/seed';
import { bearer, createTestHarness, type TestHarness } from './support/test-app';

/**
 * ===========================================================================
 * TENANT ISOLATION SUITE
 * ===========================================================================
 *
 * The twelve scenarios from the brief, against a real PostgreSQL with RLS
 * applied, through the real guards.
 *
 * REQUIRES A DATABASE:
 *   docker compose up -d postgres-test
 *   pnpm db:deploy      # migrate + apply 001_hardening.sql
 *   pnpm test:e2e
 *
 * global-setup.ts refuses to run if the hardening SQL is missing, because most
 * of these assertions would still pass on the repository layer alone and the
 * green run would be a lie about row-level security.
 *
 * Every cross-tenant denial asserts 404, never 403. A 403 confirms the row
 * exists, which turns any id into an existence oracle — and UUIDv7 ids also
 * encode a creation timestamp.
 */
describe('tenant isolation', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    world = await seedWorld(harness.prisma);
    tokenA = await harness.staffToken(world.userA.email);
    tokenB = await harness.staffToken(world.userB.email);
  });

  // -------------------------------------------------------------------------
  // Test 1 — the control
  // -------------------------------------------------------------------------
  describe('Test 1: a company A user can reach company A data', () => {
    it('returns the appointment', async () => {
      const res = await request(http)
        .get(`/api/v1/probe/appointments/${world.companyA.appointmentId}`)
        .set(bearer(tokenA))
        .expect(200);

      expect(res.body.id).toBe(world.companyA.appointmentId);
      expect(res.body.companyId).toBe(world.companyA.id);
    });

    it('lists only company A appointments', async () => {
      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(tokenA))
        .expect(200);

      expect(res.body.companyId).toBe(world.companyA.id);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe(world.companyA.appointmentId);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — cross-company read
  // -------------------------------------------------------------------------
  describe('Test 2: a company A user cannot read a company B appointment', () => {
    it('returns 404 for a known company B appointment id', async () => {
      const res = await request(http)
        .get(`/api/v1/probe/appointments/${world.companyB.appointmentId}`)
        .set(bearer(tokenA))
        .expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('is indistinguishable from an id that does not exist anywhere', async () => {
      // The anti-enumeration property, asserted directly: knowing a real id
      // must buy the attacker nothing.
      const real = await request(http)
        .get(`/api/v1/probe/appointments/${world.companyB.appointmentId}`)
        .set(bearer(tokenA));

      const fictional = await request(http)
        .get('/api/v1/probe/appointments/018f0000-0000-7000-8000-0000000000ff')
        .set(bearer(tokenA));

      expect(real.status).toBe(fictional.status);
      expect(real.body.error.code).toBe(fictional.body.error.code);
      expect(real.body.error.message).toBe(fictional.body.error.message);
    });

    it('is symmetric — company B cannot read company A either', async () => {
      // Isolation that only holds in one direction is a bug that a
      // single-direction suite would miss.
      await request(http)
        .get(`/api/v1/probe/appointments/${world.companyA.appointmentId}`)
        .set(bearer(tokenB))
        .expect(404);

      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(tokenB))
        .expect(200);
      expect(res.body.companyId).toBe(world.companyB.id);
      expect(res.body.items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — cross-company update
  // -------------------------------------------------------------------------
  describe('Test 3: a company A user cannot update a company B appointment', () => {
    it('returns 404 and leaves the row untouched', async () => {
      await request(http)
        .patch(`/api/v1/probe/appointments/${world.companyB.appointmentId}`)
        .set(bearer(tokenA))
        .expect(404);

      const untouched = await harness.prisma.appointment.findUniqueOrThrow({
        where: { id: world.companyB.appointmentId },
      });
      expect(untouched.status).toBe('CONFIRMED');
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — cross-company delete
  // -------------------------------------------------------------------------
  describe('Test 4: a company A user cannot delete a company B appointment', () => {
    it('returns 404 and the row survives', async () => {
      await request(http)
        .delete(`/api/v1/probe/appointments/${world.companyB.appointmentId}`)
        .set(bearer(tokenA))
        .expect(404);

      const survived = await harness.prisma.appointment.count({
        where: { id: world.companyB.appointmentId },
      });
      expect(survived).toBe(1);
    });

    it('can still delete its own', async () => {
      await request(http)
        .delete(`/api/v1/probe/appointments/${world.companyA.appointmentId}`)
        .set(bearer(tokenA))
        .expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — customers
  // -------------------------------------------------------------------------
  describe('Test 5: a company A user cannot read a company B customer', () => {
    it('returns 404', async () => {
      await request(http)
        .get(`/api/v1/probe/customers/${world.companyB.customerId}`)
        .set(bearer(tokenA))
        .expect(404);
    });

    it('reads its own customer', async () => {
      const res = await request(http)
        .get(`/api/v1/probe/customers/${world.companyA.customerId}`)
        .set(bearer(tokenA))
        .expect(200);
      expect(res.body.companyId).toBe(world.companyA.id);
    });
  });

  // -------------------------------------------------------------------------
  // Test 6 — payments
  // -------------------------------------------------------------------------
  describe('Test 6: a company A user cannot read a company B payment', () => {
    it('returns 404', async () => {
      await request(http)
        .get(`/api/v1/probe/payments/${world.companyB.paymentId}`)
        .set(bearer(tokenA))
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Test 7 — reports
  // -------------------------------------------------------------------------
  describe('Test 7: a company A user cannot see company B in a report', () => {
    it('aggregates only over its own company', async () => {
      // Both companies have exactly one appointment and one payment, so an
      // unscoped aggregate would return 2 and this assertion would catch it.
      const res = await request(http)
        .get('/api/v1/probe/reports/revenue')
        .set(bearer(tokenA))
        .expect(200);

      expect(res.body.companyId).toBe(world.companyA.id);
      expect(res.body.appointments).toBe(1);
      expect(res.body.payments).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Nested resource attack
  // -------------------------------------------------------------------------
  describe('nested resource attack', () => {
    it('GET /companies/<company-B>/probe/appointments is 404 for a company A user', async () => {
      await request(http)
        .get(`/api/v1/companies/${world.companyB.id}/probe/appointments`)
        .set(bearer(tokenA))
        .expect(404);
    });

    it('the same route works for the company the caller belongs to', async () => {
      const res = await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/probe/appointments`)
        .set(bearer(tokenA))
        .expect(200);
      expect(res.body.companyId).toBe(world.companyA.id);
    });

    it('an X-Company-Id header for another company is also 404', async () => {
      await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(tokenA))
        .set('X-Company-Id', world.companyB.id)
        .expect(404);
    });

    it('a route param and a header naming different companies is a 400, not a guess', async () => {
      const res = await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/probe/appointments`)
        .set(bearer(tokenA))
        .set('X-Company-Id', world.companyB.id)
        .expect(400);

      expect(res.body.error.code).toBe('TENANT_AMBIGUOUS');
    });
  });

  // -------------------------------------------------------------------------
  // Test 8 — multiple memberships
  // -------------------------------------------------------------------------
  describe('Test 8: a user in both companies can switch between them', () => {
    it('lists both memberships', async () => {
      const token = await harness.staffToken(world.userAB.email);
      const res = await request(http).get('/api/v1/auth/me').set(bearer(token)).expect(200);

      expect(res.body.memberships).toHaveLength(2);
      expect(res.body.memberships.map((m: { companySlug: string }) => m.companySlug).sort()).toEqual(
        ['company-a', 'company-b'],
      );
    });

    it('sees only company A data while active in A, and only B while active in B', async () => {
      const inA = await harness.staffTokenForCompany(world.userAB.email, world.companyA.id);
      const resA = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(inA))
        .expect(200);
      expect(resA.body.companyId).toBe(world.companyA.id);
      expect(resA.body.items).toHaveLength(1);
      expect(resA.body.items[0].id).toBe(world.companyA.appointmentId);

      const inB = await harness.staffTokenForCompany(world.userAB.email, world.companyB.id);
      const resB = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(inB))
        .expect(200);
      expect(resB.body.companyId).toBe(world.companyB.id);
      expect(resB.body.items[0].id).toBe(world.companyB.appointmentId);
    });

    it('cannot switch to a company it does not belong to', async () => {
      const token = await harness.staffToken(world.userA.email);
      await request(http)
        .post('/api/v1/auth/switch-company')
        .set(bearer(token))
        .send({ companyId: world.companyB.id })
        .expect(404);
    });

    it('retires the previous session so the old token cannot be replayed', async () => {
      const before = await harness.staffTokenForCompany(world.userAB.email, world.companyA.id);
      await request(http).get('/api/v1/probe/appointments').set(bearer(before)).expect(200);

      const claims = JSON.parse(
        Buffer.from(before.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { sub: string; sid: string };

      await request(http)
        .post('/api/v1/auth/switch-company')
        .set(bearer(before))
        .send({ companyId: world.companyB.id })
        .expect(200);

      await request(http).get('/api/v1/probe/appointments').set(bearer(before)).expect(401);
      expect(claims.sid).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Test 9 — platform admin
  // -------------------------------------------------------------------------
  describe('Test 9: a platform operator can deliberately reach both companies', () => {
    it('reads company A and company B when each is named explicitly', async () => {
      const token = await harness.platformToken(world.operator.email);

      const resA = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(token))
        .set('X-Company-Id', world.companyA.id)
        .expect(200);
      expect(resA.body.items[0].id).toBe(world.companyA.appointmentId);

      const resB = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(token))
        .set('X-Company-Id', world.companyB.id)
        .expect(200);
      expect(resB.body.items[0].id).toBe(world.companyB.appointmentId);
    });

    it('sees ONE company at a time, never a union', async () => {
      // The property that separates "platform access" from "no isolation":
      // an operator is scoped to exactly one company per request.
      const token = await harness.platformToken(world.operator.email);
      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(token))
        .set('X-Company-Id', world.companyA.id)
        .expect(200);

      expect(res.body.items).toHaveLength(1);
    });

    it('is refused when it does not name a company — access is never implicit', async () => {
      const token = await harness.platformToken(world.operator.email);
      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(token))
        .expect(400);

      expect(res.body.error.code).toBe('PLATFORM_ACCESS_NOT_TARGETED');
    });

    it('is refused on a route that has not opted in to platform access', async () => {
      const token = await harness.platformToken(world.operator.email);
      await request(http)
        .get(`/api/v1/probe/customers/${world.companyA.customerId}`)
        .set(bearer(token))
        .set('X-Company-Id', world.companyA.id)
        .expect(400);
    });

    it('an operator without the data permission gets nothing', async () => {
      const token = await harness.platformToken(world.weakOperator.email);
      await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(token))
        .set('X-Company-Id', world.companyA.id)
        .expect(404);
    });

    it('a company user cannot reach the platform realm, however privileged', async () => {
      // Company roles and platform roles are separate catalogs; no amount of
      // escalation inside a tenant produces a platform permission.
      await request(http)
        .post('/api/v1/platform/auth/logout')
        .set(bearer(tokenA))
        .expect(401);
    });

    it('a platform token is rejected by staff routes on audience alone', async () => {
      const token = await harness.platformToken(world.operator.email);
      await request(http).post('/api/v1/auth/switch-company').set(bearer(token)).send({}).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Test 10 — background jobs
  // -------------------------------------------------------------------------
  describe('Test 10: a background job cannot operate on another company', () => {
    it('scopes the job to the company in its payload', async () => {
      const runner = harness.app.get(TenantJobRunner);
      const context = harness.app.get(RequestContextService);

      const job: TenantJob = { name: 'probe-job', data: { companyId: world.companyA.id } };

      const visible = await runner.run(job, async (_payload, ctx) =>
        ctx.withTransaction((tx) => tx.appointment.findMany({ where: { companyId: ctx.companyId } })),
      );

      expect(visible).toHaveLength(1);
      expect(visible[0]?.id).toBe(world.companyA.appointmentId);
      expect(context.tenantOrNull()).toBeNull();
    });

    it('cannot read another company even when the handler asks for it by id', async () => {
      // RLS is the backstop here: the handler explicitly requests company B's
      // appointment while running in company A's context, and the database
      // returns nothing.
      const runner = harness.app.get(TenantJobRunner);
      const job: TenantJob = { name: 'probe-job', data: { companyId: world.companyA.id } };

      const leaked = await runner.run(job, async (_payload, ctx) =>
        ctx.withTransaction((tx) =>
          tx.appointment.findFirst({
            where: { companyId: world.companyB.id, id: world.companyB.appointmentId },
          }),
        ),
      );

      expect(leaked).toBeNull();
    });

    it('refuses a payload with no company rather than running unscoped', async () => {
      const runner = harness.app.get(TenantJobRunner);
      const job = { name: 'probe-job', data: {} } as unknown as TenantJob;

      await expect(runner.run(job, async () => 'ran')).rejects.toMatchObject({
        code: 'JOB_TENANT_MISSING',
      });
    });

    it('refuses when a loaded entity belongs to a different company', async () => {
      const runner = harness.app.get(TenantJobRunner);
      const job: TenantJob = { name: 'probe-job', data: { companyId: world.companyA.id } };

      await expect(
        runner.run(job, async (_payload, ctx) => {
          ctx.assertBelongsToCompany('Appointment', { companyId: world.companyB.id });
          return 'ran';
        }),
      ).rejects.toMatchObject({ code: 'JOB_TENANT_MISMATCH' });
    });
  });

  // -------------------------------------------------------------------------
  // Test 11 — missing tenant context
  // -------------------------------------------------------------------------
  describe('Test 11: a missing tenant context fails safely', () => {
    it('errors instead of returning unscoped rows', async () => {
      // The route opts out of the tenant guard and then asks for the tenant
      // anyway — the mistake made by a developer who adds @NoTenant() to
      // silence an error. It must break, not widen.
      const res = await request(http)
        .get('/api/v1/probe/missing-context/appointments')
        .set(bearer(tokenA))
        .expect(500);

      expect(res.body.error.code).toBe('TENANT_CONTEXT_MISSING');
      // The internal message names models and query shapes; it must not leak.
      expect(res.body.error.message).toBe('Internal server error.');
      expect(JSON.stringify(res.body)).not.toContain(world.companyB.appointmentId);
    });

    it('an unauthenticated call to a company-scoped route is 401, not unscoped data', async () => {
      await request(http).get('/api/v1/probe/appointments').expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Test 12 — invalid membership
  // -------------------------------------------------------------------------
  describe('Test 12: an invalid membership is refused', () => {
    it('a revoked membership stops working', async () => {
      const token = await harness.staffTokenForCompany(world.userAB.email, world.companyB.id);
      await request(http).get('/api/v1/probe/appointments').set(bearer(token)).expect(200);

      await harness.prisma.companyUser.updateMany({
        where: { companyId: world.companyB.id, userAccountId: world.userAB.id },
        data: { deletedAt: new Date() },
      });
      // The membership cache is per company+user; clear it so the test measures
      // enforcement rather than TTL.
      harness.app.get(MembershipService).invalidateUser(world.companyB.id, world.userAB.id);

      await request(http).get('/api/v1/probe/appointments').set(bearer(token)).expect(404);
    });

    it('an invited-but-not-active membership is refused distinctly', async () => {
      await harness.prisma.companyUser.updateMany({
        where: { companyId: world.companyA.id, userAccountId: world.userA.id },
        data: { status: 'INVITED' },
      });
      harness.app.get(MembershipService).invalidateUser(world.companyA.id, world.userA.id);

      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(tokenA))
        .expect(403);

      expect(res.body.error.code).toBe('MEMBERSHIP_INACTIVE');
    });

    it('a suspended company is refused with a distinct code', async () => {
      await harness.prisma.company.update({
        where: { id: world.companyA.id },
        data: { status: 'SUSPENDED' },
      });
      harness.app.get(TenantDirectoryService).invalidateAll();

      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(tokenA))
        .expect(403);

      expect(res.body.error.code).toBe('TENANT_SUSPENDED');
    });

    it('a user with no memberships at all gets a token but reaches no company', async () => {
      const orphan = await harness.prisma.userAccount.create({
        data: {
          email: 'orphan@example.com',
          fullName: 'Orphan',
          passwordHash: (
            await harness.prisma.userAccount.findUniqueOrThrow({
              where: { email: world.userA.email },
              select: { passwordHash: true },
            })
          ).passwordHash,
          status: 'ACTIVE',
        },
      });

      const token = await harness.staffToken(orphan.email);
      const res = await request(http)
        .get('/api/v1/probe/appointments')
        .set(bearer(token))
        .expect(400);

      expect(res.body.error.code).toBe('TENANT_UNRESOLVED');
    });
  });
});

