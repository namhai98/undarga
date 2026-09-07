import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, TEST_PASSWORD, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * INVITATIONS AND ACCEPTANCE
 * ===========================================================================
 *
 * End to end against a real PostgreSQL with RLS applied. The properties that
 * matter here — single-use tokens, atomic acceptance, tenant isolation — are
 * properties of the database and the guard chain, and a mocked Prisma would
 * assert none of them.
 */
describe('invitations', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  /** Owner of company A, so invitations can grant anything without escalating. */
  let ownerA: string;
  let provisionerToken: string;

  let unique = 0;
  const email = () => `invitee-${Date.now()}-${unique++}@example.com`;

  const invite = (body: object, bearer = ownerA) =>
    request(http)
      .post('/api/v1/members/invitations')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);

  const preview = (token: string) =>
    request(http).post('/api/v1/invitations/preview').send({ token });

  const accept = (body: object, bearer?: string) => {
    const req = request(http).post('/api/v1/invitations/accept');
    if (bearer) req.set('Authorization', `Bearer ${bearer}`);
    return req.send(body);
  };

  /**
   * A brand-new account that can already sign in.
   *
   * Each existing-account test needs its own, because the partial unique index
   * allows only one live invitation per address per company — two tests sharing
   * a fixture email would have the second refused with a 409 for reasons that
   * have nothing to do with what it is testing.
   */
  async function createExistingUser(): Promise<{ id: string; email: string }> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: email(),
        fullName: 'Existing Person',
        status: 'ACTIVE',
        passwordHash: known.passwordHash,
      },
      select: { id: true, email: true },
    });
    return account;
  }

  /** Provision a fresh company and return an owner token for it. */
  async function freshCompanyWithOwner() {
    const ownerEmail = email();
    const res = await request(http)
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${provisionerToken}`)
      .send({
        slug: `inv-${Date.now()}-${unique++}`,
        legalName: 'Invite Co LLC',
        displayName: 'Invite Co',
        defaultTimezoneName: 'UTC',
        currencyCode: 'MNT',
        owner: { email: ownerEmail, fullName: 'Owner Person' },
      })
      .expect(201);

    return { ...res.body.data, ownerEmail } as {
      company: { id: string; slug: string };
      owner: { userAccountId: string; companyUserId: string };
      ownerEmail: string;
    };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    provisionerToken = await harness.platformToken(world.provisioner.email);

    // Make userA an owner of company A so escalation does not obscure the
    // invitation tests. Escalation gets its own describe block below.
    await harness.prisma.companyUser.updateMany({
      where: { companyId: world.companyA.id, userAccountId: world.userA.id },
      data: { isOwner: true },
    });
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('creating an invitation', () => {
    it('returns a one-time token and the link to send', async () => {
      const to = email();
      const res = await invite({ email: to, roleKeys: [SYSTEM_ROLES.RECEPTIONIST] }).expect(201);

      expect(res.body.data).toMatchObject({
        email: to,
        status: 'PENDING',
        roles: [{ key: SYSTEM_ROLES.RECEPTIONIST }],
      });
      expect(res.body.data.token).toEqual(expect.any(String));
      // 32 bytes of CSPRNG, base64url. Guessing is not a threat model.
      expect(res.body.data.token.length).toBeGreaterThanOrEqual(43);
      expect(res.body.data.acceptUrl).toContain('/invitations/accept?token=');
    });

    it('stores only the HMAC, never the token', async () => {
      const res = await invite({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);
      const row = await harness.prisma.companyInvitation.findUnique({
        where: { id: res.body.data.id },
      });

      expect(row?.tokenHash).not.toBe(res.body.data.token);
      expect(row?.tokenHash).not.toContain(res.body.data.token);
    });

    it('never exposes the token again once created', async () => {
      await invite({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);

      const list = await request(http)
        .get('/api/v1/members/invitations')
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(list.body.data.items.length).toBeGreaterThan(0);
      for (const item of list.body.data.items) {
        expect(item.token).toBeUndefined();
      }
    });

    it('records who sent it', async () => {
      const res = await invite({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);
      const row = await harness.prisma.companyInvitation.findUnique({
        where: { id: res.body.data.id },
        include: { invitedBy: true },
      });

      expect(row?.invitedBy?.userAccountId).toBe(world.userA.id);
      expect(row?.companyId).toBe(world.companyA.id);
    });
  });

  // ===========================================================================
  describe('validation', () => {
    it.each([
      ['a malformed email', { email: 'nope', roleKeys: [SYSTEM_ROLES.EMPLOYEE] }],
      ['a missing email', { roleKeys: [SYSTEM_ROLES.EMPLOYEE] }],
      ['no roles at all', { email: 'a@b.com', roleKeys: [] }],
      ['a missing roleKeys', { email: 'a@b.com' }],
      ['a lowercase role key', { email: 'a@b.com', roleKeys: ['employee'] }],
      ['an expiry beyond the cap', { email: 'a@b.com', roleKeys: ['EMPLOYEE'], expiresInDays: 90 }],
    ])('rejects %s', async (_label, body) => {
      const res = await invite(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a role this company does not have', async () => {
      const res = await invite({ email: email(), roleKeys: ['NOT_A_ROLE'] }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/NOT_A_ROLE/);
    });

    it('refuses to invite somebody who is already a member', async () => {
      const res = await invite({
        email: world.userAB.email,
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(409);

      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details?.field).toBe('email');
    });

    it('refuses a second live invitation for the same address', async () => {
      const to = email();
      const first = await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);
      const second = await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(409);

      // The id lets the UI offer "rotate instead" rather than a dead end.
      expect(second.body.error.details?.invitationId).toBe(first.body.data.id);
    });

    it('allows re-inviting after a revoke', async () => {
      const to = email();
      const first = await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);

      await request(http)
        .delete(`/api/v1/members/invitations/${first.body.data.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('refuses an anonymous request', async () => {
      await request(http)
        .post('/api/v1/members/invitations')
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(401);
    });

    it('refuses a member without member:invite', async () => {
      // The seeded users all hold FULL, which grants everything — so this needs
      // a member with a genuinely narrow role. EMPLOYEE has no member:invite.
      const person = await createExistingUser();
      const membership = await harness.prisma.companyUser.create({
        data: { companyId: world.companyA.id, userAccountId: person.id, status: 'ACTIVE' },
      });
      const employee = await harness.prisma.companyRole.findFirstOrThrow({
        where: { companyId: world.companyA.id, key: SYSTEM_ROLES.EMPLOYEE },
      });
      await harness.prisma.companyUserRole.create({
        data: {
          companyId: world.companyA.id,
          companyUserId: membership.id,
          roleId: employee.id,
        },
      });

      const token = await harness.staffTokenForCompany(person.email, world.companyA.id);
      const res = await request(http)
        .post('/api/v1/members/invitations')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(403);

      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    });

    /**
     * The escalation rule.
     *
     * Without it, member:invite alone is a route to owner-equivalent access:
     * invite an address you control, attach a role you do not hold, accept.
     */
    it('refuses to grant permissions the inviter does not hold', async () => {
      const { company, ownerEmail } = await freshCompanyWithOwner();

      // A member who can invite but holds only receptionist-level permissions.
      const inviterEmail = email();
      const account = await harness.prisma.userAccount.create({
        data: { email: inviterEmail, fullName: 'Limited Inviter', status: 'ACTIVE' },
      });
      const membership = await harness.prisma.companyUser.create({
        data: { companyId: company.id, userAccountId: account.id, status: 'ACTIVE' },
      });
      const receptionist = await harness.prisma.companyRole.findFirstOrThrow({
        where: { companyId: company.id, key: SYSTEM_ROLES.RECEPTIONIST },
      });
      await harness.prisma.companyRolePermission.create({
        data: { companyId: company.id, roleId: receptionist.id, permissionKey: 'member:invite' },
      });
      await harness.prisma.companyUserRole.create({
        data: { companyId: company.id, companyUserId: membership.id, roleId: receptionist.id },
      });
      await harness.prisma.userAccount.update({
        where: { id: account.id },
        data: {
          passwordHash: (
            await harness.prisma.userAccount.findFirstOrThrow({ where: { id: world.userA.id } })
          ).passwordHash,
        },
      });

      const token = await harness.staffTokenForCompany(inviterEmail, company.id);

      const res = await request(http)
        .post('/api/v1/members/invitations')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: email(), roleKeys: [SYSTEM_ROLES.ADMIN] })
        .expect(403);

      expect(res.body.error.code).toBe('PRIVILEGE_ESCALATION_BLOCKED');
      // Names what to drop, rather than just refusing.
      expect(Array.isArray(res.body.error.details?.permissions)).toBe(true);
      expect(res.body.error.details.permissions.length).toBeGreaterThan(0);

      expect(ownerEmail).toBeDefined();
    });
  });

  // ===========================================================================
  describe('preview', () => {
    it('describes the invitation without any authentication', async () => {
      const to = email();
      const created = await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);

      const res = await preview(created.body.data.token).expect(200);

      expect(res.body.data).toMatchObject({
        companySlug: world.companyA.slug,
        email: to,
        accountExists: false,
      });
      expect(res.body.data.roles).toEqual([
        { key: SYSTEM_ROLES.EMPLOYEE, name: expect.any(String) },
      ]);
    });

    it('reports an existing account so the UI asks for a sign-in', async () => {
      const person = await createExistingUser();
      const created = await invite({
        email: person.email,
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const res = await preview(created.body.data.token).expect(200);
      expect(res.body.data.accountExists).toBe(true);
    });

    it('404s an unknown token', async () => {
      const res = await preview('a'.repeat(43)).expect(404);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
    });
  });

  // ===========================================================================
  describe('accepting — new account', () => {
    it('creates the account, the membership and the role assignment', async () => {
      const to = email();
      const created = await invite({
        email: to,
        roleKeys: [SYSTEM_ROLES.RECEPTIONIST, SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const res = await accept({
        token: created.body.data.token,
        fullName: 'New Person',
        password: 'a-perfectly-fine-password',
      }).expect(200);

      expect(res.body.data).toMatchObject({
        companyId: world.companyA.id,
        companySlug: world.companyA.slug,
        email: to,
        accountCreated: true,
      });

      const membership = await harness.prisma.companyUser.findUnique({
        where: { id: res.body.data.companyUserId },
        include: { roles: { include: { role: true } }, userAccount: true },
      });

      expect(membership).toMatchObject({ companyId: world.companyA.id, status: 'ACTIVE' });
      // Never an owner. Ownership comes only from provisioning.
      expect(membership?.isOwner).toBe(false);
      expect(membership?.joinedAt).not.toBeNull();
      expect(membership?.userAccount.email).toBe(to);
      expect(membership?.roles.map((r) => r.role.key).sort()).toEqual(
        [SYSTEM_ROLES.EMPLOYEE, SYSTEM_ROLES.RECEPTIONIST].sort(),
      );
    });

    it('returns no tokens — a stolen link is not exchangeable for a session', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const res = await accept({
        token: created.body.data.token,
        fullName: 'No Session',
        password: 'a-perfectly-fine-password',
      }).expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/accessToken|refreshToken/);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('lets the new member sign in and see their permissions', async () => {
      const to = email();
      const created = await invite({ email: to, roleKeys: [SYSTEM_ROLES.RECEPTIONIST] }).expect(201);
      await accept({
        token: created.body.data.token,
        fullName: 'Signs In',
        password: 'a-perfectly-fine-password',
      }).expect(200);

      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: to, password: 'a-perfectly-fine-password' })
        .expect(200);

      const ctx = await request(http)
        .get('/api/v1/me/context')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .expect(200);

      expect(ctx.body.data.company.id).toBe(world.companyA.id);
      expect(ctx.body.data.permissions).toContain('appointment:write');
      expect(ctx.body.data.permissions).not.toContain('settings:billing:write');
    });

    it('requires a password and a name', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const res = await accept({ token: created.body.data.token }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a password shorter than twelve characters', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      await accept({
        token: created.body.data.token,
        fullName: 'Short',
        password: 'short',
      }).expect(400);
    });
  });

  // ===========================================================================
  describe('accepting — existing account', () => {
    it('refuses without a session, rather than setting a password', async () => {
      // This is the property that stops a leaked link being a password reset
      // for somebody else's account.
      const person = await createExistingUser();
      const created = await invite({
        email: person.email,
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const res = await accept({
        token: created.body.data.token,
        fullName: 'Attacker',
        password: 'attackers-new-password',
      }).expect(401);

      expect(res.body.error.code).toBe('INVITATION_SIGN_IN_REQUIRED');

      // And the password really was not touched.
      await request(http)
        .post('/api/v1/auth/login')
        .send({ email: person.email, password: TEST_PASSWORD })
        .expect(200);
    });

    it('refuses a caller signed in as somebody else', async () => {
      const person = await createExistingUser();
      const created = await invite({
        email: person.email,
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      // userAB is a perfectly legitimate user — just not the invitee.
      const other = await harness.staffToken(world.userAB.email);
      const res = await accept({ token: created.body.data.token }, other).expect(403);

      expect(res.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
      // No membership was created for the wrong person.
      const wrong = await harness.prisma.companyUser.count({
        where: { companyId: world.companyA.id, userAccountId: world.userAB.id, joinedAt: null },
      });
      expect(wrong).toBe(0);
    });

    it('joins when the invitee is signed in as themselves', async () => {
      const { company } = await freshCompanyWithOwner();
      const owner = await harness.prisma.companyUser.findFirstOrThrow({
        where: { companyId: company.id, isOwner: true },
        include: { userAccount: true },
      });

      // Give the owner a password so they can sign in, then invite userB.
      const known = await harness.prisma.userAccount.findFirstOrThrow({
        where: { id: world.userA.id },
      });
      await harness.prisma.userAccount.update({
        where: { id: owner.userAccountId },
        data: { passwordHash: known.passwordHash, status: 'ACTIVE' },
      });
      await harness.prisma.companyUser.update({
        where: { id: owner.id },
        data: { status: 'ACTIVE', joinedAt: new Date() },
      });

      const ownerToken = await harness.staffTokenForCompany(owner.userAccount.email, company.id);
      const created = await request(http)
        .post('/api/v1/members/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: world.userB.email, roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(201);

      const invitee = await harness.staffToken(world.userB.email);
      const res = await accept({ token: created.body.data.token }, invitee).expect(200);

      expect(res.body.data).toMatchObject({ companyId: company.id, accountCreated: false });
    });
  });

  // ===========================================================================
  describe('the token is single-use', () => {
    it('refuses a second acceptance of the same link', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);
      const body = {
        token: created.body.data.token,
        fullName: 'Once Only',
        password: 'a-perfectly-fine-password',
      };

      await accept(body).expect(200);
      const second = await accept(body).expect(404);
      expect(second.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('creates exactly one membership under concurrent acceptance', async () => {
      // The compare-and-swap on acceptedAt is what makes this true; the unique
      // index on (company_id, user_account_id) is the second line of defence.
      const to = email();
      const created = await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);
      const body = {
        token: created.body.data.token,
        fullName: 'Racer',
        password: 'a-perfectly-fine-password',
      };

      const results = await Promise.all([accept(body), accept(body), accept(body)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);

      const account = await harness.prisma.userAccount.findFirstOrThrow({ where: { email: to } });
      const memberships = await harness.prisma.companyUser.count({
        where: { companyId: world.companyA.id, userAccountId: account.id },
      });
      expect(memberships).toBe(1);
    });

    it('refuses a revoked invitation with the same answer as an unknown one', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      await request(http)
        .delete(`/api/v1/members/invitations/${created.body.data.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);

      const revoked = await accept({
        token: created.body.data.token,
        fullName: 'Revoked',
        password: 'a-perfectly-fine-password',
      }).expect(404);
      const unknown = await accept({
        token: 'b'.repeat(43),
        fullName: 'Unknown',
        password: 'a-perfectly-fine-password',
      }).expect(404);

      // Byte-identical apart from the request id: a stolen token must not be
      // able to distinguish "withdrawn" from "never existed".
      expect({ ...revoked.body.error, requestId: null }).toEqual({
        ...unknown.body.error,
        requestId: null,
      });
    });

    it('kills the previous link when an invitation is rotated', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const rotated = await request(http)
        .post(`/api/v1/members/invitations/${created.body.data.id}/rotate`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({})
        .expect(200);

      expect(rotated.body.data.token).not.toBe(created.body.data.token);
      await preview(created.body.data.token).expect(404);
      await preview(rotated.body.data.token).expect(200);
    });
  });

  // ===========================================================================
  describe('expiry', () => {
    it('refuses an expired invitation with 410, and says so', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      // Backdate rather than wait. Expiry is derived from the timestamp on
      // every read, so there is no sweeper job to trigger.
      await harness.prisma.companyInvitation.update({
        where: { id: created.body.data.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await accept({
        token: created.body.data.token,
        fullName: 'Too Late',
        password: 'a-perfectly-fine-password',
      }).expect(410);

      // The one distinction worth drawing: expiry is actionable, and leaks
      // nothing an attacker could not learn by waiting.
      expect(res.body.error.code).toBe('INVITATION_EXPIRED');
      await preview(created.body.data.token).expect(410);
    });

    it('omits expired invitations from the live listing', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);
      await harness.prisma.companyInvitation.update({
        where: { id: created.body.data.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const live = await request(http)
        .get('/api/v1/members/invitations?status=live')
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      const all = await request(http)
        .get('/api/v1/members/invitations?status=all')
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      const ids = (r: { body: { data: { items: Array<{ id: string }> } } }) =>
        r.body.data.items.map((i) => i.id);

      expect(ids(live)).not.toContain(created.body.data.id);
      expect(ids(all)).toContain(created.body.data.id);
      expect(
        all.body.data.items.find((i: { id: string }) => i.id === created.body.data.id).status,
      ).toBe('EXPIRED');
    });

    it('can be rotated back to life', async () => {
      const created = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);
      await harness.prisma.companyInvitation.update({
        where: { id: created.body.data.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const rotated = await request(http)
        .post(`/api/v1/members/invitations/${created.body.data.id}/rotate`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({})
        .expect(200);

      await preview(rotated.body.data.token).expect(200);
    });
  });

  // ===========================================================================
  describe('atomicity', () => {
    /**
     * A failure inside the acceptance transaction must leave the invitation
     * usable, or the recipient is locked out with no way back.
     *
     * The failure is induced the way it would actually happen: the membership
     * write violates the unique index on (company_id, user_account_id) because
     * a membership already exists.
     */
    it('leaves the invitation pending when membership creation fails', async () => {
      const to = email();
      const created = await invite({ email: to, roleKeys: [SYSTEM_ROLES.EMPLOYEE] }).expect(201);

      // Create the account and a membership behind the endpoint's back, so the
      // insert inside the transaction collides.
      const account = await harness.prisma.userAccount.create({
        data: { email: to, fullName: 'Already Here', status: 'INVITED' },
      });
      await harness.prisma.companyUser.create({
        data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
      });

      await accept({
        token: created.body.data.token,
        fullName: 'Already Here',
        password: 'a-perfectly-fine-password',
      }).expect(500);

      const row = await harness.prisma.companyInvitation.findUnique({
        where: { id: created.body.data.id },
      });
      // Still claimable. If acceptedAt had stuck, the link would be dead and
      // the person permanently unable to join.
      expect(row?.acceptedAt).toBeNull();
      expect(row?.revokedAt).toBeNull();
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('never lists another company\'s invitations', async () => {
      const mine = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const otherToken = await harness.staffTokenForCompany(
        world.userAB.email,
        world.companyB.id,
      );
      const res = await request(http)
        .get('/api/v1/members/invitations?status=all')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);

      expect(res.body.data.items.map((i: { id: string }) => i.id)).not.toContain(mine.body.data.id);
    });

    it("404s a rotate of another company's invitation, and leaves its token working", async () => {
      // A successful cross-tenant rotate would silently kill a live invitation
      // in a company the caller cannot see — denial of service by side effect.
      const victim = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const attacker = await harness.staffTokenForCompany(world.userAB.email, world.companyB.id);
      await request(http)
        .post(`/api/v1/members/invitations/${victim.body.data.id}/rotate`)
        .set('Authorization', `Bearer ${attacker}`)
        .send({})
        .expect(404);

      await preview(victim.body.data.token).expect(200);
    });

    it("404s a revoke of another company's invitation, and leaves it live", async () => {
      const victim = await invite({
        email: email(),
        roleKeys: [SYSTEM_ROLES.EMPLOYEE],
      }).expect(201);

      const attacker = await harness.staffTokenForCompany(world.userAB.email, world.companyB.id);
      await request(http)
        .delete(`/api/v1/members/invitations/${victim.body.data.id}`)
        .set('Authorization', `Bearer ${attacker}`)
        .expect(404);

      const row = await harness.prisma.companyInvitation.findUnique({
        where: { id: victim.body.data.id },
      });
      expect(row?.revokedAt).toBeNull();
    });

    it('binds the membership to the invitation\'s company, not the caller\'s', async () => {
      // Accepting company A's token while holding a company B session must
      // produce a company A membership and nothing in company B.
      const { company } = await freshCompanyWithOwner();
      const ownerRow = await harness.prisma.companyUser.findFirstOrThrow({
        where: { companyId: company.id, isOwner: true },
        include: { userAccount: true },
      });
      const known = await harness.prisma.userAccount.findFirstOrThrow({
        where: { id: world.userA.id },
      });
      await harness.prisma.userAccount.update({
        where: { id: ownerRow.userAccountId },
        data: { passwordHash: known.passwordHash, status: 'ACTIVE' },
      });
      await harness.prisma.companyUser.update({
        where: { id: ownerRow.id },
        data: { status: 'ACTIVE', joinedAt: new Date() },
      });

      const ownerToken = await harness.staffTokenForCompany(
        ownerRow.userAccount.email,
        company.id,
      );
      const created = await request(http)
        .post('/api/v1/members/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: world.userB.email, roleKeys: [SYSTEM_ROLES.EMPLOYEE] })
        .expect(201);

      const inviteeInB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
      const res = await accept({ token: created.body.data.token }, inviteeInB).expect(200);

      expect(res.body.data.companyId).toBe(company.id);
      const inA = await harness.prisma.companyUser.count({
        where: { companyId: world.companyA.id, userAccountId: world.userB.id },
      });
      expect(inA).toBe(0);
    });
  });

  // ===========================================================================
  describe('the provisioning handshake', () => {
    /**
     * The whole point of the previous milestone: `requiresInvitation: true`
     * becomes actionable.
     */
    it('activates a provisioned owner rather than creating a second membership', async () => {
      const { company, owner, ownerEmail } = await freshCompanyWithOwner();

      // The owner's placeholder membership exists but is INVITED and has no
      // password, so nobody can sign in as them yet.
      const before = await harness.prisma.companyUser.findUniqueOrThrow({
        where: { id: owner.companyUserId },
      });
      expect(before.status).toBe('INVITED');

      const invitation = await harness.prisma.companyInvitation.create({
        data: {
          companyId: company.id,
          email: ownerEmail,
          tokenHash: 'placeholder',
          expiresAt: new Date(Date.now() + 86_400_000),
          companyUserId: owner.companyUserId,
        },
      });

      // Rotate through the API so the token is generated the real way.
      const ownerRow = await harness.prisma.companyUser.findFirstOrThrow({
        where: { companyId: company.id, isOwner: true },
      });
      expect(ownerRow.id).toBe(owner.companyUserId);

      const rotatedToken = await rotateAsPlatformOperator(invitation.id, company.id);

      const res = await accept({
        token: rotatedToken,
        fullName: 'Owner Person',
        password: 'a-perfectly-fine-password',
      }).expect(200);

      expect(res.body.data.companyUserId).toBe(owner.companyUserId);

      const after = await harness.prisma.companyUser.findUniqueOrThrow({
        where: { id: owner.companyUserId },
      });
      expect(after.status).toBe('ACTIVE');
      expect(after.joinedAt).not.toBeNull();
      expect(after.isOwner).toBe(true);

      // Exactly one membership, not two.
      const count = await harness.prisma.companyUser.count({
        where: { companyId: company.id, userAccountId: owner.userAccountId },
      });
      expect(count).toBe(1);
    });
  });

  /**
   * Rotate an invitation as a platform operator entering the tenant.
   *
   * Used only by the provisioning-handshake test, where no company member can
   * sign in yet — which is precisely the situation the operator path exists
   * for.
   */
  async function rotateAsPlatformOperator(invitationId: string, companyId: string) {
    const operator = await harness.platformToken(world.operator.email);
    const res = await request(http)
      .post(`/api/v1/members/invitations/${invitationId}/rotate`)
      .set('Authorization', `Bearer ${operator}`)
      .set('X-Company-Id', companyId)
      .send({})
      .expect(200);

    return res.body.data.token as string;
  }
});
