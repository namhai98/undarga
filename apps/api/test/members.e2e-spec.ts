import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * Member and role administration: who can sign in, and what they may do.
 * The three rules (not yourself, not the owner, not beyond your own access)
 * and tenant isolation are the substance.
 */
describe('members', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;
  let unique = 0;

  const api = (path: string) => `/api/v1/members${path}`;
  const as = (token: string) => ({
    get: (path: string) => request(http).get(api(path)).set('Authorization', `Bearer ${token}`),
    put: (path: string, body: object) =>
      request(http).put(api(path)).set('Authorization', `Bearer ${token}`).send(body),
    del: (path: string) => request(http).delete(api(path)).set('Authorization', `Bearer ${token}`),
  });

  /** A member of company A holding a copy of a system role's permissions. */
  async function member(roleKey: string, extra: string[] = [], isOwner = false) {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `member-${Date.now()}-${unique++}@example.com`,
        fullName: `${roleKey} Person`,
        status: 'ACTIVE',
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE', isOwner },
    });
    const template = await harness.prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
      include: { permissions: true },
    });
    const role = await harness.prisma.companyRole.create({
      data: { companyId: world.companyA.id, key: `T_${roleKey}_${unique++}`, name: roleKey },
    });
    await harness.prisma.companyRolePermission.createMany({
      data: [...new Set([...template.permissions.map((p) => p.permissionKey), ...extra])].map(
        (permissionKey) => ({ companyId: world.companyA.id, roleId: role.id, permissionKey }),
      ),
    });
    await harness.prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });
    const token = await harness.staffTokenForCompany(account.email, world.companyA.id);
    return { id: membership.id, token };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
  });

  afterAll(async () => harness.close());

  it('lists members with their roles, marking the owner and the caller', async () => {
    const m = await member(SYSTEM_ROLES.RECEPTIONIST);
    const owner = await member(SYSTEM_ROLES.OWNER, [], true);
    const res = await as(ownerA).get('').expect(200);
    const items = res.body.data.items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.id === owner.id)).toMatchObject({ isOwner: true, isYou: false });
    expect(items.find((i) => i.isYou)).toMatchObject({ userAccountId: world.userA.id });
    expect(items.find((i) => i.id === m.id)).toMatchObject({
      isOwner: false,
      isYou: false,
      roles: [expect.objectContaining({ name: SYSTEM_ROLES.RECEPTIONIST })],
    });
  });

  it('lists the roles with their permissions', async () => {
    const res = await as(ownerA).get('/roles').expect(200);
    const admin = res.body.data.items.find((r: { key: string }) => r.key === SYSTEM_ROLES.ADMIN);
    expect(admin.permissions).toContain('member:write');
    expect(admin.permissions).not.toContain('member:remove');
  });

  it('changes a member’s roles, effective on their very next request', async () => {
    const m = await member(SYSTEM_ROLES.ADMIN);
    await request(http)
      .get(`/api/v1/companies/${world.companyA.id}/customers`)
      .set('Authorization', `Bearer ${m.token}`)
      .expect(200);

    const res = await as(ownerA)
      .put(`/${m.id}/roles`, { roleKeys: [SYSTEM_ROLES.READ_ONLY] })
      .expect(200);
    expect(res.body.data.roles.map((r: { key: string }) => r.key)).toEqual([
      SYSTEM_ROLES.READ_ONLY,
    ]);

    // Read-only now: a write is refused straight away.
    await request(http)
      .post(`/api/v1/companies/${world.companyA.id}/customers`)
      .set('Authorization', `Bearer ${m.token}`)
      .send({ firstName: 'Nope', phone: '+97688000000' })
      .expect(403);

    const audit = await harness.prisma.auditLog.findFirst({
      where: { action: 'member.roles_changed', resourceId: m.id },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses changes to your own access', async () => {
    const admin = await member(SYSTEM_ROLES.ADMIN);
    const res = await as(admin.token)
      .put(`/${admin.id}/roles`, { roleKeys: [SYSTEM_ROLES.ADMIN] })
      .expect(403);
    expect(res.body.error.code).toBe('SELF_MODIFICATION_BLOCKED');
  });

  it('never touches the owner', async () => {
    const admin = await member(SYSTEM_ROLES.ADMIN);
    const owner = await member(SYSTEM_ROLES.OWNER, [], true);
    const res = await as(admin.token)
      .put(`/${owner.id}/roles`, { roleKeys: [SYSTEM_ROLES.READ_ONLY] })
      .expect(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });

  it('refuses granting more than you hold', async () => {
    const admin = await member(SYSTEM_ROLES.ADMIN);
    const target = await member(SYSTEM_ROLES.RECEPTIONIST);
    // OWNER carries member:remove and billing:write, which ADMIN does not.
    const res = await as(admin.token)
      .put(`/${target.id}/roles`, { roleKeys: [SYSTEM_ROLES.OWNER] })
      .expect(403);
    expect(res.body.error.code).toBe('PRIVILEGE_ESCALATION_BLOCKED');
  });

  it('refuses changing someone whose access exceeds yours', async () => {
    const admin = await member(SYSTEM_ROLES.ADMIN);
    const senior = await member(SYSTEM_ROLES.ADMIN, ['member:remove']);
    const res = await as(admin.token)
      .put(`/${senior.id}/roles`, { roleKeys: [SYSTEM_ROLES.READ_ONLY] })
      .expect(409);
    expect(res.body.error.details.permissions).toEqual(['member:remove']);
  });

  it('rejects an unknown role', async () => {
    const m = await member(SYSTEM_ROLES.RECEPTIONIST);
    await as(ownerA)
      .put(`/${m.id}/roles`, { roleKeys: ['NO_SUCH_ROLE'] })
      .expect(400);
  });

  it('removes a member: their access here ends at once, their login stays', async () => {
    const m = await member(SYSTEM_ROLES.RECEPTIONIST);
    await as(ownerA).del(`/${m.id}`).expect(204);

    const after = await request(http)
      .get(`/api/v1/companies/${world.companyA.id}/customers`)
      .set('Authorization', `Bearer ${m.token}`);
    expect([403, 404]).toContain(after.status);
    const row = await harness.prisma.companyUser.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.deletedAt).not.toBeNull();
    const account = await harness.prisma.userAccount.findUniqueOrThrow({
      where: { id: row.userAccountId },
    });
    expect(account.status).toBe('ACTIVE');
  });

  it('needs member:remove to remove someone', async () => {
    const admin = await member(SYSTEM_ROLES.ADMIN);
    const target = await member(SYSTEM_ROLES.RECEPTIONIST);
    await as(admin.token).del(`/${target.id}`).expect(403);
  });

  describe('custom roles', () => {
    const post = (token: string, body: object) =>
      request(http).post(api('/roles')).set('Authorization', `Bearer ${token}`).send(body);
    const patch = (token: string, key: string, body: object) =>
      request(http)
        .patch(api(`/roles/${key}`))
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('creates a role, gives it to a member, and its permissions take effect', async () => {
      const created = await post(ownerA, {
        name: 'Front desk lead',
        permissions: ['customer:read', 'customer:write'],
      }).expect(201);
      expect(created.body.data).toMatchObject({ key: 'C_FRONT_DESK_LEAD', isSystem: false });
      expect(created.body.data.permissions).toEqual(['customer:read', 'customer:write']);

      const m = await member(SYSTEM_ROLES.READ_ONLY);
      await as(ownerA)
        .put(`/${m.id}/roles`, { roleKeys: [SYSTEM_ROLES.READ_ONLY, 'C_FRONT_DESK_LEAD'] })
        .expect(200);
      await request(http)
        .post(`/api/v1/companies/${world.companyA.id}/customers`)
        .set('Authorization', `Bearer ${m.token}`)
        .send({ firstName: 'Via role', phone: `+97688${String(Date.now()).slice(-6)}` })
        .expect(201);

      // Taking the permission off the role takes it off the member at once.
      await patch(ownerA, 'C_FRONT_DESK_LEAD', { permissions: ['customer:read'] }).expect(200);
      await request(http)
        .post(`/api/v1/companies/${world.companyA.id}/customers`)
        .set('Authorization', `Bearer ${m.token}`)
        .send({ firstName: 'Nope', phone: `+97689${String(Date.now()).slice(-6)}` })
        .expect(403);

      // Held by someone: cannot be deleted.
      const del = await request(http)
        .delete(api('/roles/C_FRONT_DESK_LEAD'))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(409);
      expect(del.body.error.code).toBe('ROLE_IN_USE');
    });

    it('never changes a built-in role', async () => {
      const res = await patch(ownerA, SYSTEM_ROLES.RECEPTIONIST, { name: 'Renamed' }).expect(409);
      expect(res.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    });

    it('refuses a role with permissions its creator does not hold', async () => {
      const admin = await member(SYSTEM_ROLES.ADMIN);
      const res = await post(admin.token, {
        name: 'Sneaky',
        permissions: ['customer:read', 'member:remove'],
      }).expect(403);
      expect(res.body.error.code).toBe('PRIVILEGE_ESCALATION_BLOCKED');
      await post(admin.token, { name: 'Typo', permissions: ['no:such'] }).expect(400);
    });

    it('deletes an unused role', async () => {
      await post(ownerA, { name: 'Temp', permissions: ['customer:read'] }).expect(201);
      await request(http)
        .delete(api('/roles/C_TEMP'))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(204);
      const roles = await as(ownerA).get('/roles').expect(200);
      expect(roles.body.data.items.some((r: { key: string }) => r.key === 'C_TEMP')).toBe(false);
    });
  });

  it('keeps companies apart', async () => {
    const m = await member(SYSTEM_ROLES.RECEPTIONIST);
    await as(ownerB)
      .put(`/${m.id}/roles`, { roleKeys: [SYSTEM_ROLES.READ_ONLY] })
      .expect(404);
    await as(ownerB).del(`/${m.id}`).expect(404);
    const list = await as(ownerB).get('').expect(200);
    expect(list.body.data.items.some((i: { id: string }) => i.id === m.id)).toBe(false);
  });
});
