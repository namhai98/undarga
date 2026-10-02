import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * CUSTOMERS
 * ===========================================================================
 *
 * `company_customer` is one company's RECORD of a person, not the person. The
 * two properties that follow from that are the ones worth testing hardest: the
 * same phone number is legal in two companies and refused twice in one, and a
 * customer id from company B is a 404 in company A rather than a 403.
 */
describe('customers', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  let employeeA: string;

  let unique = 0;
  const phone = () => `+9769${String(Date.now() % 10000000).padStart(7, '0')}`.slice(0, 12);
  const mail = () => `live-${Date.now()}-${unique++}@example.com`;

  const url = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/customers`;

  async function makeCustomer(
    body: Record<string, unknown> = {},
    token = ownerA,
    companyId?: string,
  ) {
    const res = await request(http)
      .post(url(companyId))
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Sara', phone: phone(), ...body })
      .expect(201);
    return res.body.data as { id: string; phone: string | null; email: string | null };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);

    employeeA = (
      await harness.prisma.employee.create({
        data: { companyId: world.companyA.id, displayName: 'Stylist' },
      })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('CRUD', () => {
    it('creates a customer and composes a full name', async () => {
      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          firstName: 'Sara',
          lastName: 'Ochir',
          email: mail(),
          phone: '+976 9911 2233',
          address: 'Apartment 4, Sukhbaatar District',
          notes: 'Prefers the morning.',
          tags: ['vip'],
        })
        .expect(201);

      expect(res.body.data).toMatchObject({
        firstName: 'Sara',
        lastName: 'Ochir',
        fullName: 'Sara Ochir',
        status: 'ACTIVE',
        tags: ['vip'],
        // Separators stripped, so the uniqueness index means "the same person"
        // rather than "the same keystrokes".
        phone: '+97699112233',
        totalVisits: 0,
        totalSpentMinor: '0',
        appointmentCount: 0,
      });
    });

    it('lower-cases an email so two spellings are one customer', async () => {
      const address = `Mixed.Case.${unique++}@Example.COM`;
      const created = await makeCustomer({ email: address });

      expect(created.email).toBe(address.toLowerCase());
    });

    it('reads one back', async () => {
      const created = await makeCustomer({ firstName: 'Bat', lastName: 'Erdene' });

      const res = await request(http)
        .get(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data).toMatchObject({ id: created.id, fullName: 'Bat Erdene' });
    });

    it('updates', async () => {
      const created = await makeCustomer();

      const res = await request(http)
        .patch(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ lastName: 'Renamed', address: 'Somewhere else', notes: null })
        .expect(200);

      expect(res.body.data).toMatchObject({
        lastName: 'Renamed',
        address: 'Somewhere else',
        notes: null,
      });
    });

    it('re-saving an unchanged form does not collide the customer with themselves', async () => {
      // The bug this guards: a naive uniqueness recheck finds the row being
      // edited and refuses every second save.
      const email = mail();
      const created = await makeCustomer({ email });

      await request(http)
        .patch(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ email, phone: created.phone, firstName: 'Sara' })
        .expect(200);
    });

    it('records and clears a preferred employee', async () => {
      const created = await makeCustomer({ preferredEmployeeId: employeeA });

      const res = await request(http)
        .get(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.preferredEmployeeName).toBe('Stylist');

      const cleared = await request(http)
        .patch(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ preferredEmployeeId: null })
        .expect(200);
      expect(cleared.body.data.preferredEmployeeId).toBeNull();
    });
  });

  // ===========================================================================
  describe('soft delete', () => {
    it('archives rather than removing, and hides the row', async () => {
      const created = await makeCustomer();

      await request(http)
        .delete(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const row = await harness.prisma.companyCustomer.findUniqueOrThrow({
        where: { id: created.id },
      });
      // The row stays: appointments, payments and invoices reference it.
      expect(row.deletedAt).not.toBeNull();
      expect(row.status).toBe('ARCHIVED');

      await request(http)
        .get(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('frees the phone number for a new record', async () => {
      /**
       * Both unique indexes are filtered on `deleted_at IS NULL`. This is what
       * a receptionist expects when somebody deleted by mistake walks back in —
       * and it is also why a delete is not a way to hide a duplicate: the old
       * row is still joined to its appointments.
       */
      const number = phone();
      const first = await makeCustomer({ phone: number });

      await request(http)
        .delete(`${url()}/${first.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const second = await makeCustomer({ phone: number });
      expect(second.id).not.toBe(first.id);
    });

    it('excludes deleted customers from the list', async () => {
      const created = await makeCustomer({ firstName: `Gone${Date.now()}` });
      await request(http)
        .delete(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const res = await request(http)
        .get(`${url()}?search=Gone`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.items.map((c: { id: string }) => c.id)).not.toContain(created.id);
    });

    it('refuses to delete twice', async () => {
      const created = await makeCustomer();
      await request(http)
        .delete(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);
      await request(http)
        .delete(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('duplicates', () => {
    it('refuses a duplicate phone and names the existing customer', async () => {
      const number = phone();
      const first = await makeCustomer({ firstName: 'Original', phone: number });

      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Duplicate', phone: number })
        .expect(409);

      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details).toMatchObject({
        field: 'phone',
        // The id is what lets the UI offer "open that customer" instead of
        // leaving somebody to search for a record they were just told exists.
        existingCustomerId: first.id,
        existingCustomerName: 'Original',
      });
    });

    it('refuses a duplicate email', async () => {
      const address = mail();
      await makeCustomer({ email: address });

      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Duplicate', email: address })
        .expect(409);
      expect(res.body.error.details?.field).toBe('email');
    });

    it('catches a duplicate written in a different format', async () => {
      // Normalisation is what makes the index mean anything: without it these
      // two strings are different rows for the same person.
      await makeCustomer({ phone: '+976 8800 1122' });

      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Same person', phone: '+976-8800-1122' })
        .expect(409);
    });

    it('catches a duplicate email in a different case', async () => {
      const address = `Case.${unique++}@example.com`;
      await makeCustomer({ email: address });

      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Same person', email: address.toUpperCase() })
        .expect(409);
    });

    it('refuses moving one customer onto another’s phone', async () => {
      const number = phone();
      await makeCustomer({ phone: number });
      const other = await makeCustomer();

      await request(http)
        .patch(`${url()}/${other.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ phone: number })
        .expect(409);
    });

    it('allows the same phone in a different company', async () => {
      // Two companies hold independently editable records of the same human.
      // The whole point of `company_customer` being the relationship.
      const number = phone();
      await makeCustomer({ phone: number });

      await request(http)
        .post(url(world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ firstName: 'Same human', phone: number })
        .expect(201);
    });

    it('does not count a soft-deleted customer as a duplicate', async () => {
      const address = mail();
      const first = await makeCustomer({ email: address });
      await request(http)
        .delete(`${url()}/${first.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Reborn', email: address })
        .expect(201);
    });
  });

  // ===========================================================================
  describe('validation', () => {
    it('refuses a customer with neither phone nor email', async () => {
      // Unreachable and unfindable; two of them are indistinguishable at the desk.
      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Nobody' })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/phone number or an email/i);
    });

    it.each([
      ['an empty first name', { firstName: '' }],
      ['a malformed email', { email: 'not-an-email' }],
      ['letters in the phone', { phone: 'call me' }],
      ['a phone that is too short', { phone: '12' }],
      ['a malformed birth date', { birthDate: '01/02/2000' }],
      ['an unknown status', { status: 'DELETED' }],
      ['an unknown field', { name: 'Sara' }],
      ['a companyId', { companyId: '018f0000-0000-7000-8000-0000000000ff' }],
      ['a writable visit count', { totalVisits: 99 }],
      ['a writable lifetime spend', { totalSpentMinor: '999999' }],
    ])('rejects %s', async (_label, patch) => {
      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Sara', phone: phone(), ...patch })
        .expect(400);
    });

    it('rejects an empty update', async () => {
      const created = await makeCustomer();
      await request(http)
        .patch(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({})
        .expect(400);
    });

    it('rejects an unknown query parameter', async () => {
      await request(http)
        .get(`${url()}?companyId=${world.companyB.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(400);
    });
  });

  // ===========================================================================
  describe('search, filter, pagination', () => {
    it('searches first name, last name and email', async () => {
      const marker = `Zx${Date.now()}`;
      const created = await makeCustomer({
        firstName: marker,
        lastName: `${marker}son`,
        email: `${marker.toLowerCase()}@example.com`,
      });

      for (const term of [marker.toLowerCase(), `${marker}son`, `${marker.toLowerCase()}@exa`]) {
        const res = await request(http)
          .get(`${url()}?search=${encodeURIComponent(term)}`)
          .set('Authorization', `Bearer ${ownerA}`)
          .expect(200);
        expect(res.body.data.items.map((c: { id: string }) => c.id)).toContain(created.id);
      }
    });

    it('finds a customer by a phone number typed with spaces', async () => {
      // The one format people actually paste out of a message.
      const created = await makeCustomer({ phone: '+976 7711 4455' });

      const res = await request(http)
        .get(`${url()}?search=${encodeURIComponent('7711 4455')}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.items.map((c: { id: string }) => c.id)).toContain(created.id);
    });

    it('filters by status and tag', async () => {
      const tagged = await makeCustomer({ tags: ['loyal'], status: 'BLOCKED' });

      const byTag = await request(http)
        .get(`${url()}?tag=loyal`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(byTag.body.data.items.map((c: { id: string }) => c.id)).toContain(tagged.id);

      const byStatus = await request(http)
        .get(`${url()}?status=ACTIVE`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(byStatus.body.data.items.map((c: { id: string }) => c.id)).not.toContain(tagged.id);
    });

    it('filters to customers who have never been in', async () => {
      const res = await request(http)
        .get(`${url()}?hasVisited=false`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(
        res.body.data.items.every((c: { lastVisitAt: string | null }) => c.lastVisitAt === null),
      ).toBe(true);
    });

    it('paginates and reports the whole total', async () => {
      const res = await request(http)
        .get(`${url()}?limit=2`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      expect(res.body.data.total).toBeGreaterThan(2);
      expect(res.body.data).toMatchObject({ limit: 2, offset: 0 });
    });

    it('sorts by name', async () => {
      const res = await request(http)
        .get(`${url()}?sortBy=firstName&sortOrder=asc&limit=100`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const names = res.body.data.items.map((c: { firstName: string }) => c.firstName);
      expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names);
    });
  });

  // ===========================================================================
  describe('appointment history', () => {
    it('returns what the customer has booked, newest first', async () => {
      const created = await makeCustomer();

      for (const [n, day] of [
        ['A', '2026-11-01'],
        ['B', '2026-11-05'],
      ] as const) {
        await harness.prisma.appointment.create({
          data: {
            companyId: world.companyA.id,
            branchId: world.companyA.branchId,
            customerId: created.id,
            appointmentNumber: `HIST-${Date.now()}-${n}`,
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            source: 'STAFF',
            startsAt: new Date(`${day}T02:00:00Z`),
            endsAt: new Date(`${day}T03:00:00Z`),
            bookedTimezoneName: 'Asia/Ulaanbaatar',
            currencyCode: 'MNT',
            totalMinor: 4_500_000n,
          },
        });
      }

      const res = await request(http)
        .get(`${url()}/${created.id}/appointments`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items[0].appointmentNumber).toMatch(/-B$/);
      // Money as a string: the column is BigInt.
      expect(res.body.data.items[0].totalMinor).toBe('4500000');
      expect(res.body.data.items[0].branchName).toContain('Company A');
    });

    it('counts appointments on the customer record', async () => {
      const created = await makeCustomer();
      await harness.prisma.appointment.create({
        data: {
          companyId: world.companyA.id,
          branchId: world.companyA.branchId,
          customerId: created.id,
          appointmentNumber: `CNT-${Date.now()}`,
          status: 'CONFIRMED',
          paymentStatus: 'UNPAID',
          source: 'STAFF',
          startsAt: new Date('2026-12-01T02:00:00Z'),
          endsAt: new Date('2026-12-01T03:00:00Z'),
          bookedTimezoneName: 'Asia/Ulaanbaatar',
          currencyCode: 'MNT',
          totalMinor: 0n,
        },
      });

      const res = await request(http)
        .get(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.data.appointmentCount).toBe(1);
    });

    it('the database refuses an appointment pointing at another company’s customer', async () => {
      /**
       * The property the brief asks for, asserted where it is actually
       * enforced. `appointment.customer` is a COMPOSITE foreign key on
       * `(company_id, customer_id)` referencing `(company_id, id)`, so a
       * cross-company reference is unrepresentable — there is no application
       * check to bypass, and no code path that could forget one.
       */
      const theirs = await makeCustomer({}, ownerB, world.companyB.id);

      await expect(
        harness.prisma.appointment.create({
          data: {
            companyId: world.companyA.id,
            branchId: world.companyA.branchId,
            customerId: theirs.id,
            appointmentNumber: `XT-${Date.now()}`,
            status: 'PENDING',
            paymentStatus: 'UNPAID',
            source: 'STAFF',
            startsAt: new Date('2026-12-02T02:00:00Z'),
            endsAt: new Date('2026-12-02T03:00:00Z'),
            bookedTimezoneName: 'Asia/Ulaanbaatar',
            currencyCode: 'MNT',
            totalMinor: 0n,
          },
        }),
      ).rejects.toThrow();
    });

    it('never shows another company’s appointments', async () => {
      const theirs = await makeCustomer({}, ownerB, world.companyB.id);

      await request(http)
        .get(`${url()}/${theirs.id}/appointments`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('cannot read, update or delete another company’s customer', async () => {
      const theirs = await makeCustomer({ firstName: 'Untouchable' }, ownerB, world.companyB.id);

      // Through A's own company path — the attack a naive lookup misses.
      await request(http)
        .get(`${url()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
      await request(http)
        .patch(`${url()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Hijacked' })
        .expect(404);
      await request(http)
        .delete(`${url()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);

      const row = await harness.prisma.companyCustomer.findUniqueOrThrow({
        where: { id: theirs.id },
      });
      expect(row.firstName).toBe('Untouchable');
      expect(row.deletedAt).toBeNull();
    });

    it('cannot address another company’s customer through their own company path', async () => {
      const theirs = await makeCustomer({}, ownerB, world.companyB.id);

      // 404, not 403: a 403 would confirm the company exists.
      await request(http)
        .get(`/api/v1/companies/${world.companyB.id}/customers/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });

    it('cannot set another company’s employee as preferred', async () => {
      const employeeB = await harness.prisma.employee.create({
        data: { companyId: world.companyB.id, displayName: 'Theirs' },
      });

      const res = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ firstName: 'Cross', phone: phone(), preferredEmployeeId: employeeB.id })
        .expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      // Nothing partially created — the employee is validated first.
      expect(
        await harness.prisma.companyCustomer.count({
          where: { firstName: 'Cross', companyId: world.companyA.id },
        }),
      ).toBe(0);
    });

    it('never lists another company’s customers', async () => {
      const theirs = await makeCustomer({}, ownerB, world.companyB.id);

      const res = await request(http)
        .get(`${url()}?limit=100`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.data.items.map((c: { id: string }) => c.id)).not.toContain(theirs.id);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('rejects an anonymous caller', async () => {
      await request(http).get(url()).expect(401);
    });

    it('lets a read-only member read but not write', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);

      await request(http).get(url()).set('Authorization', `Bearer ${reader}`).expect(200);

      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${reader}`)
        .send({ firstName: 'Nope', phone: phone() })
        .expect(403);
    });

    it('lets a receptionist create and edit — that is the job', async () => {
      const reception = await memberWithRole(SYSTEM_ROLES.RECEPTIONIST);

      const created = await request(http)
        .post(url())
        .set('Authorization', `Bearer ${reception}`)
        .send({ firstName: 'Walk-in', phone: phone() })
        .expect(201);

      await request(http)
        .patch(`${url()}/${created.body.data.id}`)
        .set('Authorization', `Bearer ${reception}`)
        .send({ lastName: 'Booked' })
        .expect(200);
    });

    it('refuses an employee-role member from editing customers', async () => {
      // EMPLOYEE holds customer:read but not customer:write — a stylist sees who
      // is coming in, they do not maintain the customer list.
      const staff = await memberWithRole(SYSTEM_ROLES.EMPLOYEE);

      await request(http).get(url()).set('Authorization', `Bearer ${staff}`).expect(200);
      await request(http)
        .post(url())
        .set('Authorization', `Bearer ${staff}`)
        .send({ firstName: 'Nope', phone: phone() })
        .expect(403);
    });

    it('refuses the appointment history to a role without appointment:read:any', async () => {
      /**
       * Seeing a customer record is a different decision from seeing everything
       * they have ever booked. EMPLOYEE holds `appointment:read:own`, which is
       * a record-level narrowing this endpoint cannot express, so the history
       * is refused rather than silently widened.
       */
      const staff = await memberWithRole(SYSTEM_ROLES.EMPLOYEE);
      const created = await makeCustomer();

      await request(http)
        .get(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${staff}`)
        .expect(200);
      await request(http)
        .get(`${url()}/${created.id}/appointments`)
        .set('Authorization', `Bearer ${staff}`)
        .expect(403);
    });
  });

  // ===========================================================================
  describe('audit', () => {
    it('records creation, update and deactivation against the company', async () => {
      const created = await makeCustomer();
      await request(http)
        .patch(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ lastName: 'Audited' })
        .expect(200);
      await request(http)
        .delete(`${url()}/${created.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      for (const action of ['customer.created', 'customer.updated', 'customer.deactivated']) {
        const entry = await harness.prisma.auditLog.findFirst({
          where: { action, resourceId: created.id },
        });
        expect(entry?.companyId).toBe(world.companyA.id);
        expect(entry?.actorType).toBe('COMPANY_USER');
      }
    });

    it('keeps the free-text notes out of the audit trail', async () => {
      // At a clinic that field holds medical detail. Contact changes are
      // audited because "who changed this number" is a real question; the note
      // body is not, and nobody audits it field by field.
      const created = await makeCustomer({ notes: 'SENSITIVE-NOTE-BODY' });

      const entry = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'customer.created', resourceId: created.id },
      });
      expect(JSON.stringify(entry.after)).not.toContain('SENSITIVE-NOTE-BODY');
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
        email: `cust-${roleKey}-${Date.now()}-${unique++}@example.com`,
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
