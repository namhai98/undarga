import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { CompanyProvisioningService } from '../src/platform/companies/company-provisioning.service';
import { syncPlanCatalog } from '../src/subscriptions/plan-catalog';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * COMPANY ONBOARDING
 * ===========================================================================
 *
 * Self-serve: a signed-in account with no company creates one (steps 1-3, one
 * transaction), then adds services or skips (step 4) and finishes.
 * Provisioned: an operator creates the company, its owner finishes steps 2-3
 * through `setup`, then the same finish.
 */
describe('onboarding', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let unique = 0;

  const as = (token?: string) => {
    const auth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
    return {
      get: (path: string) => auth(request(http).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => auth(request(http).post(`/api/v1${path}`)).send(body),
    };
  };

  const slug = (label = 'co') => `onb-${label}-${Date.now().toString(36)}-${unique++}`;

  const companyBody = (companySlug: string, overrides: Record<string, unknown> = {}) => ({
    company: { displayName: 'Nomin Spa', slug: companySlug },
    branch: {
      name: 'Central',
      timezoneName: 'Europe/Berlin',
      phone: '+97699112233',
      addressLine1: 'Peace Avenue 1',
      city: 'Ulaanbaatar',
    },
    business: {
      currencyCode: 'USD',
      contactEmail: 'Hello@Nomin.test',
      registrationNumber: 'REG-1',
      businessHours: [
        { dayOfWeek: 1, isClosed: false, opensAt: '09:00', closesAt: '18:00' },
        { dayOfWeek: 2, isClosed: false, opensAt: '09:00', closesAt: '18:00' },
        { dayOfWeek: 0, isClosed: true },
      ],
    },
    ...overrides,
  });

  /** A signed-in account that belongs to no company. */
  async function freshAccount(label: string) {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `onb-${label}-${Date.now()}-${unique++}@example.com`,
        fullName: `Founder ${label}`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    return { id: account.id, email: account.email, token: await harness.staffToken(account.email) };
  }

  /** Create a company through onboarding and return its id and the owner's token in it. */
  async function onboard(label: string) {
    const founder = await freshAccount(label);
    const res = await as(founder.token).post('/onboarding/company', companyBody(slug(label)));
    expect(res.status).toBe(201);
    const companyId = res.body.data.company.id as string;
    const token = await harness.staffTokenForCompany(founder.email, companyId);
    return { founder, companyId, token, data: res.body.data };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    await syncPlanCatalog(harness.prisma);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('unauthorized access', () => {
    it('refuses an anonymous caller on every route', async () => {
      await as().post('/onboarding/company', companyBody(slug())).expect(401);
      await as().get('/onboarding/status').expect(401);
      await as().get('/onboarding/slug-availability?slug=abc').expect(401);
      await as().post(`/onboarding/companies/${world.companyA.id}/complete`).expect(401);
    });

    it('refuses a platform token — operators do not onboard, and are not gated by it', async () => {
      const operator = await harness.platformToken(world.platformAdmin.email);
      const target = slug('platform');
      await as(operator).post('/onboarding/company', companyBody(target)).expect(401);
      await as(operator).get('/onboarding/status').expect(401);
      expect(await harness.prisma.company.count({ where: { slug: target } })).toBe(0);

      // And the console keeps working whatever any company's onboarding state is.
      await as(operator).get('/platform/companies').expect(200);
    });
  });

  // ===========================================================================
  describe('successful onboarding', () => {
    it('creates the company, owner membership, first branch, hours and trial together', async () => {
      const founder = await freshAccount('ok');
      const companySlug = slug('ok');

      const res = await as(founder.token)
        .post('/onboarding/company', companyBody(companySlug))
        .expect(201);
      const data = res.body.data;
      const companyId = data.company.id as string;

      expect(data.company).toMatchObject({
        slug: companySlug,
        displayName: 'Nomin Spa',
        legalName: 'Nomin Spa',
        status: 'ACTIVE',
        // Step 2's timezone is the company's; step 3's currency.
        defaultTimezoneName: 'Europe/Berlin',
        currencyCode: 'USD',
      });
      expect(data.onboarding).toEqual({ status: 'IN_PROGRESS', nextStep: 'SERVICES' });

      const company = await harness.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      expect(company.onboardingStatus).toBe('IN_PROGRESS');
      expect(company.contactEmail).toBe('hello@nomin.test');
      expect(company.registrationNumber).toBe('REG-1');
      expect(await harness.prisma.companySettings.count({ where: { companyId } })).toBe(1);
    });

    it('makes the caller the ACTIVE owner, with the OWNER role', async () => {
      const { founder, companyId, data } = await onboard('owner');

      const memberships = await harness.prisma.companyUser.findMany({
        where: { companyId },
        include: { roles: { include: { role: true } } },
      });
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        userAccountId: founder.id,
        isOwner: true,
        status: 'ACTIVE',
      });
      expect(memberships[0]!.joinedAt).not.toBeNull();
      expect(memberships[0]!.roles.map((r) => r.role.key)).toEqual([SYSTEM_ROLES.OWNER]);
      expect(data.membership).toMatchObject({ isOwner: true, status: 'ACTIVE' });

      // The six system roles exist, exactly as provisioning creates them.
      const roles = await harness.prisma.companyRole.findMany({ where: { companyId } });
      expect(roles.map((r) => r.key).sort()).toEqual(Object.values(SYSTEM_ROLES).sort());
    });

    it('creates the first branch with its address and a full week of hours', async () => {
      const { companyId, data } = await onboard('branch');

      const branches = await harness.prisma.branch.findMany({ where: { companyId } });
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({
        id: data.branch.id,
        code: 'MAIN',
        name: 'Central',
        timezoneName: 'Europe/Berlin',
        phone: '+97699112233',
        addressLine1: 'Peace Avenue 1',
        city: 'Ulaanbaatar',
      });

      const hours = await harness.prisma.businessHours.findMany({
        where: { companyId, branchId: branches[0]!.id },
        orderBy: { dayOfWeek: 'asc' },
      });
      // All seven days are written; the ones not given are closed.
      expect(hours).toHaveLength(7);
      expect(hours.filter((h) => !h.isClosed).map((h) => h.dayOfWeek)).toEqual([1, 2]);
    });

    it('starts the default plan trial using the subscription logic', async () => {
      const { companyId, data } = await onboard('trial');

      const subscription = await harness.prisma.subscription.findUniqueOrThrow({
        where: { companyId },
        include: { plan: true },
      });
      expect(subscription.status).toBe('TRIAL');
      expect(subscription.plan.key).toBe('PRO');
      const days = (subscription.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);
      expect(data.subscription).toMatchObject({ status: 'TRIAL', planKey: 'PRO' });
    });

    it('lets the new owner switch in and work in the company', async () => {
      const { companyId, token } = await onboard('switch');

      const branches = await as(token).get(`/companies/${companyId}/branches`).expect(200);
      expect(branches.body.data.items).toHaveLength(1);

      const subscription = await as(token).get(`/companies/${companyId}/subscription`).expect(200);
      expect(subscription.body.data.subscription.status).toBe('TRIAL');
    });

    it('audits the creation in the new company', async () => {
      const { founder, companyId } = await onboard('audit');

      const row = await harness.prisma.auditLog.findFirstOrThrow({
        where: { companyId, action: 'onboarding.company_created' },
      });
      expect(row.actorId).toBe(founder.id);
      expect(row.resourceId).toBe(companyId);
    });
  });

  // ===========================================================================
  describe('initial services and completion', () => {
    it('creates services with categories, offers them at the branch, and completes', async () => {
      const { companyId, token, data } = await onboard('services');

      const res = await as(token)
        .post(`/onboarding/companies/${companyId}/complete`, {
          services: [
            { name: 'Haircut', category: 'Hair', durationMin: 45, priceMinor: '3500000' },
            { name: 'Colouring', category: 'hair', durationMin: 120, priceMinor: '9000000' },
            { name: 'Massage', durationMin: 60, priceMinor: '5000000', isActive: false },
          ],
        })
        .expect(200);

      expect(res.body.data.onboarding.status).toBe('COMPLETED');
      expect(res.body.data.services).toHaveLength(3);

      const services = await harness.prisma.service.findMany({
        where: { companyId },
        orderBy: { name: 'asc' },
        include: { branches: true },
      });
      expect(services.map((s) => [s.name, s.status, s.priceMinor.toString(), s.currencyCode])).toEqual([
        ['Colouring', 'ACTIVE', '9000000', 'USD'],
        ['Haircut', 'ACTIVE', '3500000', 'USD'],
        ['Massage', 'INACTIVE', '5000000', 'USD'],
      ]);
      for (const service of services) {
        expect(service.branches.map((b) => b.branchId)).toEqual([data.branch.id]);
      }

      // "Hair" and "hair" are one category.
      const categories = await harness.prisma.serviceCategory.findMany({ where: { companyId } });
      expect(categories.map((c) => c.name)).toEqual(['Hair']);
      expect(services.find((s) => s.name === 'Massage')!.categoryId).toBeNull();

      const company = await harness.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      expect(company.onboardingStatus).toBe('COMPLETED');
      expect(company.onboardingCompletedAt).not.toBeNull();
    });

    it('lets the services step be skipped', async () => {
      const { companyId, token } = await onboard('skip');

      const res = await as(token).post(`/onboarding/companies/${companyId}/complete`, {}).expect(200);
      expect(res.body.data.services).toEqual([]);
      expect(res.body.data.onboarding.status).toBe('COMPLETED');
      expect(await harness.prisma.service.count({ where: { companyId } })).toBe(0);
    });

    it('is all-or-nothing: an invalid service creates none and leaves it IN_PROGRESS', async () => {
      const { companyId, token } = await onboard('svc-bad');

      await as(token)
        .post(`/onboarding/companies/${companyId}/complete`, {
          services: [
            { name: 'Fine', durationMin: 30, priceMinor: '100' },
            { name: 'Fine', durationMin: 30, priceMinor: '100' },
          ],
        })
        .expect(400);

      expect(await harness.prisma.service.count({ where: { companyId } })).toBe(0);
      const company = await harness.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      expect(company.onboardingStatus).toBe('IN_PROGRESS');
    });

    it('refuses to complete twice', async () => {
      const { companyId, token } = await onboard('twice');
      await as(token).post(`/onboarding/companies/${companyId}/complete`, {}).expect(200);
      const again = await as(token)
        .post(`/onboarding/companies/${companyId}/complete`, {
          services: [{ name: 'Late', durationMin: 30, priceMinor: '100' }],
        })
        .expect(409);
      expect(again.body.error.code).toBe('CONFLICT');
      expect(await harness.prisma.service.count({ where: { companyId } })).toBe(0);
    });
  });

  // ===========================================================================
  describe('validation', () => {
    it('refuses a taken slug with 409 and creates nothing', async () => {
      const founder = await freshAccount('dup');
      const before = await harness.prisma.company.count();

      const res = await as(founder.token)
        .post('/onboarding/company', companyBody(world.companyA.slug))
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details).toMatchObject({ field: 'slug' });

      expect(await harness.prisma.company.count()).toBe(before);
      expect(await harness.prisma.companyUser.count({ where: { userAccountId: founder.id } })).toBe(0);
    });

    it('refuses a reserved or malformed slug', async () => {
      const founder = await freshAccount('reserved');
      await as(founder.token).post('/onboarding/company', companyBody('admin')).expect(400);
      await as(founder.token).post('/onboarding/company', companyBody('Bad Slug')).expect(400);
    });

    it('validates name, timezone, currency, branch and owner email fields', async () => {
      const founder = await freshAccount('fields');
      const base = companyBody(slug('fields'));

      const cases: object[] = [
        { ...base, company: { ...base.company, displayName: ' ' } },
        { ...base, branch: { ...base.branch, name: '' } },
        { ...base, branch: { ...base.branch, email: 'not-an-email' } },
        { ...base, business: { ...base.business, currencyCode: 'usd' } },
        { ...base, business: { ...base.business, contactEmail: 'nope' } },
        {
          ...base,
          business: {
            ...base.business,
            businessHours: [{ dayOfWeek: 1, isClosed: false, opensAt: '09:00' }],
          },
        },
      ];
      for (const body of cases) {
        await as(founder.token).post('/onboarding/company', body).expect(400);
      }

      // Well-formed but unknown: checked against the reference tables.
      const unknownTz = await as(founder.token)
        .post('/onboarding/company', { ...base, branch: { ...base.branch, timezoneName: 'Mars/Base' } })
        .expect(400);
      expect(unknownTz.body.error.code).toBe('VALIDATION_FAILED');
      await as(founder.token)
        .post('/onboarding/company', { ...base, business: { ...base.business, currencyCode: 'XYZ' } })
        .expect(400);

      expect(await harness.prisma.companyUser.count({ where: { userAccountId: founder.id } })).toBe(0);
    });

    it('reports slug availability for the form', async () => {
      const founder = await freshAccount('avail');
      const taken = await as(founder.token)
        .get(`/onboarding/slug-availability?slug=${world.companyA.slug}`)
        .expect(200);
      expect(taken.body.data).toMatchObject({ available: false });

      const free = await as(founder.token)
        .get(`/onboarding/slug-availability?slug=${slug('free')}`)
        .expect(200);
      expect(free.body.data).toMatchObject({ available: true, reason: null });

      const reserved = await as(founder.token)
        .get('/onboarding/slug-availability?slug=platform')
        .expect(200);
      expect(reserved.body.data.available).toBe(false);
      expect(reserved.body.data.reason).toMatch(/reserved/);
    });
  });

  // ===========================================================================
  describe('owner email handling', () => {
    it('never lets a body name the owner', async () => {
      const founder = await freshAccount('named');
      const victim = world.userB.email;
      const target = slug('named');

      await as(founder.token)
        .post('/onboarding/company', {
          ...companyBody(target),
          owner: { email: victim, fullName: 'Someone else' },
        })
        .expect(400);
      expect(await harness.prisma.company.count({ where: { slug: target } })).toBe(0);
    });

    it('reuses an account that already belongs to a company — no duplicate user', async () => {
      // User A is a non-owner member of Company A.
      const token = await harness.staffToken(world.userA.email);
      const res = await as(token).post('/onboarding/company', companyBody(slug('second'))).expect(201);
      const companyId = res.body.data.company.id as string;

      expect(await harness.prisma.userAccount.count({ where: { email: world.userA.email } })).toBe(1);

      const memberships = await harness.prisma.companyUser.findMany({
        where: { userAccountId: world.userA.id },
        select: { companyId: true, isOwner: true },
      });
      expect(memberships).toEqual(
        expect.arrayContaining([
          { companyId: world.companyA.id, isOwner: false },
          { companyId, isOwner: true },
        ]),
      );
    });

    it('caps how many companies one account may own', async () => {
      const founder = await freshAccount('cap');
      const provisioning = harness.app.get(CompanyProvisioningService);
      // Ten owned companies, made directly so the test is about the cap.
      for (let i = 0; i < 10; i++) {
        await provisioning.createForAccount(
          {
            slug: slug(`cap${i}`),
            displayName: `Cap ${i}`,
            legalName: `Cap ${i}`,
            defaultTimezoneName: 'UTC',
            currencyCode: 'USD',
          },
          founder.id,
          async () => undefined,
        );
      }

      const res = await as(founder.token)
        .post('/onboarding/company', companyBody(slug('cap-over')))
        .expect(409);
      expect(res.body.error.details).toMatchObject({ owned: 10 });
    });
  });

  // ===========================================================================
  describe('transaction rollback', () => {
    it('leaves nothing behind when a step inside the transaction fails', async () => {
      const founder = await freshAccount('rollback');
      const target = slug('rollback');
      const counts = async () => ({
        companies: await harness.prisma.company.count(),
        branches: await harness.prisma.branch.count(),
        hours: await harness.prisma.businessHours.count(),
        roles: await harness.prisma.companyRole.count(),
        memberships: await harness.prisma.companyUser.count(),
        subscriptions: await harness.prisma.subscription.count(),
        settings: await harness.prisma.companySettings.count(),
      });
      const before = await counts();

      // Fail AFTER every write — company, settings, trial, roles, owner, branch
      // and hours — so the assertion covers all of them.
      const provisioning = harness.app.get(CompanyProvisioningService);
      const original = provisioning.createForAccount.bind(provisioning);
      jest
        .spyOn(provisioning, 'createForAccount')
        .mockImplementation((input, userAccountId, setup) =>
          original(input, userAccountId, async (tx, companyId) => {
            await setup(tx, companyId);
            expect(await tx.branch.count({ where: { companyId } })).toBe(1);
            throw new Error('Simulated failure after the branch was written');
          }),
        );

      await as(founder.token).post('/onboarding/company', companyBody(target)).expect(500);

      expect(await counts()).toEqual(before);
      expect(await harness.prisma.company.count({ where: { slug: target } })).toBe(0);
    });

    it('rolls back when the owner account turns out to be unusable', async () => {
      const founder = await freshAccount('disabled');
      const target = slug('disabled');
      await harness.prisma.userAccount.update({
        where: { id: founder.id },
        data: { status: 'DISABLED' },
      });

      const res = await as(founder.token).post('/onboarding/company', companyBody(target));
      expect(res.status).not.toBe(201);
      expect(await harness.prisma.company.count({ where: { slug: target } })).toBe(0);
    });
  });

  // ===========================================================================
  describe('onboarding status', () => {
    it('reports NOT_STARTED with no company for an account that has none', async () => {
      const founder = await freshAccount('status-none');
      const res = await as(founder.token).get('/onboarding/status').expect(200);
      expect(res.body.data).toMatchObject({
        status: 'NOT_STARTED',
        company: null,
        nextStep: 'COMPANY',
        canManage: true,
      });
    });

    it('follows the company through IN_PROGRESS to COMPLETED', async () => {
      const { companyId, token } = await onboard('status');

      const during = await as(token).get('/onboarding/status').expect(200);
      expect(during.body.data).toMatchObject({
        status: 'IN_PROGRESS',
        company: { id: companyId },
        steps: { company: true, branch: true, businessSettings: true, services: false },
        nextStep: 'SERVICES',
        canManage: true,
        completedAt: null,
      });

      await as(token)
        .post(`/onboarding/companies/${companyId}/complete`, {
          services: [{ name: 'Cut', durationMin: 30, priceMinor: '100' }],
        })
        .expect(200);

      const after = await as(token).get(`/onboarding/status?companyId=${companyId}`).expect(200);
      expect(after.body.data).toMatchObject({
        status: 'COMPLETED',
        steps: { services: true },
        nextStep: null,
      });
      expect(after.body.data.completedAt).not.toBeNull();
    });

    it('reports seeded, fully set-up companies as COMPLETED', async () => {
      const token = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
      const res = await as(token).get('/onboarding/status').expect(200);
      expect(res.body.data).toMatchObject({ status: 'COMPLETED', company: { id: world.companyB.id } });
    });

    it('says when the caller cannot finish the wizard', async () => {
      const { companyId } = await onboard('status-rbac');
      const staff = await freshAccount('receptionist');
      const membership = await harness.prisma.companyUser.create({
        data: { companyId, userAccountId: staff.id, status: 'ACTIVE', joinedAt: new Date() },
      });
      const role = await harness.prisma.companyRole.findFirstOrThrow({
        where: { companyId, key: SYSTEM_ROLES.RECEPTIONIST },
      });
      await harness.prisma.companyUserRole.create({
        data: { companyId, companyUserId: membership.id, roleId: role.id },
      });
      const token = await harness.staffTokenForCompany(staff.email, companyId);

      const res = await as(token).get('/onboarding/status').expect(200);
      expect(res.body.data).toMatchObject({ status: 'IN_PROGRESS', canManage: false });

      // And the API agrees: company RBAC applies to the onboarding writes.
      const denied = await as(token).post(`/onboarding/companies/${companyId}/complete`, {}).expect(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    });
  });

  // ===========================================================================
  describe('operator-provisioned companies', () => {
    async function provisioned(label: string) {
      const owner = await freshAccount(label);
      const provisioner = await harness.platformToken(world.provisioner.email);
      const res = await as(provisioner)
        .post('/platform/companies', {
          slug: slug(label),
          legalName: 'Provisioned LLC',
          displayName: 'Provisioned',
          defaultTimezoneName: 'Asia/Ulaanbaatar',
          currencyCode: 'MNT',
          // An existing active account is a member straight away.
          owner: { email: owner.email, fullName: 'Prov Owner' },
        })
        .expect(201);
      const companyId = res.body.data.company.id as string;
      return { companyId, token: await harness.staffTokenForCompany(owner.email, companyId) };
    }

    const setupBody = {
      company: { displayName: 'Provisioned Salon' },
      branch: { name: 'Main', timezoneName: 'Asia/Ulaanbaatar' },
      business: { currencyCode: 'MNT', contactPhone: '+97611223344' },
    };

    it('starts NOT_STARTED and is guided to the branch step', async () => {
      const { companyId, token } = await provisioned('prov-status');
      const res = await as(token).get('/onboarding/status').expect(200);
      expect(res.body.data).toMatchObject({
        status: 'NOT_STARTED',
        company: { id: companyId, status: 'PENDING_SETUP' },
        steps: { branch: false, businessSettings: false },
        nextStep: 'BRANCH',
      });
    });

    it('cannot complete before setup', async () => {
      const { companyId, token } = await provisioned('prov-early');
      await as(token).post(`/onboarding/companies/${companyId}/complete`, {}).expect(409);
    });

    it('sets up the branch and business, activates the company, then completes', async () => {
      const { companyId, token } = await provisioned('prov-setup');

      const setup = await as(token)
        .post(`/onboarding/companies/${companyId}/setup`, setupBody)
        .expect(200);
      expect(setup.body.data.onboarding.status).toBe('IN_PROGRESS');

      const company = await harness.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      expect(company).toMatchObject({
        displayName: 'Provisioned Salon',
        status: 'ACTIVE',
        onboardingStatus: 'IN_PROGRESS',
        contactPhone: '+97611223344',
      });
      expect(await harness.prisma.branch.count({ where: { companyId } })).toBe(1);

      await as(token).post(`/onboarding/companies/${companyId}/setup`, setupBody).expect(409);
      await as(token).post(`/onboarding/companies/${companyId}/complete`, {}).expect(200);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('another company’s member cannot set up, complete or read its onboarding', async () => {
      const { companyId } = await onboard('iso');
      const outsider = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

      const complete = await as(outsider)
        .post(`/onboarding/companies/${companyId}/complete`, {
          services: [{ name: 'Injected', durationMin: 30, priceMinor: '1' }],
        })
        .expect(404);
      expect(complete.body.error.code).toBe('TENANT_NOT_FOUND');
      await as(outsider)
        .post(`/onboarding/companies/${companyId}/setup`, {
          company: { displayName: 'Hijacked' },
          branch: { name: 'X', timezoneName: 'UTC' },
          business: { currencyCode: 'USD' },
        })
        .expect(404);
      await as(outsider).get(`/onboarding/status?companyId=${companyId}`).expect(404);

      expect(await harness.prisma.service.count({ where: { companyId } })).toBe(0);
      const company = await harness.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      expect(company.onboardingStatus).toBe('IN_PROGRESS');
    });

    it('a new owner gains access to their company only', async () => {
      const { companyId, token } = await onboard('iso-owner');

      // Their token for the new company cannot reach Company A.
      await as(token).get(`/companies/${world.companyA.id}/branches`).expect(404);
      await as(token).get(`/onboarding/status?companyId=${world.companyA.id}`).expect(404);

      // And Company A's members see nothing of the new company.
      const memberA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
      await as(memberA).get(`/companies/${companyId}/branches`).expect(404);

      // The only membership the founder holds is the new one.
      const res = await as(token).get('/auth/me').expect(200);
      expect(res.body.data.memberships.map((m: { companyId: string }) => m.companyId)).toEqual([
        companyId,
      ]);
    });
  });
});
