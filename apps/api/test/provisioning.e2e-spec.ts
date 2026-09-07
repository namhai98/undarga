import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * COMPANY PROVISIONING
 * ===========================================================================
 *
 * Exercised end to end against a real PostgreSQL with RLS applied, because the
 * two properties that matter most here — atomicity and the owner relationship —
 * are properties of the database, not of the service. A mocked Prisma client
 * would happily "roll back" a transaction that never existed.
 */
describe('company provisioning', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let token: string;

  const validBody = () => ({
    slug: `acme-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    legalName: 'Acme Salons LLC',
    displayName: 'Acme Salons',
    defaultTimezoneName: 'Asia/Ulaanbaatar',
    currencyCode: 'MNT',
    owner: { email: `owner-${Date.now()}-${Math.random()}@example.com`, fullName: 'Ada Owner' },
  });

  const provision = (body: object, bearer = token) =>
    request(http)
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    token = await harness.platformToken(world.provisioner.email);
  });

  afterAll(async () => {
    await harness.close();
  });

  // -------------------------------------------------------------------------
  describe('the happy path', () => {
    it('creates the company, its settings, six system roles and the owner', async () => {
      const body = validBody();
      const res = await provision(body).expect(201);

      const { company, owner, roles } = res.body.data;

      expect(company).toMatchObject({
        slug: body.slug,
        legalName: body.legalName,
        displayName: body.displayName,
        // Not ACTIVE: nothing can be booked until setup is done.
        status: 'PENDING_SETUP',
        currencyCode: 'MNT',
      });
      expect(company.id).toEqual(expect.any(String));

      expect(roles).toHaveLength(Object.keys(SYSTEM_ROLES).length);
      expect(roles.map((r: { key: string }) => r.key).sort()).toEqual(
        Object.values(SYSTEM_ROLES).sort(),
      );
      expect(roles.every((r: { isSystem: boolean }) => r.isSystem)).toBe(true);

      // Settings must exist, or every booking-policy read later returns null.
      const settings = await harness.prisma.companySettings.findUnique({
        where: { companyId: company.id },
      });
      expect(settings).not.toBeNull();
      expect(settings?.slotGranularityMin).toBe(15);

      expect(owner.email).toBe(body.owner.email);
    });

    it('makes the owner an owner, with the OWNER role attached', async () => {
      const res = await provision(validBody()).expect(201);
      const { company, owner } = res.body.data;

      const membership = await harness.prisma.companyUser.findUnique({
        where: { id: owner.companyUserId },
        include: { roles: { include: { role: true } } },
      });

      expect(membership).toMatchObject({
        companyId: company.id,
        userAccountId: owner.userAccountId,
        isOwner: true,
      });
      expect(membership?.roles).toHaveLength(1);
      expect(membership?.roles[0]?.role.key).toBe(SYSTEM_ROLES.OWNER);
      // The role granted must belong to the new company, not to another tenant.
      expect(membership?.roles[0]?.role.companyId).toBe(company.id);
    });

    it('leaves a brand-new owner unable to sign in until they are invited', async () => {
      const res = await provision(validBody()).expect(201);
      const { owner } = res.body.data;

      expect(owner).toMatchObject({
        status: 'INVITED',
        accountCreated: true,
        requiresInvitation: true,
      });

      // No password was set, so the account genuinely cannot authenticate —
      // the flag is not merely cosmetic.
      const account = await harness.prisma.userAccount.findUnique({
        where: { id: owner.userAccountId },
      });
      expect(account?.passwordHash).toBeNull();
      expect(account?.status).toBe('INVITED');
    });

    it('reuses an existing account and admits that owner immediately', async () => {
      // The consultant-with-three-salons case. Creating a second account for
      // the same address would split their identity permanently.
      const body = { ...validBody(), owner: { email: world.userA.email, fullName: 'User A' } };
      const res = await provision(body).expect(201);
      const { owner } = res.body.data;

      expect(owner).toMatchObject({
        userAccountId: world.userA.id,
        status: 'ACTIVE',
        accountCreated: false,
        requiresInvitation: false,
      });

      const accounts = await harness.prisma.userAccount.count({
        where: { email: world.userA.email },
      });
      expect(accounts).toBe(1);
    });

    it('grants the owner every company permission on their next sign-in', async () => {
      // Proves the seeded role rows are wired, not just present.
      const body = { ...validBody(), owner: { email: world.userA.email, fullName: 'User A' } };
      const res = await provision(body).expect(201);
      const companyId = res.body.data.company.id;

      const staff = await harness.staffTokenForCompany(world.userA.email, companyId);
      const context = await request(http)
        .get('/api/v1/me/context')
        .set('Authorization', `Bearer ${staff}`)
        .expect(200);

      expect(context.body.data.membership.isOwner).toBe(true);
      expect(context.body.data.permissions).toContain('member:invite');
      expect(context.body.data.permissions).toContain('settings:billing:write');
    });
  });

  // -------------------------------------------------------------------------
  describe('validation', () => {
    it.each([
      ['a missing slug', { slug: undefined }],
      ['an uppercase slug', { slug: 'AcmeSalons' }],
      ['a slug with spaces', { slug: 'acme salons' }],
      ['a slug that starts with a hyphen', { slug: '-acme' }],
      ['a slug shorter than three characters', { slug: 'ab' }],
      ['a reserved slug', { slug: 'admin' }],
      ['a blank display name', { displayName: '   ' }],
      ['a lowercase currency code', { currencyCode: 'mnt' }],
      ['a malformed owner email', { owner: { email: 'not-an-email', fullName: 'X' } }],
      ['a missing owner', { owner: undefined }],
    ])('rejects %s', async (_label, patch) => {
      const res = await provision({ ...validBody(), ...patch }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    // A reserved slug becomes a subdomain the moment the host resolver is
    // switched on, so `admin.booking.local` must never belong to a tenant.
    it('names the reserved slug as the reason', async () => {
      const res = await provision({ ...validBody(), slug: 'api' }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/reserved/i);
    });

    it('rejects an unknown timezone by name rather than failing on the foreign key', async () => {
      const res = await provision({
        ...validBody(),
        defaultTimezoneName: 'Mars/Olympus_Mons',
      }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).toMatch(/defaultTimezoneName/);
    });

    it('rejects an unknown currency the same way', async () => {
      const res = await provision({ ...validBody(), currencyCode: 'ZZZ' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).toMatch(/currencyCode/);
    });

    it('rejects a non-uuid id on read-back', async () => {
      await request(http)
        .get('/api/v1/platform/companies/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('authentication and authorization', () => {
    it('refuses an anonymous request', async () => {
      await request(http).post('/api/v1/platform/companies').send(validBody()).expect(401);
    });

    it('refuses a staff token — wrong audience, checked before any permission', async () => {
      const staff = await harness.staffToken(world.userA.email);
      const res = await provision(validBody(), staff).expect(401);
      expect(res.body.error.code).toBe('TOKEN_AUDIENCE_MISMATCH');
    });

    it('refuses an operator who may read every tenant but not create one', async () => {
      // `operator` holds company:data:read AND :write across all tenants, so
      // this asserts that broad data access is not creeping into provisioning.
      const support = await harness.platformToken(world.operator.email);
      const res = await provision(validBody(), support).expect(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('refuses an operator with an unrelated permission', async () => {
      const billing = await harness.platformToken(world.weakOperator.email);
      await provision(validBody(), billing).expect(403);
    });

    it('creates nothing when the caller is refused', async () => {
      const body = validBody();
      const support = await harness.platformToken(world.operator.email);
      await provision(body, support).expect(403);

      const company = await harness.prisma.company.findUnique({ where: { slug: body.slug } });
      expect(company).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('duplicates', () => {
    it('refuses a slug that is already taken', async () => {
      const body = validBody();
      await provision(body).expect(201);

      const res = await provision({
        ...body,
        owner: { email: `other-${Date.now()}@example.com`, fullName: 'Other' },
      }).expect(409);

      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details?.field).toBe('slug');
    });

    it('allows two companies to share a display name', async () => {
      // Trading names are not unique across a country, let alone a SaaS.
      // Enforcing uniqueness here would reject legitimate customers.
      const name = `Duplicate Name ${Date.now()}`;
      await provision({ ...validBody(), displayName: name }).expect(201);
      await provision({ ...validBody(), displayName: name }).expect(201);
    });

    it('does not create a duplicate company when the slug collides', async () => {
      const body = validBody();
      await provision(body).expect(201);
      await provision({ ...body, displayName: 'Second attempt' }).expect(409);

      const count = await harness.prisma.company.count({ where: { slug: body.slug } });
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('atomicity', () => {
    /**
     * A failure late in the transaction must leave nothing behind.
     *
     * The owner step runs last, after the company, its settings and six roles
     * with their permission rows have all been written. Pointing it at a
     * soft-deleted account makes it throw there — a real failure on a real
     * code path, not an injected fault — so what this asserts is that roughly
     * seventy rows disappear together.
     *
     * Partial provisioning is worse than none: a company with no owner cannot
     * be administered, and with no self-serve signup there is no way back
     * without another operator call.
     */
    it('rolls back every row when the owner step fails', async () => {
      const email = `deleted-${Date.now()}@example.com`;
      const deleted = await harness.prisma.userAccount.create({
        data: { email, fullName: 'Deleted Person', status: 'ACTIVE', deletedAt: new Date() },
      });

      const body = { ...validBody(), owner: { email, fullName: 'Deleted Person' } };
      const res = await provision(body).expect(409);
      expect(res.body.error.details?.field).toBe('owner.email');

      const company = await harness.prisma.company.findUnique({
        where: { slug: body.slug },
        select: { id: true },
      });
      expect(company).toBeNull();

      // And nothing orphaned behind it.
      expect(await harness.prisma.companyUser.count({ where: { userAccountId: deleted.id } })).toBe(
        0,
      );
      expect(
        await harness.prisma.companySettings.count({ where: { company: { slug: body.slug } } }),
      ).toBe(0);
      expect(
        await harness.prisma.companyRole.count({ where: { company: { slug: body.slug } } }),
      ).toBe(0);
    });

    it('leaves the slug free after a rolled-back attempt', async () => {
      // If the rollback were partial, the unique index would keep the slug
      // reserved forever and the customer could never be onboarded.
      const email = `deleted2-${Date.now()}@example.com`;
      await harness.prisma.userAccount.create({
        data: { email, fullName: 'Deleted Two', status: 'ACTIVE', deletedAt: new Date() },
      });

      const body = validBody();
      await provision({ ...body, owner: { email, fullName: 'Deleted Two' } }).expect(409);
      await provision(body).expect(201);
    });

    it('refuses a disabled owner account without creating anything', async () => {
      const email = `disabled-${Date.now()}@example.com`;
      await harness.prisma.userAccount.create({
        data: { email, fullName: 'Disabled Person', status: 'DISABLED' },
      });

      const body = { ...validBody(), owner: { email, fullName: 'Disabled Person' } };
      await provision(body).expect(409);

      expect(await harness.prisma.company.count({ where: { slug: body.slug } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('read-back', () => {
    it('returns the provisioned company with setup counts', async () => {
      const created = await provision(validBody()).expect(201);
      const id = created.body.data.company.id;

      const res = await request(http)
        .get(`/api/v1/platform/companies/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data).toMatchObject({ id, status: 'PENDING_SETUP' });
      expect(res.body.data._count).toMatchObject({
        users: 1,
        roles: Object.keys(SYSTEM_ROLES).length,
        branches: 0,
      });
    });

    it('404s an unknown company', async () => {
      await request(http)
        .get('/api/v1/platform/companies/018f0000-0000-7000-8000-0000000000ff')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('is closed to staff tokens', async () => {
      const created = await provision(validBody()).expect(201);
      const staff = await harness.staffToken(world.userA.email);

      await request(http)
        .get(`/api/v1/platform/companies/${created.body.data.company.id}`)
        .set('Authorization', `Bearer ${staff}`)
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('the audit trail', () => {
    it('records the provisioning as a platform-level event', async () => {
      const body = validBody();
      const res = await provision(body).expect(201);

      const entry = await harness.prisma.auditLog.findFirst({
        where: { action: 'platform.company.provisioned', resourceId: res.body.data.company.id },
      });

      expect(entry).not.toBeNull();
      // company_id NULL: this is an action ON a company, not within one, and
      // the operator who performed it is not a member.
      expect(entry?.companyId).toBeNull();
      expect(entry?.actorType).toBe('PLATFORM_USER');
    });
  });
});
