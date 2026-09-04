import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config';
import { TtlCache } from '../../common/cache';
import {
  MembershipInactiveError,
  PlatformAccessRequiredError,
  TenantNotFoundError,
  TenantSuspendedError,
} from '../../common/errors';
import {
  ALL_COMPANY_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  READ_ONLY_COMPANY_PERMISSIONS,
} from '../../authz/permissions';
import { TenantPrismaService } from '../../database/tenant-prisma.service';
import { TenantDirectoryService } from '../directory/tenant-directory.service';
import {
  isCompanyUser,
  isCustomerActor,
  isPlatformUser,
  type Actor,
  type CompanyOperationalStatus,
  type CurrentCompany,
  type CurrentMembership,
  type TenantContext,
  type TenantResolutionSource,
} from '../context/context.types';

interface ResolvedMembership {
  readonly membership: CurrentMembership;
  readonly permissions: readonly string[];
}

/**
 * The gate.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONLY PLACE A TenantContext IS CREATED
 * ---------------------------------------------------------------------------
 *
 * Resolvers say which company was *named*. This service decides whether the
 * actor may enter it, and it is the sole constructor of TenantContext. Because
 * nothing else can build one, holding a TenantContext anywhere in the codebase
 * is itself evidence that this check ran.
 *
 * That is the structural answer to "do not let a user pass companyId and get
 * that company": the id from the URL never becomes a scope directly. It becomes
 * an argument to this function, which looks for a membership and returns 404
 * when there is none.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MEMBERSHIP LOOKUP RUNS *INSIDE* THE CANDIDATE'S RLS SCOPE
 * ---------------------------------------------------------------------------
 *
 * `resolveMembership` sets the RLS context to the company being checked and
 * queries `company_user` there. That looks circular but is not: setting the
 * scope grants nothing, it only narrows. If the actor is not a member the query
 * returns zero rows and the request is refused, and no other statement ran in
 * that transaction.
 *
 * The alternative — checking membership on the BYPASSRLS connection — would
 * mean the authorization decision itself is made outside the mechanism that
 * enforces authorization. Doing it this way keeps the privileged connection out
 * of the request path entirely, and means a broken RLS policy fails closed
 * (no membership found) rather than open.
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);
  private readonly cache: TtlCache<ResolvedMembership | null>;

  constructor(
    private readonly db: TenantPrismaService,
    private readonly directory: TenantDirectoryService,
    private readonly config: AppConfig,
  ) {
    this.cache = new TtlCache(config.tenancy.cacheTtlSeconds * 1000, 50_000);
  }

  /**
   * Authorise `actor` for `companyId` and produce the request's tenant context.
   *
   * @throws TenantNotFoundError    company absent, or actor is not a member.
   *                                Deliberately the same error for both.
   * @throws TenantSuspendedError   company exists and the actor belongs, but it
   *                                is suspended.
   * @throws MembershipInactiveError membership exists but is invited/disabled.
   */
  async authorize(
    actor: Actor,
    companyId: string,
    source: TenantResolutionSource,
  ): Promise<TenantContext> {
    const company = await this.loadCompany(companyId);

    if (isPlatformUser(actor)) {
      return this.authorizePlatformOperator(actor, company, source);
    }

    if (isCustomerActor(actor)) {
      // A customer token is minted for exactly one company; presenting it
      // against another is a forged or replayed token.
      if (actor.companyId !== company.id) {
        throw new TenantNotFoundError();
      }
      return {
        company,
        membership: null,
        permissions: new Set<string>(),
        source,
        viaPlatformAccess: false,
      };
    }

    if (!isCompanyUser(actor)) {
      // SYSTEM actors get their context from the job runner, not from here.
      throw new TenantNotFoundError();
    }

    const resolved = await this.resolveMembership(company.id, actor.userAccountId);

    if (!resolved) {
      // The critical branch. "No such company" and "not your company" MUST be
      // indistinguishable: a 403 here turns any id into an existence oracle,
      // and UUIDv7 ids also encode a creation timestamp.
      this.logger.debug(
        `Denied: user ${actor.userAccountId} has no active membership of company ${company.id}`,
      );
      throw new TenantNotFoundError();
    }

    // Only reached once membership is proven, so revealing the company's state
    // tells the caller nothing they were not already entitled to know.
    this.assertCompanyUsable(company);

    return {
      company,
      membership: resolved.membership,
      permissions: new Set(resolved.permissions),
      source,
      viaPlatformAccess: false,
    };
  }

  // -------------------------------------------------------------------------
  // Platform operators
  // -------------------------------------------------------------------------

  /**
   * Cross-company access for platform staff.
   *
   * Three things are true here and each is deliberate:
   *
   *   1. It is never implicit. The operator must have named the company; this
   *      method is only reached because a resolver produced one. There is no
   *      "admin, so skip the filter" path anywhere in the codebase.
   *   2. It is permission-gated, by a PLATFORM permission that no company role
   *      can ever contain.
   *   3. It is still tenant-scoped at the database. The operator's queries run
   *      through the same RLS-bound connection with the same company set; the
   *      BYPASSRLS pool is not involved. They see one company at a time, and
   *      every read is as narrow as a member's would be.
   */
  private authorizePlatformOperator(
    actor: Extract<Actor, { kind: 'PLATFORM_USER' }>,
    company: CurrentCompany,
    source: TenantResolutionSource,
  ): TenantContext {
    const perms = actor.platformPermissions;
    const canRead = perms.has(PLATFORM_PERMISSIONS.COMPANY_DATA_READ);
    const canWrite = perms.has(PLATFORM_PERMISSIONS.COMPANY_DATA_WRITE);

    if (!canRead && !canWrite) {
      // Same 404 shape a company user would get. An operator without data
      // access learns nothing about which companies exist.
      throw new PlatformAccessRequiredError();
    }

    // An active impersonation grant narrows rather than widens: while one is
    // held, the operator is confined to its company and its write setting.
    const grant = actor.impersonation;
    if (grant) {
      if (grant.companyId !== company.id) {
        throw new TenantNotFoundError();
      }
      if (grant.expiresAt.getTime() <= Date.now()) {
        throw new PlatformAccessRequiredError();
      }
    }

    const writeAllowed = canWrite && (!grant || grant.allowWrites);
    const granted = writeAllowed ? ALL_COMPANY_PERMISSIONS : READ_ONLY_COMPANY_PERMISSIONS;

    this.logger.warn(
      `Platform access: operator ${actor.platformUserId} entered company ${company.id} ` +
        `(${writeAllowed ? 'read-write' : 'read-only'}` +
        `${grant ? `, impersonation grant ${grant.grantId}` : ''}) via ${source}`,
    );

    return {
      company,
      // No membership: an operator is not a member, and code that requires one
      // (e.g. "assign this appointment to me") must fail rather than improvise.
      membership: null,
      permissions: new Set<string>(granted),
      source,
      viaPlatformAccess: true,
    };
  }

  // -------------------------------------------------------------------------
  // Company members
  // -------------------------------------------------------------------------

  private async resolveMembership(
    companyId: string,
    userAccountId: string,
  ): Promise<ResolvedMembership | null> {
    const key = `${companyId}:${userAccountId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.db.runInCompany(companyId, async (tx) => {
      const membership = await tx.companyUser.findFirst({
        where: { companyId, userAccountId, deletedAt: null },
        select: { id: true, status: true, isOwner: true },
      });

      if (!membership) return null;

      if (membership.status !== 'ACTIVE') {
        // Distinct from "not a member": the user knows they were invited to
        // this company, so telling them the invitation is pending leaks
        // nothing and saves a confusing support ticket.
        throw new MembershipInactiveError(membership.status);
      }

      const roleLinks = await tx.companyUserRole.findMany({
        where: { companyId, companyUserId: membership.id },
        select: { roleId: true },
      });
      const roleIds = roleLinks.map((r) => r.roleId);

      const [roles, permissionRows, branchLinks] = await Promise.all([
        roleIds.length
          ? tx.companyRole.findMany({
              where: { companyId, id: { in: roleIds }, deletedAt: null },
              select: { key: true },
            })
          : Promise.resolve([] as Array<{ key: string }>),
        roleIds.length
          ? tx.companyRolePermission.findMany({
              where: { companyId, roleId: { in: roleIds } },
              select: { permissionKey: true },
            })
          : Promise.resolve([] as Array<{ permissionKey: string }>),
        tx.companyUserBranch.findMany({
          where: { companyId, companyUserId: membership.id },
          select: { branchId: true },
        }),
      ]);

      // An owner is granted the whole catalog at resolution time rather than
      // from a stored role, so a permission introduced in a later release is
      // never silently missing from the person who owns the account.
      const permissions = membership.isOwner
        ? [...ALL_COMPANY_PERMISSIONS]
        : [...new Set(permissionRows.map((p) => p.permissionKey))];

      return {
        membership: {
          companyUserId: membership.id,
          userAccountId,
          isOwner: membership.isOwner,
          roleKeys: roles.map((r) => r.key),
          // No rows means every branch. An empty array would be
          // indistinguishable from "scoped to nothing", so null is used for the
          // wildcard and the two are never conflated.
          branchScope: branchLinks.length > 0 ? branchLinks.map((b) => b.branchId) : null,
        },
        permissions,
      } satisfies ResolvedMembership;
    });

    this.cache.set(key, resolved);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Company state
  // -------------------------------------------------------------------------

  private async loadCompany(companyId: string): Promise<CurrentCompany> {
    const summary = await this.directory.getCompany(companyId);

    if (!summary || summary.deletedAt !== null || summary.status === 'CANCELED') {
      throw new TenantNotFoundError();
    }

    return {
      id: summary.id,
      slug: summary.slug,
      status: summary.status,
      operationalStatus: operationalStatusFor(summary.status),
      defaultTimezoneName: summary.defaultTimezoneName,
      currencyCode: summary.currencyCode,
    };
  }

  private assertCompanyUsable(company: CurrentCompany): void {
    if (company.status === 'SUSPENDED') {
      throw new TenantSuspendedError(company.status);
    }
  }

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------

  /** Call after a role assignment, a member removal, or a permission change. */
  invalidateUser(companyId: string, userAccountId: string): void {
    this.cache.delete(`${companyId}:${userAccountId}`);
  }

  /** Call after editing a role's permissions: every member of it is affected. */
  invalidateCompany(companyId: string): void {
    this.cache.deleteByPrefix(`${companyId}:`);
  }
}

/**
 * Maps company status to what the request may do.
 *
 * READ_ONLY is wired but not yet reachable: the grace period that produces it
 * is driven by `subscription.status`, and the billing module does not exist.
 * Reading the subscription on every request would add a query to the hot path
 * for a state nothing can currently enter, so it is deferred — the enum value
 * and the guard hook are here so that turning it on is a one-line change.
 */
function operationalStatusFor(status: string): CompanyOperationalStatus {
  switch (status) {
    case 'ACTIVE':
    case 'PENDING_SETUP':
      return 'ACTIVE';
    default:
      return 'READ_ONLY';
  }
}
