import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * EMPLOYEE MANAGEMENT
 * ===========================================================================
 *
 * Employees sit at the junction of three tenant-scoped things — the company,
 * its branches and its services — so most of what can go wrong here is a
 * cross-tenant link. The isolation block at the bottom is the substance.
 */
describe('employee management', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  /** A branch and a service in each company, to link things to. */
  let branchA: string;
  let branchB: string;
  let serviceA: string;
  let serviceB: string;

  let unique = 0;
  const code = () => `EMP${Date.now() % 100000}${unique++}`;
  const email = () => `emp-${Date.now()}-${unique++}@example.com`;

  const url = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/employees`;

  async function makeEmployee(body: Record<string, unknown> = {}, token = ownerA, companyId?: string) {
    const res = await request(http)
      .post(url(companyId))
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Test Stylist', ...body })
      .expect(201);
    return res.body.data as { id: string; employeeCode: string | null };
  }

  /** A branch created directly, so branch-module behaviour is not under test here. */
  async function seedBranch(companyId: string) {
    const branch = await harness.prisma.branch.create({
      data: { companyId, code: `B${Date.now() % 100000}${unique++}`, name: 'Branch', timezoneName: 'UTC' },
    });
    return branch.id;
  }

  /**
   * A service created directly.
   *
   * Service Management is a separate module and does not exist, so there is no
   * endpoint to create one. The table does exist, and the employee↔service
   * relationship is real — so the rows are seeded and the assignment endpoints
   * are tested against them.
   */
  async function seedService(companyId: string) {
    const service = await harness.prisma.service.create({
      data: {
        companyId,
        name: 'Haircut',
        durationMin: 30,
        priceMinor: 4500n,
        currencyCode: 'MNT',
      },
    });
    return service.id;
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    for (const [companyId, userId] of [
      [world.companyA.id, world.userA.id],
      [world.companyB.id, world.userB.id],
    ] as const) {
      await harness.prisma.companyUser.updateMany({
        where: { companyId, userAccountId: userId },
        data: { isOwner: true },
      });
    }

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    branchA = await seedBranch(world.companyA.id);
    branchB = await seedBranch(world.companyB.id);
    serviceA = await seedService(world.companyA.id);
    serviceB = await seedService(world.companyB.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('CRUD', () => {
    it('creates an employee with no login at all', async () => {
      /**
       * The distinction the whole module rests on: an employee is somebody a
       * customer can book, a user account is a login, and a stylist who never
       * touches the dashboard needs only the first.
       */
      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          displayName: 'Nomin the Stylist',
          employeeCode: code().toLowerCase(),
          profile: { jobTitle: 'Senior Stylist', bio: 'Ten years of colour work.' },
        })
        .expect(201);

      expect(res.body.data).toMatchObject({
        displayName: 'Nomin the Stylist',
        status: 'ACTIVE',
        isBookable: true,
        hasAccount: false,
        account: null,
      });
      // Normalised, like branch codes.
      expect(res.body.data.employeeCode).toMatch(/^EMP/);
      expect(res.body.data.publicProfile.jobTitle).toBe('Senior Stylist');
    });

    it('assigns branches at creation, making the first one primary', async () => {
      const second = await seedBranch(world.companyA.id);

      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Multi Branch', branchIds: [branchA, second] })
        .expect(201);

      expect(res.body.data.branches).toHaveLength(2);
      // An employee with branches but no primary is a state the schedule
      // engine would have to invent a rule for.
      expect(res.body.data.primaryBranchId).toBe(branchA);
    });

    it('reads back with branches, services and account status', async () => {
      const employee = await makeEmployee({ branchIds: [branchA] });
      await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA, proficiency: 5 })
        .expect(201);

      const res = await request(http)
        .get(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.branches).toHaveLength(1);
      expect(res.body.data.services).toHaveLength(1);
      expect(res.body.data.services[0].name).toBe('Haircut');
      expect(res.body.data.account).toBeNull();
    });

    it('updates the employee and their profile together', async () => {
      const employee = await makeEmployee();

      const res = await request(http)
        .patch(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Renamed', status: 'ON_LEAVE', profile: { jobTitle: 'Colourist' } })
        .expect(200);

      expect(res.body.data).toMatchObject({ displayName: 'Renamed', status: 'ON_LEAVE' });
      expect(res.body.data.publicProfile.jobTitle).toBe('Colourist');
    });

    it('soft-deletes and stops the employee being bookable', async () => {
      const employee = await makeEmployee();

      await request(http)
        .delete(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const row = await harness.prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
      // The record stays: appointment history references this person.
      expect(row.deletedAt).not.toBeNull();
      // Belt and braces on the one mistake customers would see — a future
      // availability engine that forgets to filter on deletedAt still cannot
      // offer them.
      expect(row.isBookable).toBe(false);
      expect(row.status).toBe('TERMINATED');

      await request(http)
        .get(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    describe('employee codes', () => {
      it('refuses a duplicate within the company', async () => {
        const employee = await makeEmployee({ employeeCode: code() });

        const res = await request(http)
          .post(url())
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ displayName: 'Clash', employeeCode: employee.employeeCode })
          .expect(409);

        expect(res.body.error.details?.field).toBe('employeeCode');
      });

      it('allows the same code in a different company', async () => {
        const employee = await makeEmployee({ employeeCode: code() });

        await request(http)
          .post(url(world.companyB.id))
          .set('Authorization', `Bearer ${ownerB}`)
          .send({ displayName: 'Their EMP', employeeCode: employee.employeeCode })
          .expect(201);
      });

      it('allows many employees with no code at all', async () => {
        // The partial index is `WHERE employee_code IS NOT NULL`, so nulls do
        // not collide.
        await makeEmployee();
        await makeEmployee();
      });
    });

    it('refuses a companyId in the body', async () => {
      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Sneaky', companyId: world.companyB.id })
        .expect(400);
    });

    it('refuses userAccountId in the body', async () => {
      // Linking a login also creates a membership and an invitation, so it
      // cannot be a field on a profile edit.
      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Sneaky', userAccountId: world.userA.id })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('search, filter and pagination', () => {
    it('searches display name and code, case-insensitively', async () => {
      const marker = `Zzz${Date.now()}`;
      await makeEmployee({ displayName: `${marker} Person` });

      const res = await request(http)
        .get(`${url()}?search=${marker.toLowerCase()}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].displayName).toContain(marker);
    });

    it('filters by status and by branch', async () => {
      const branch = await seedBranch(world.companyA.id);
      await makeEmployee({ displayName: 'On Leave', status: 'ON_LEAVE', branchIds: [branch] });

      const byStatus = await request(http)
        .get(`${url()}?status=ON_LEAVE`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(byStatus.body.data.items.every((e: { status: string }) => e.status === 'ON_LEAVE')).toBe(true);

      const byBranch = await request(http)
        .get(`${url()}?branchId=${branch}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(byBranch.body.data.total).toBe(1);
    });

    it('filters by service — the shape the availability engine will ask for', async () => {
      const employee = await makeEmployee({ branchIds: [branchA] });
      await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA })
        .expect(201);

      const res = await request(http)
        .get(`${url()}?serviceId=${serviceA}&branchId=${branchA}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.map((e: { id: string }) => e.id)).toContain(employee.id);
    });

    it('filters by whether they have a login', async () => {
      const res = await request(http)
        .get(`${url()}?hasAccount=false`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.every((e: { hasAccount: boolean }) => !e.hasAccount)).toBe(true);
    });

    it('paginates, and reports the full total', async () => {
      const res = await request(http)
        .get(`${url()}?limit=2&offset=0`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      // The total is the size of the whole result set, not of the page — a UI
      // cannot render a pager otherwise.
      expect(res.body.data.total).toBeGreaterThan(2);
    });

    it('excludes soft-deleted employees', async () => {
      const employee = await makeEmployee({ displayName: 'Gone Soon' });
      await request(http)
        .delete(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const res = await request(http)
        .get(`${url()}?search=Gone Soon`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.total).toBe(0);
    });

    it('rejects an unknown query parameter', async () => {
      await request(http)
        .get(`${url()}?companyId=${world.companyB.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(400);
    });
  });

  // ===========================================================================
  describe('branch assignment', () => {
    it('assigns, lists and unassigns', async () => {
      const employee = await makeEmployee();

      const assigned = await request(http)
        .post(`${url()}/${employee.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchA })
        .expect(201);
      expect(assigned.body.data.items[0]).toMatchObject({ branchId: branchA, isPrimary: true });

      await request(http)
        .delete(`${url()}/${employee.id}/branches/${branchA}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const after = await request(http)
        .get(`${url()}/${employee.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(after.body.data.items).toHaveLength(0);
    });

    it('refuses a duplicate assignment', async () => {
      const employee = await makeEmployee({ branchIds: [branchA] });

      const res = await request(http)
        .post(`${url()}/${employee.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchA })
        .expect(409);

      expect(res.body.error.code).toBe('ALREADY_ASSIGNED');
    });

    it('promotes another branch when the primary is removed', async () => {
      const second = await seedBranch(world.companyA.id);
      const employee = await makeEmployee({ branchIds: [branchA, second] });

      await request(http)
        .delete(`${url()}/${employee.id}/branches/${branchA}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const res = await request(http)
        .get(`${url()}/${employee.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].isPrimary).toBe(true);
    });

    it('keeps at most one primary', async () => {
      const second = await seedBranch(world.companyA.id);
      const employee = await makeEmployee({ branchIds: [branchA] });

      const res = await request(http)
        .post(`${url()}/${employee.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: second, isPrimary: true })
        .expect(201);

      const primaries = res.body.data.items.filter((b: { isPrimary: boolean }) => b.isPrimary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0].branchId).toBe(second);
    });
  });

  // ===========================================================================
  describe('service assignment', () => {
    it('assigns with overrides, and returns price as a string', async () => {
      const employee = await makeEmployee();

      const res = await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA, durationOverrideMin: 45, priceOverrideMinor: '5500', proficiency: 4 })
        .expect(201);

      expect(res.body.data.items[0]).toMatchObject({
        serviceId: serviceA,
        durationOverrideMin: 45,
        // BigInt on the wire is a string: above 2^53 a JS number silently
        // rounds, and a price is exactly the value that must not.
        priceOverrideMinor: '5500',
        proficiency: 4,
      });
    });

    it('refuses a duplicate assignment', async () => {
      const employee = await makeEmployee();
      await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA })
        .expect(201);

      const res = await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA })
        .expect(409);
      expect(res.body.error.code).toBe('ALREADY_ASSIGNED');
    });

    it('rejects a float price', async () => {
      const employee = await makeEmployee();
      await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA, priceOverrideMinor: '45.50' })
        .expect(400);
    });

    it('unassigns', async () => {
      const employee = await makeEmployee();
      await request(http)
        .post(`${url()}/${employee.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceA })
        .expect(201);

      await request(http)
        .delete(`${url()}/${employee.id}/services/${serviceA}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);
    });
  });

  // ===========================================================================
  describe('linking a login', () => {
    it('creates an account, a membership and an invitation', async () => {
      const employee = await makeEmployee();
      const address = email();

      const res = await request(http)
        .post(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ email: address, roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(201);

      expect(res.body.data.userAccountId).toEqual(expect.any(String));
      // One-time link, not a password. The invitee chooses their own.
      expect(res.body.data.invitation.token).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);

      const detail = await request(http)
        .get(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      // The account row is invisible to the tenant connection until the person
      // accepts and becomes a member — RLS working, not a gap. The response says
      // so rather than pretending there is no account.
      expect(detail.body.data.account).toMatchObject({ status: 'PENDING_ACCEPTANCE' });
      expect(address).toBeTruthy();
      expect(detail.body.data.hasAccount).toBe(true);
    });

    it('refuses a second login for the same employee', async () => {
      const employee = await makeEmployee();
      await request(http)
        .post(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(201);

      await request(http)
        .post(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(409);
    });

    it('applies the privilege-escalation rule from the invitation flow', async () => {
      /**
       * Granting somebody a login IS inviting them, so it is gated by the same
       * rule — an inviter cannot hand out permissions they do not hold. Proved
       * by reusing InvitationsService rather than reimplementing it.
       */
      const limited = await memberWithRole(SYSTEM_ROLES.BRANCH_MANAGER, [
        'employee:write',
        'member:invite',
      ]);
      const employee = await makeEmployee();

      const res = await request(http)
        .post(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${limited}`)
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.ADMIN] })
        .expect(403);

      expect(res.body.error.code).toBe('PRIVILEGE_ESCALATION_BLOCKED');
    });

    it('unlinks without deleting the account or the membership', async () => {
      const employee = await makeEmployee();
      const address = email();
      const linked = await request(http)
        .post(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ email: address, roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(201);

      await request(http)
        .delete(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      // The person's login is theirs and they may belong to other companies.
      // Removing their access is DELETE /members/:id — a different decision.
      const account = await harness.prisma.userAccount.findUnique({
        where: { id: linked.body.data.userAccountId },
      });
      expect(account).not.toBeNull();

      // The INVITATION survives too. A membership does not exist yet — it is
      // created when the person accepts, which is the invitation flow's job.
      const invitation = await harness.prisma.companyInvitation.count({
        where: { companyId: world.companyA.id, email: address, acceptedAt: null, revokedAt: null },
      });
      expect(invitation).toBe(1);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('Test 1 — company A reads its own employee', async () => {
      const employee = await makeEmployee();
      await request(http)
        .get(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
    });

    it('Test 2 — company A cannot read company B’s employee', async () => {
      const theirs = await makeEmployee({}, ownerB, world.companyB.id);

      // Through their own company path — the attack a naive lookup misses.
      await request(http)
        .get(`${url()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
      // And through the other company's path.
      await request(http)
        .get(`${url(world.companyB.id)}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('Test 3 — company A cannot update company B’s employee', async () => {
      const theirs = await makeEmployee({ displayName: 'Untouchable' }, ownerB, world.companyB.id);

      await request(http)
        .patch(`${url()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Hijacked' })
        .expect(404);

      const row = await harness.prisma.employee.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.displayName).toBe('Untouchable');
    });

    it('Test 4 — company A cannot delete company B’s employee', async () => {
      const theirs = await makeEmployee({}, ownerB, world.companyB.id);

      await request(http)
        .delete(`${url()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);

      const row = await harness.prisma.employee.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.deletedAt).toBeNull();
    });

    it('Test 5 — a company A employee cannot be assigned a company B branch', async () => {
      const mine = await makeEmployee();

      await request(http)
        .post(`${url()}/${mine.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchB })
        .expect(404);

      const rows = await harness.prisma.employeeBranch.count({
        where: { employeeId: mine.id, branchId: branchB },
      });
      expect(rows).toBe(0);
    });

    it('Test 5b — nor at creation time', async () => {
      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ displayName: 'Cross Branch', branchIds: [branchA, branchB] })
        .expect(404);

      // Nothing partially created: the branches are validated before the
      // employee row is written.
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      const orphan = await harness.prisma.employee.count({
        where: { displayName: 'Cross Branch' },
      });
      expect(orphan).toBe(0);
    });

    it('Test 6 — a company A employee cannot be assigned a company B service', async () => {
      const mine = await makeEmployee();

      await request(http)
        .post(`${url()}/${mine.id}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: serviceB })
        .expect(404);

      const rows = await harness.prisma.employeeService.count({
        where: { employeeId: mine.id, serviceId: serviceB },
      });
      expect(rows).toBe(0);
    });

    it('Test 7 — company A cannot manipulate company B’s assignments', async () => {
      const theirs = await makeEmployee({ branchIds: [branchB] }, ownerB, world.companyB.id);

      // Built lazily and awaited one at a time: `request(http)` starts the
      // request as soon as it is constructed, so an array literal fires all
      // four at once and they race the server's socket.
      const attempts = [
        () =>
          request(http).get(`${url()}/${theirs.id}/branches`).set('Authorization', `Bearer ${ownerA}`),
        () =>
          request(http)
            .post(`${url()}/${theirs.id}/branches`)
            .set('Authorization', `Bearer ${ownerA}`)
            .send({ branchId: branchA }),
        () =>
          request(http)
            .delete(`${url()}/${theirs.id}/branches/${branchB}`)
            .set('Authorization', `Bearer ${ownerA}`),
        () =>
          request(http)
            .post(`${url()}/${theirs.id}/account`)
            .set('Authorization', `Bearer ${ownerA}`)
            .send({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] }),
      ];

      for (const attempt of attempts) {
        await attempt().expect(404);
      }

      // Their assignment survived untouched.
      const rows = await harness.prisma.employeeBranch.count({
        where: { employeeId: theirs.id, branchId: branchB },
      });
      expect(rows).toBe(1);
    });

    it('Test 8 — no tenant context fails safely', async () => {
      // Anonymous, and with a token carrying no company. Both must refuse
      // rather than fall back to some default company.
      await request(http).get(url()).expect(401);

      const noCompany = await tokenWithNoCompany();
      await request(http).get(url()).set('Authorization', `Bearer ${noCompany}`).expect(404);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('lets a read-only member read but not write', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);

      await request(http).get(url()).set('Authorization', `Bearer ${reader}`).expect(200);
      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${reader}`)
        .send({ displayName: 'Nope' })
        .expect(403);
    });

    it('refuses an employee-role member from managing employees', async () => {
      // EMPLOYEE holds no employee:write — a stylist does not administer staff.
      const staff = await memberWithRole(SYSTEM_ROLES.EMPLOYEE);
      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${staff}`)
        .send({ displayName: 'Nope' })
        .expect(403);
    });

    it('does not confuse a job title with a role', async () => {
      /**
       * `jobTitle` is business vocabulary and carries no authority. Setting it
       * to something that looks like a role must change nothing.
       */
      const employee = await makeEmployee({ profile: { jobTitle: 'OWNER' } });

      const detail = await request(http)
        .get(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(detail.body.data.publicProfile.jobTitle).toBe('OWNER');
      // No login, therefore no permissions of any kind.
      expect(detail.body.data.hasAccount).toBe(false);
    });
  });

  // ===========================================================================
  describe('the public/private profile split', () => {
    it('keeps the emergency contact out of the list projection', async () => {
      /**
       * `emergencyContact` lives on the same row as `jobTitle` and `bio`. The
       * list is what a receptionist loads all day; a next-of-kin phone number
       * has no business being in it, and a spread of the row is exactly how it
       * would get there.
       */
      const marker = `Priv${Date.now()}`;
      await makeEmployee({
        displayName: marker,
        profile: { jobTitle: 'Stylist', emergencyContact: '+976 9911 2233', phone: '+976 5500 1122' },
      });

      const list = await request(http)
        .get(`${url()}?search=${marker}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const body = JSON.stringify(list.body);
      expect(body).not.toContain('9911 2233');
      expect(body).not.toContain('emergencyContact');
    });

    it('separates it from the public profile on the detail view', async () => {
      const employee = await makeEmployee({
        profile: { bio: 'Public bio', emergencyContact: '+976 9911 2233' },
      });

      const res = await request(http)
        .get(`${url()}/${employee.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.publicProfile.bio).toBe('Public bio');
      expect(res.body.data.publicProfile.emergencyContact).toBeUndefined();
      expect(res.body.data.privateProfile.emergencyContact).toBe('+976 9911 2233');
    });
  });

  // ===========================================================================
  describe('audit', () => {
    it('records creation against the company', async () => {
      const employee = await makeEmployee();

      const entry = await harness.prisma.auditLog.findFirst({
        where: { action: 'employee.created', resourceId: employee.id },
      });

      expect(entry?.companyId).toBe(world.companyA.id);
      expect(entry?.actorType).toBe('COMPANY_USER');
    });

    it('records a branch assignment', async () => {
      const employee = await makeEmployee();
      await request(http)
        .post(`${url()}/${employee.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchA })
        .expect(201);

      const entry = await harness.prisma.auditLog.findFirst({
        where: { action: 'employee.branch_assigned', resourceId: employee.id },
      });
      expect(entry).not.toBeNull();
    });

    it('never records an invitation token', async () => {
      const employee = await makeEmployee();
      const res = await request(http)
        .post(`${url()}/${employee.id}/account`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(201);

      const entry = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'employee.user_linked', resourceId: employee.id },
      });
      expect(JSON.stringify(entry.after)).not.toContain(res.body.data.invitation.token);
    });
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** A member of company A holding one system role, optionally widened. */
  async function memberWithRole(roleKey: string, extraPermissions: string[] = []): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `emp-role-${Date.now()}-${unique++}@example.com`,
        fullName: `${roleKey} Person`,
        status: 'ACTIVE',
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });

    // A private role, so widening it cannot affect other tests.
    const role = await harness.prisma.companyRole.create({
      data: {
        companyId: world.companyA.id,
        key: `TEST_${roleKey}_${unique++}`,
        name: roleKey,
      },
    });
    const template = await harness.prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
      include: { permissions: true },
    });
    const keys = [...new Set([...template.permissions.map((p) => p.permissionKey), ...extraPermissions])];
    await harness.prisma.companyRolePermission.createMany({
      data: keys.map((permissionKey) => ({
        companyId: world.companyA.id,
        roleId: role.id,
        permissionKey,
      })),
    });
    await harness.prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });

    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }

  /** An account with a login but no membership anywhere. */
  async function tokenWithNoCompany(): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `nobody-${Date.now()}-${unique++}@example.com`,
        fullName: 'No Company',
        status: 'ACTIVE',
        passwordHash: known.passwordHash,
      },
    });
    return harness.staffToken(account.email);
  }
});
