import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * SERVICE CATALOG
 * ===========================================================================
 *
 * A service links to a category, branches, employees and resource types — four
 * tenant-scoped things — so almost every failure mode here is a cross-tenant
 * link. The isolation block is the substance.
 */
describe('service catalog', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  let branchA: string;
  let branchB: string;
  let employeeA: string;
  let employeeB: string;
  let categoryA: string;
  let categoryB: string;
  let resourceTypeA: string;

  let unique = 0;
  const code = () => `SVC${Date.now() % 100000}${unique++}`;

  const svcUrl = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/services`;
  const catUrl = (companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/service-categories`;

  async function makeService(body: Record<string, unknown> = {}, token = ownerA, companyId?: string) {
    const res = await request(http)
      .post(svcUrl(companyId))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Haircut', durationMin: 30, priceMinor: '4500', ...body })
      .expect(201);
    return res.body.data as { id: string; code: string | null };
  }

  async function makeCategory(body: Record<string, unknown> = {}, token = ownerA, companyId?: string) {
    const res = await request(http)
      .post(catUrl(companyId))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Cat ${Date.now()}-${unique++}`, ...body })
      .expect(201);
    return res.body.data as { id: string; name: string };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    // userA and userB hold the seeded FULL role, so a permission check can
    // never be what makes a cross-tenant assertion fail.
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    const branch = async (companyId: string) =>
      (
        await harness.prisma.branch.create({
          data: { companyId, code: `B${Date.now() % 100000}${unique++}`, name: 'B', timezoneName: 'UTC' },
        })
      ).id;
    const employee = async (companyId: string) =>
      (await harness.prisma.employee.create({ data: { companyId, displayName: 'Stylist' } })).id;

    branchA = await branch(world.companyA.id);
    branchB = await branch(world.companyB.id);
    employeeA = await employee(world.companyA.id);
    employeeB = await employee(world.companyB.id);

    categoryA = (await makeCategory({ name: 'Hair' })).id;
    categoryB = (await makeCategory({ name: 'Hair' }, ownerB, world.companyB.id)).id;

    // Resource Management does not exist, so the type is seeded directly — the
    // relationship is real even though nothing creates the rows through an API.
    resourceTypeA = (
      await harness.prisma.resourceType.create({
        data: { companyId: world.companyA.id, key: 'ROOM', name: 'Treatment room', kind: 'ROOM' },
      })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('categories', () => {
    it('creates a top-level category', async () => {
      const res = await request(http)
        .post(catUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: `Nails ${unique++}`, color: '#0F6B63', sortOrder: 2 })
        .expect(201);

      expect(res.body.data).toMatchObject({ parentId: null, sortOrder: 2, serviceCount: 0 });
    });

    it('nests one level', async () => {
      const parent = await makeCategory({ name: `Parent ${unique++}` });
      const child = await makeCategory({ name: 'Colouring', parentId: parent.id });

      const res = await request(http)
        .get(`${catUrl()}/${parent.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.children.map((c: { id: string }) => c.id)).toContain(child.id);
    });

    it('allows the same name under different parents', async () => {
      /**
       * The whole point of the hierarchy. The index is
       * `(company_id, parent_id, name)`, so `Hair > Colouring` and
       * `Nails > Colouring` are both legal — a flat unique-per-company would
       * have made the second one impossible.
       */
      const hair = await makeCategory({ name: `Hair ${unique++}` });
      const nails = await makeCategory({ name: `Nails ${unique++}` });

      await makeCategory({ name: 'Colouring', parentId: hair.id });
      await makeCategory({ name: 'Colouring', parentId: nails.id });
    });

    it('refuses a duplicate name under the same parent', async () => {
      const parent = await makeCategory({ name: `Dup ${unique++}` });
      await makeCategory({ name: 'Same', parentId: parent.id });

      const res = await request(http)
        .post(catUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Same', parentId: parent.id })
        .expect(409);
      expect(res.body.error.details?.field).toBe('name');
    });

    it('refuses three levels', async () => {
      const root = await makeCategory({ name: `Root ${unique++}` });
      const child = await makeCategory({ name: 'Child', parentId: root.id });

      const res = await request(http)
        .post(catUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Grandchild', parentId: child.id })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/one level deep/i);
    });

    it('refuses a category as its own parent', async () => {
      const category = await makeCategory({ name: `Self ${unique++}` });

      await request(http)
        .patch(`${catUrl()}/${category.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ parentId: category.id })
        .expect(400);
    });

    it('refuses nesting a category that has children', async () => {
      // Otherwise the grandchild lands at depth three by the back door.
      const root = await makeCategory({ name: `Has kids ${unique++}` });
      await makeCategory({ name: 'Kid', parentId: root.id });
      const other = await makeCategory({ name: `Other ${unique++}` });

      await request(http)
        .patch(`${catUrl()}/${root.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ parentId: other.id })
        .expect(400);
    });

    it('deletes an empty category', async () => {
      const category = await makeCategory({ name: `Empty ${unique++}` });

      await request(http)
        .delete(`${catUrl()}/${category.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const row = await harness.prisma.serviceCategory.findUniqueOrThrow({
        where: { id: category.id },
      });
      expect(row.deletedAt).not.toBeNull();
    });

    it('refuses to delete a category that still holds services, and says how many', async () => {
      /**
       * Cascading would orphan a price list — and because `service.categoryId`
       * is nullable, the failure would not even be a foreign-key error, just a
       * catalogue that quietly lost its structure.
       */
      const category = await makeCategory({ name: `Full ${unique++}` });
      await makeService({ categoryId: category.id });

      const res = await request(http)
        .delete(`${catUrl()}/${category.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(409);

      expect(res.body.error.details?.serviceCount).toBe(1);
    });

    it('refuses to delete a category that still has children', async () => {
      const root = await makeCategory({ name: `Parenting ${unique++}` });
      await makeCategory({ name: 'Kid', parentId: root.id });

      const res = await request(http)
        .delete(`${catUrl()}/${root.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(409);
      expect(res.body.error.details?.childCount).toBe(1);
    });
  });

  // ===========================================================================
  describe('service CRUD', () => {
    it('creates a service, defaulting the currency to the company’s', async () => {
      const res = await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          name: 'Cut and finish',
          code: code().toLowerCase(),
          categoryId: categoryA,
          durationMin: 60,
          bufferBeforeMin: 10,
          bufferAfterMin: 15,
          priceMinor: '50000',
        })
        .expect(201);

      expect(res.body.data).toMatchObject({
        name: 'Cut and finish',
        durationMin: 60,
        // Money is a string on the wire — the column is BigInt and a JS number
        // rounds above 2^53.
        priceMinor: '50000',
        currencyCode: 'MNT',
        status: 'ACTIVE',
        isOnlineBookable: true,
      });
      // Normalised, like branch and employee codes.
      expect(res.body.data.code).toMatch(/^SVC/);
      // The window the availability engine will reserve: 10 + 60 + 15.
      expect(res.body.data.totalOccupiedMin).toBe(85);
    });

    it('creates with branches, employees and resource requirements at once', async () => {
      const res = await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          name: 'Massage',
          durationMin: 90,
          priceMinor: '80000',
          branchIds: [branchA],
          employeeIds: [employeeA],
          resourceRequirements: [{ resourceTypeId: resourceTypeA, quantity: 1 }],
          requiresResource: true,
        })
        .expect(201);

      expect(res.body.data.branches).toHaveLength(1);
      expect(res.body.data.employees).toHaveLength(1);
      expect(res.body.data.resourceRequirements[0]).toMatchObject({
        resourceTypeId: resourceTypeA,
        name: 'Treatment room',
        quantity: 1,
      });
    });

    it('updates, and replaces resource requirements wholesale', async () => {
      const service = await makeService({
        resourceRequirements: [{ resourceTypeId: resourceTypeA, quantity: 2 }],
      });

      const res = await request(http)
        .patch(`${svcUrl()}/${service.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Renamed', durationMin: 45, resourceRequirements: [] })
        .expect(200);

      expect(res.body.data).toMatchObject({ name: 'Renamed', durationMin: 45 });
      expect(res.body.data.resourceRequirements).toHaveLength(0);
    });

    it('soft-deletes and withdraws from public booking', async () => {
      const service = await makeService();

      await request(http)
        .delete(`${svcUrl()}/${service.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const row = await harness.prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      // The record stays: appointment history references it.
      expect(row.deletedAt).not.toBeNull();
      expect(row.status).toBe('ARCHIVED');
      // Belt and braces on the one mistake customers would see.
      expect(row.isOnlineBookable).toBe(false);

      await request(http)
        .get(`${svcUrl()}/${service.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('keeps bookable and public as separate ideas', async () => {
      // The internal-only service: reception can book it, the public cannot
      // see it.
      const res = await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          name: 'Staff training',
          durationMin: 120,
          priceMinor: '0',
          status: 'ACTIVE',
          isOnlineBookable: false,
        })
        .expect(201);

      expect(res.body.data).toMatchObject({ status: 'ACTIVE', isOnlineBookable: false });
    });

    describe('service codes', () => {
      it('refuses a duplicate within the company', async () => {
        const service = await makeService({ code: code() });

        await request(http)
          .post(svcUrl())
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ name: 'Clash', durationMin: 30, priceMinor: '1', code: service.code })
          .expect(409);
      });

      it('allows the same code in another company', async () => {
        const service = await makeService({ code: code() });

        await request(http)
          .post(svcUrl(world.companyB.id))
          .set('Authorization', `Bearer ${ownerB}`)
          .send({ name: 'Theirs', durationMin: 30, priceMinor: '1', code: service.code })
          .expect(201);
      });
    });
  });

  // ===========================================================================
  describe('validation', () => {
    it.each([
      ['zero duration', { durationMin: 0 }],
      ['negative duration', { durationMin: -30 }],
      ['a duration longer than a day', { durationMin: 2000 }],
      ['a negative buffer', { bufferBeforeMin: -5 }],
      ['a float price', { priceMinor: '45.50' }],
      ['a negative price', { priceMinor: '-100' }],
      ['a lowercase currency', { currencyCode: 'mnt' }],
      ['an unknown field', { isPublic: true }],
      ['a companyId', { companyId: '018f0000-0000-7000-8000-0000000000ff' }],
    ])('rejects %s', async (_label, patch) => {
      await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Bad', durationMin: 30, priceMinor: '1000', ...patch })
        .expect(400);
    });

    it('rejects an unknown currency by name', async () => {
      const res = await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Bad', durationMin: 30, priceMinor: '1000', currencyCode: 'ZZZ' })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/currencyCode/);
    });

    it('rejects a deposit flag with no amount', async () => {
      await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Deposit', durationMin: 30, priceMinor: '1000', requiresDeposit: true })
        .expect(400);
    });

    it('rejects turning the deposit flag on by PATCH without an amount', async () => {
      // The merged-state check: the schema alone cannot see that the stored
      // amount is null.
      const service = await makeService();

      await request(http)
        .patch(`${svcUrl()}/${service.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ requiresDeposit: true })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('search, filter, pagination', () => {
    it('searches name and code', async () => {
      const marker = `Zq${Date.now()}`;
      await makeService({ name: `${marker} Service` });

      const res = await request(http)
        .get(`${svcUrl()}?search=${marker.toLowerCase()}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.total).toBe(1);
    });

    it('filters by category, branch and employee', async () => {
      const category = await makeCategory({ name: `Filter ${unique++}` });
      const service = await makeService({
        categoryId: category.id,
        branchIds: [branchA],
        employeeIds: [employeeA],
      });

      for (const q of [
        `categoryId=${category.id}`,
        `branchId=${branchA}&categoryId=${category.id}`,
        `employeeId=${employeeA}&categoryId=${category.id}`,
      ]) {
        const res = await request(http)
          .get(`${svcUrl()}?${q}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(200);
        expect(res.body.data.items.map((s: { id: string }) => s.id)).toContain(service.id);
      }
    });

    it('filters by online bookability', async () => {
      const res = await request(http)
        .get(`${svcUrl()}?isOnlineBookable=false`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(
        res.body.data.items.every((s: { isOnlineBookable: boolean }) => !s.isOnlineBookable),
      ).toBe(true);
    });

    it('paginates and reports the whole total', async () => {
      const res = await request(http)
        .get(`${svcUrl()}?limit=2`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      expect(res.body.data.total).toBeGreaterThan(2);
    });

    it('excludes soft-deleted services', async () => {
      const service = await makeService({ name: `Bye ${Date.now()}` });
      await request(http)
        .delete(`${svcUrl()}/${service.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const res = await request(http)
        .get(`${svcUrl()}?search=Bye`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.items.map((s: { id: string }) => s.id)).not.toContain(service.id);
    });

    it('rejects an unknown query parameter', async () => {
      await request(http)
        .get(`${svcUrl()}?companyId=${world.companyB.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(400);
    });
  });

  // ===========================================================================
  describe('branch assignment', () => {
    it('assigns with overrides and unassigns', async () => {
      const service = await makeService();

      const assigned = await request(http)
        .post(`${svcUrl()}/${service.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchA, priceOverrideMinor: '6000', durationOverrideMin: 40 })
        .expect(201);

      expect(assigned.body.data.items[0]).toMatchObject({
        branchId: branchA,
        priceOverrideMinor: '6000',
        durationOverrideMin: 40,
      });

      await request(http)
        .delete(`${svcUrl()}/${service.id}/branches/${branchA}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);
    });

    it('refuses a duplicate', async () => {
      const service = await makeService({ branchIds: [branchA] });

      const res = await request(http)
        .post(`${svcUrl()}/${service.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchA })
        .expect(409);
      expect(res.body.error.code).toBe('ALREADY_ASSIGNED');
    });
  });

  // ===========================================================================
  describe('employee assignment — one table, two doors', () => {
    it('assigning from the service side is visible from the employee side', async () => {
      /**
       * The property §16 of the brief asks for. Both endpoints write
       * `employee_service`, whose primary key is
       * `(company_id, employee_id, service_id)`. There is no second junction
       * table, so there is nothing to drift.
       */
      const service = await makeService();

      await request(http)
        .post(`${svcUrl()}/${service.id}/employees`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ employeeId: employeeA, proficiency: 5 })
        .expect(201);

      const fromEmployee = await request(http)
        .get(`/api/v1/companies/${world.companyA.id}/employees/${employeeA}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(fromEmployee.body.data.items.map((s: { serviceId: string }) => s.serviceId)).toContain(
        service.id,
      );
    });

    it('assigning from the employee side is visible from the service side', async () => {
      const service = await makeService();

      await request(http)
        .post(`/api/v1/companies/${world.companyA.id}/employees/${employeeA}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: service.id })
        .expect(201);

      const fromService = await request(http)
        .get(`${svcUrl()}/${service.id}/employees`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(
        fromService.body.data.items.map((e: { employeeId: string }) => e.employeeId),
      ).toContain(employeeA);
    });

    it('produces exactly one row, not two', async () => {
      const service = await makeService();
      await request(http)
        .post(`${svcUrl()}/${service.id}/employees`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ employeeId: employeeA })
        .expect(201);

      const rows = await harness.prisma.employeeService.count({
        where: { serviceId: service.id, employeeId: employeeA },
      });
      expect(rows).toBe(1);
    });

    it('refuses a duplicate from either direction', async () => {
      const service = await makeService();
      await request(http)
        .post(`${svcUrl()}/${service.id}/employees`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ employeeId: employeeA })
        .expect(201);

      await request(http)
        .post(`${svcUrl()}/${service.id}/employees`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ employeeId: employeeA })
        .expect(409);

      await request(http)
        .post(`/api/v1/companies/${world.companyA.id}/employees/${employeeA}/services`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ serviceId: service.id })
        .expect(409);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('cannot read, update or delete another company’s service', async () => {
      const theirs = await makeService({ name: 'Untouchable' }, ownerB, world.companyB.id);

      // Through their own company path — the attack a naive lookup misses.
      await request(http)
        .get(`${svcUrl()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
      await request(http)
        .patch(`${svcUrl()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Hijacked' })
        .expect(404);
      await request(http)
        .delete(`${svcUrl()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);

      const row = await harness.prisma.service.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.name).toBe('Untouchable');
      expect(row.deletedAt).toBeNull();
    });

    it('cannot put a service in another company’s category', async () => {
      const res = await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Cross', durationMin: 30, priceMinor: '1', categoryId: categoryB })
        .expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      // Nothing partially created — the category is validated first.
      expect(await harness.prisma.service.count({ where: { name: 'Cross' } })).toBe(0);
    });

    it('cannot offer a service at another company’s branch', async () => {
      const service = await makeService();

      await request(http)
        .post(`${svcUrl()}/${service.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchB })
        .expect(404);

      expect(
        await harness.prisma.serviceBranch.count({
          where: { serviceId: service.id, branchId: branchB },
        }),
      ).toBe(0);
    });

    it('cannot assign another company’s employee', async () => {
      const service = await makeService();

      await request(http)
        .post(`${svcUrl()}/${service.id}/employees`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ employeeId: employeeB })
        .expect(404);

      expect(
        await harness.prisma.employeeService.count({
          where: { serviceId: service.id, employeeId: employeeB },
        }),
      ).toBe(0);
    });

    it('cannot nest under another company’s category', async () => {
      await request(http)
        .post(catUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ name: 'Cross parent', parentId: categoryB })
        .expect(404);
    });

    it('cannot read or delete another company’s category', async () => {
      await request(http)
        .get(`${catUrl()}/${categoryB}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
      await request(http)
        .delete(`${catUrl()}/${categoryB}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('never lists another company’s services', async () => {
      const theirs = await makeService({}, ownerB, world.companyB.id);

      const res = await request(http)
        .get(`${svcUrl()}?limit=100`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.map((s: { id: string }) => s.id)).not.toContain(theirs.id);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('rejects an anonymous caller', async () => {
      await request(http).get(svcUrl()).expect(401);
      await request(http).get(catUrl()).expect(401);
    });

    it('lets a read-only member read but not write', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);

      await request(http).get(svcUrl()).set('Authorization', `Bearer ${reader}`).expect(200);
      await request(http).get(catUrl()).set('Authorization', `Bearer ${reader}`).expect(200);

      await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${reader}`)
        .send({ name: 'Nope', durationMin: 30, priceMinor: '1' })
        .expect(403);
      await request(http)
        .post(catUrl())
        .set('Authorization', `Bearer ${reader}`)
        .send({ name: 'Nope' })
        .expect(403);
    });

    it('refuses an employee-role member from editing the catalogue', async () => {
      // EMPLOYEE holds service:read but not service:write — a stylist reads the
      // price list, they do not set it.
      const staff = await memberWithRole(SYSTEM_ROLES.EMPLOYEE);

      await request(http).get(svcUrl()).set('Authorization', `Bearer ${staff}`).expect(200);
      await request(http)
        .post(svcUrl())
        .set('Authorization', `Bearer ${staff}`)
        .send({ name: 'Nope', durationMin: 30, priceMinor: '1' })
        .expect(403);
    });
  });

  // ===========================================================================
  describe('audit', () => {
    it('records creation against the company', async () => {
      const service = await makeService();

      const entry = await harness.prisma.auditLog.findFirst({
        where: { action: 'service.created', resourceId: service.id },
      });

      expect(entry?.companyId).toBe(world.companyA.id);
      expect(entry?.actorType).toBe('COMPANY_USER');
    });

    it('records category and assignment events', async () => {
      const category = await makeCategory({ name: `Audited ${unique++}` });
      const service = await makeService();
      await request(http)
        .post(`${svcUrl()}/${service.id}/branches`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ branchId: branchA })
        .expect(201);

      for (const [action, id] of [
        ['service_category.created', category.id],
        ['service.branch_assigned', service.id],
      ] as const) {
        const entry = await harness.prisma.auditLog.findFirst({ where: { action, resourceId: id } });
        expect(entry).not.toBeNull();
      }
    });
  });

  // ===========================================================================

  /** A member of company A holding exactly one system role. */
  async function memberWithRole(roleKey: string): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `cat-${roleKey}-${Date.now()}-${unique++}@example.com`,
        fullName: `${roleKey} Person`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
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
});
