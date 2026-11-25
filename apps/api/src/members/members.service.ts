import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ALL_COMPANY_PERMISSIONS } from '../authz/permissions';
import {
  ConflictError,
  LastOwnerError,
  PrivilegeEscalationError,
  ResourceNotFoundError,
  RoleInUseError,
  SelfModificationBlockedError,
  SystemRoleImmutableError,
  ValidationFailedError,
} from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { MembershipService } from '../tenancy/membership/membership.service';

export interface MemberSummary {
  id: string;
  userAccountId: string;
  email: string | null;
  name: string | null;
  status: string;
  isOwner: boolean;
  isYou: boolean;
  roles: Array<{ key: string; name: string }>;
  joinedAt: string | null;
}

/**
 * The people who can sign in to this company, and what they may do.
 *
 * ===========================================================================
 * THREE RULES, CHECKED UNDER THE ROW LOCK
 * ===========================================================================
 *
 *   1. Nobody changes their own access — no self-promotion, no accidental
 *      self-lockout.
 *   2. The owner's access is not changed here; a company always keeps one.
 *   3. You may only touch someone whose access is a subset of yours, and only
 *      hand out what you hold. Otherwise `member:write` would be a way to
 *      demote your manager or to manufacture an administrator.
 *
 * Permissions are cached per member for a short while; every change here
 * invalidates that member so it takes effect on their next request.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
    private readonly memberships: MembershipService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<{ items: MemberSummary[] }> {
    const me = this.context.requireTenant('list members').membership;
    return this.inCompany(async (tx, companyId) => {
      const rows = await tx.companyUser.findMany({
        where: { companyId, deletedAt: null },
        orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          userAccountId: true,
          status: true,
          isOwner: true,
          displayName: true,
          joinedAt: true,
          userAccount: { select: { email: true, fullName: true } },
          roles: {
            where: { role: { deletedAt: null } },
            select: { role: { select: { key: true, name: true } } },
          },
        },
      });
      return {
        items: rows.map((r) => ({
          id: r.id,
          userAccountId: r.userAccountId,
          email: r.userAccount?.email ?? null,
          name: r.displayName ?? r.userAccount?.fullName ?? null,
          status: r.status,
          isOwner: r.isOwner,
          isYou: r.id === me?.companyUserId,
          roles: r.roles.map((x) => ({ key: x.role.key, name: x.role.name })),
          joinedAt: r.joinedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  /** The roles a member can be given, with what each allows. */
  async roles() {
    return this.inCompany(async (tx, companyId) => {
      const roles = await tx.companyRole.findMany({
        where: { companyId, deletedAt: null },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        select: {
          key: true,
          name: true,
          description: true,
          isSystem: true,
          permissions: { select: { permissionKey: true } },
        },
      });
      return {
        items: roles.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          permissions: r.permissions.map((p) => p.permissionKey).sort(),
        })),
      };
    });
  }

  async setRoles(companyUserId: string, roleKeys: string[]) {
    const result = await this.inCompany(async (tx, companyId) => {
      const target = await this.lockTarget(tx, companyId, companyUserId);
      const roles = await tx.companyRole.findMany({
        where: { companyId, key: { in: [...new Set(roleKeys)] }, deletedAt: null },
        select: { id: true, key: true },
      });
      const missing = roleKeys.filter((k) => !roles.some((r) => r.key === k));
      if (missing.length > 0) {
        throw new ValidationFailedError({ roleKeys: `Unknown role(s): ${missing.join(', ')}.` });
      }
      await this.assertMayGrant(
        tx,
        companyId,
        roles.map((r) => r.id),
      );

      const before = await tx.companyUserRole.findMany({
        where: { companyId, companyUserId },
        select: { role: { select: { key: true } } },
      });
      await tx.companyUserRole.deleteMany({ where: { companyId, companyUserId } });
      await tx.companyUserRole.createMany({
        data: roles.map((r) => ({ companyId, companyUserId, roleId: r.id })),
      });
      return { target, before: before.map((b) => b.role.key).sort() };
    });

    this.memberships.invalidateUser(this.context.requireCompanyId(), result.target.userAccountId);
    await this.audit.record({
      action: 'member.roles_changed',
      resourceType: 'company_user',
      resourceId: companyUserId,
      before: { roleKeys: result.before },
      after: { roleKeys: [...new Set(roleKeys)].sort() },
    });
    const { items } = await this.list();
    return items.find((m) => m.id === companyUserId)!;
  }

  /**
   * Remove a member from this company. Their login stays (they may belong to
   * other companies); their access here ends on their next request.
   */
  async remove(companyUserId: string): Promise<void> {
    const target = await this.inCompany(async (tx, companyId) => {
      const row = await this.lockTarget(tx, companyId, companyUserId);
      const { count } = await tx.companyUser.updateMany({
        where: { id: companyUserId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'DISABLED' },
      });
      if (count === 0) throw new ResourceNotFoundError('Member', companyUserId);
      return row;
    });

    this.memberships.invalidateUser(this.context.requireCompanyId(), target.userAccountId);
    await this.audit.record({
      action: 'member.removed',
      resourceType: 'company_user',
      resourceId: companyUserId,
      before: { userAccountId: target.userAccountId },
    });
  }

  // ---------------------------------------------------------------------------
  // Custom roles
  // ---------------------------------------------------------------------------

  /** Every permission a company role can carry. */
  permissions() {
    return { items: [...ALL_COMPANY_PERMISSIONS].sort() };
  }

  /**
   * A role of the company's own. Its key is derived from the name; its
   * permissions may only be ones the creator holds.
   */
  async createRole(input: RoleInput) {
    const role = await this.inCompany(async (tx, companyId) => {
      const permissions = this.validPermissions(input.permissions);
      this.assertHolds(permissions);
      const base = roleKeyFrom(input.name);
      let key = base;
      for (
        let n = 2;
        await tx.companyRole.findFirst({
          where: { companyId, key, deletedAt: null },
          select: { id: true },
        });
        n++
      ) {
        key = `${base}_${n}`;
      }
      const created = await tx.companyRole.create({
        data: {
          companyId,
          key,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          isSystem: false,
        },
        select: { id: true, key: true },
      });
      await tx.companyRolePermission.createMany({
        data: permissions.map((permissionKey) => ({
          companyId,
          roleId: created.id,
          permissionKey,
        })),
      });
      return created;
    });
    await this.audit.record({
      action: 'role.created',
      resourceType: 'company_role',
      resourceId: role.id,
      after: { key: role.key, name: input.name, permissions: input.permissions },
    });
    return this.roleByKey(role.key);
  }

  /** Rename, re-describe or re-permission a custom role. Takes effect for its members at once. */
  async updateRole(key: string, input: Partial<RoleInput>) {
    const result = await this.inCompany(async (tx, companyId) => {
      const role = await this.customRole(tx, companyId, key);
      // Changing what a role does is granting it: its current and new
      // permissions must both be within the actor's own.
      const current = await tx.companyRolePermission.findMany({
        where: { companyId, roleId: role.id },
        select: { permissionKey: true },
      });
      this.assertHolds(current.map((c) => c.permissionKey));
      await tx.companyRole.updateMany({
        where: { id: role.id, companyId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
        },
      });
      if (input.permissions) {
        const permissions = this.validPermissions(input.permissions);
        this.assertHolds(permissions);
        await tx.companyRolePermission.deleteMany({ where: { companyId, roleId: role.id } });
        await tx.companyRolePermission.createMany({
          data: permissions.map((permissionKey) => ({ companyId, roleId: role.id, permissionKey })),
        });
      }
      return { id: role.id, before: current.map((c) => c.permissionKey).sort() };
    });
    // Everyone holding it is affected.
    this.memberships.invalidateCompany(this.context.requireCompanyId());
    await this.audit.record({
      action: 'role.updated',
      resourceType: 'company_role',
      resourceId: result.id,
      before: { permissions: result.before },
      after: { name: input.name, permissions: input.permissions },
    });
    return this.roleByKey(key);
  }

  async deleteRole(key: string): Promise<void> {
    const id = await this.inCompany(async (tx, companyId) => {
      const role = await this.customRole(tx, companyId, key);
      const [members, invitations] = await Promise.all([
        tx.companyUserRole.count({
          where: { companyId, roleId: role.id, companyUser: { deletedAt: null } },
        }),
        tx.companyInvitationRole.count({
          where: { companyId, roleId: role.id, invitation: { acceptedAt: null, revokedAt: null } },
        }),
      ]);
      if (members + invitations > 0) throw new RoleInUseError(members + invitations);
      await tx.companyRole.updateMany({
        where: { id: role.id, companyId },
        data: { deletedAt: new Date() },
      });
      return role.id;
    });
    await this.audit.record({
      action: 'role.deleted',
      resourceType: 'company_role',
      resourceId: id,
    });
  }

  private async roleByKey(key: string) {
    const { items } = await this.roles();
    return items.find((r) => r.key === key)!;
  }

  private async customRole(tx: TenantTx, companyId: string, key: string) {
    const role = await tx.companyRole.findFirst({
      where: { companyId, key, deletedAt: null },
      select: { id: true, isSystem: true },
    });
    if (!role) throw new ResourceNotFoundError('Role', key);
    if (role.isSystem) throw new SystemRoleImmutableError();
    return role;
  }

  private validPermissions(keys: string[]): string[] {
    const all = new Set<string>(ALL_COMPANY_PERMISSIONS);
    const unique = [...new Set(keys)];
    const unknown = unique.filter((k) => !all.has(k));
    if (unknown.length > 0) {
      throw new ValidationFailedError({
        permissions: `Unknown permission(s): ${unknown.join(', ')}.`,
      });
    }
    return unique;
  }

  /** The actor holds every one of these (the owner holds all). */
  private assertHolds(permissions: string[]) {
    const tenant = this.context.requireTenant('role permissions');
    if (tenant.membership?.isOwner) return;
    const missing = permissions.filter((p) => !tenant.permissions.has(p)).sort();
    if (missing.length > 0) throw new PrivilegeEscalationError(missing);
  }

  // ---------------------------------------------------------------------------

  private inCompany<T>(fn: (tx: TenantTx, companyId: string) => Promise<T>): Promise<T> {
    const companyId = this.context.requireCompanyId('members');
    return this.db.run((tx) => fn(tx, companyId));
  }

  /** The member, locked, after the three rules. */
  private async lockTarget(tx: TenantTx, companyId: string, companyUserId: string) {
    const tenant = this.context.requireTenant('change a member');
    // An UPDATE takes the row lock until the transaction ends, so two
    // administrators changing one member serialise here.
    const { count } = await tx.companyUser.updateMany({
      where: { id: companyUserId, companyId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (count === 0) throw new ResourceNotFoundError('Member', companyUserId);
    const row = await tx.companyUser.findFirstOrThrow({
      where: { id: companyUserId, companyId },
      select: { id: true, userAccountId: true, isOwner: true },
    });
    if (row.id === tenant.membership?.companyUserId) throw new SelfModificationBlockedError();
    if (row.isOwner) throw new LastOwnerError();

    // Rule 3, first half: the target holds nothing the actor lacks.
    const held = await tx.companyRolePermission.findMany({
      where: {
        companyId,
        role: { deletedAt: null, assignments: { some: { companyId, companyUserId } } },
      },
      select: { permissionKey: true },
    });
    if (!tenant.membership?.isOwner) {
      const beyond = [...new Set(held.map((h) => h.permissionKey))].filter(
        (k) => !tenant.permissions.has(k),
      );
      if (beyond.length > 0) {
        throw new ConflictError(
          'This member has access you do not hold, so you cannot change it.',
          {
            permissions: beyond.sort(),
          },
        );
      }
    }
    return { id: row.id, userAccountId: row.userAccountId };
  }

  /** Rule 3, second half: only hand out what you hold. */
  private async assertMayGrant(tx: TenantTx, companyId: string, roleIds: string[]) {
    const tenant = this.context.requireTenant('grant roles');
    if (tenant.membership?.isOwner) return;
    const granted = await tx.companyRolePermission.findMany({
      where: { companyId, roleId: { in: roleIds } },
      select: { permissionKey: true },
    });
    const missing = [...new Set(granted.map((g) => g.permissionKey))]
      .filter((k) => !tenant.permissions.has(k))
      .sort();
    if (missing.length > 0) throw new PrivilegeEscalationError(missing);
  }
}

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: string[];
}

/** "Front desk lead" → "FRONT_DESK_LEAD"; never collides with a system key's shape alone. */
function roleKeyFrom(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  // Names in another script (Cyrillic) leave no Latin letters: fall back.
  return /^[A-Z]/.test(slug) ? `C_${slug}` : 'C_ROLE';
}
