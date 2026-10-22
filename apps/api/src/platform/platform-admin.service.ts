import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type CompanyStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import type {
  AuditLogQueryDto,
  ChangeCompanyStatusDto,
  CompanyListQueryDto,
  CompanyUsersQueryDto,
  PlatformDashboardQueryDto,
} from './dto/platform-admin.dto';

/**
 * ===========================================================================
 * THE OPERATOR'S VIEW OF EVERY TENANT
 * ===========================================================================
 *
 * This is the one module in the codebase that is SUPPOSED to read across
 * companies, which makes it the one that needs the clearest rules.
 *
 * ---------------------------------------------------------------------------
 * 1. PLATFORM ACCESS IS NOT COMPANY RBAC WEARING A HAT
 * ---------------------------------------------------------------------------
 *
 * A platform operator holds `platform:*` permissions on a token whose audience
 * is the PLATFORM realm. A company owner holds `company:*` permissions on a
 * STAFF token. `JwtAuthGuard` rejects the wrong audience before any permission
 * is consulted, so a company owner cannot reach these routes by acquiring a
 * permission — there is no company permission that grants platform access, and
 * no platform permission that grants company data access implicitly.
 *
 * ---------------------------------------------------------------------------
 * 2. THE BYPASS-RLS CONNECTION IS USED, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `PlatformPrismaService` is a master key. `src/platform/**` is allowlisted for
 * it in `packages/eslint-config/nest.js` precisely because an operator asking
 * about a company they are not a member of is the NORMAL case here — a
 * tenant-scoped connection could not answer the question at all.
 *
 * What that costs is that every `select` below is hand-written. There is no RLS
 * backstop on this connection, so a careless `include` is a data leak rather
 * than an empty result. Hence rule 3.
 *
 * ---------------------------------------------------------------------------
 * 3. SELECT LISTS ARE ALLOW-LISTS, NEVER `include`
 * ---------------------------------------------------------------------------
 *
 * Operators run a SaaS business. They need to know a company exists, whether it
 * is paying, how big it is and whether it is healthy. They do NOT need the
 * names, phone numbers, email addresses, notes or appointment history of that
 * company's customers — and a console that showed them would turn one
 * compromised operator account into a breach of every tenant at once.
 *
 * So every customer-shaped thing here is a COUNT. The only personal data
 * returned is about COMPANY USERS — the people who signed up for the product —
 * and even there it is the work email they registered with, not a profile.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly directory: TenantDirectoryService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Companies
  // ---------------------------------------------------------------------------

  async listCompanies(query: CompanyListQueryDto) {
    const where = this.buildCompanyWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          slug: true,
          displayName: true,
          legalName: true,
          status: true,
          contactEmail: true,
          currencyCode: true,
          createdAt: true,
          suspendedAt: true,
          subscription: {
            select: {
              status: true,
              trialEndsAt: true,
              currentPeriodEnd: true,
              cancelAtPeriodEnd: true,
              plan: { select: { key: true, name: true } },
            },
          },
          // Size, not contents. A count tells an operator whether a tenant is
          // real and growing; the rows behind it are none of their business.
          _count: { select: { users: true, branches: true, employees: true } },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    return {
      items: rows.map(toCompanySummary),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * One company, with the counts an operator needs to size it.
   *
   * Seven aggregates in one round trip rather than seven endpoints, so the
   * figures on the screen are all from the same instant.
   */
  async getCompany(companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId },
      select: {
        id: true,
        slug: true,
        displayName: true,
        legalName: true,
        status: true,
        contactEmail: true,
        contactPhone: true,
        defaultTimezoneName: true,
        currencyCode: true,
        locale: true,
        createdAt: true,
        updatedAt: true,
        suspendedAt: true,
        deletedAt: true,
        subscription: {
          select: {
            id: true,
            status: true,
            quantity: true,
            trialEndsAt: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            graceEndsAt: true,
            cancelAtPeriodEnd: true,
            canceledAt: true,
            plan: { select: { key: true, name: true } },
          },
        },
      },
    });

    if (!company) throw new ResourceNotFoundError('Company', companyId);

    const [
      branches,
      employees,
      customers,
      appointments,
      services,
      activeUsers,
      roles,
      recentAudit,
    ] = await Promise.all([
      this.prisma.branch.count({ where: { companyId, deletedAt: null } }),
      this.prisma.employee.count({ where: { companyId, deletedAt: null } }),
      this.prisma.companyCustomer.count({ where: { companyId, deletedAt: null } }),
      this.prisma.appointment.count({ where: { companyId } }),
      this.prisma.service.count({ where: { companyId, deletedAt: null } }),
      this.prisma.companyUser.count({ where: { companyId, status: 'ACTIVE' } }),
      // Roles too: the onboarding flow reads this endpoint to show setup
      // progress, and six system roles is what 'provisioned' looks like.
      this.prisma.companyRole.count({ where: { companyId } }),
      // Recent administrative activity, as a shape rather than as content —
      // see `listAuditLogs` for why the payloads are not returned.
      this.prisma.auditLog.findMany({
        where: { companyId },
        orderBy: { occurredAt: 'desc' },
        take: 10,
        select: {
          id: true,
          action: true,
          resourceType: true,
          actorType: true,
          actorLabel: true,
          occurredAt: true,
        },
      }),
    ]);

    return {
      ...toCompanySummary({ ...company, _count: { users: activeUsers, branches, employees } }),
      contactPhone: company.contactPhone,
      defaultTimezoneName: company.defaultTimezoneName,
      locale: company.locale,
      updatedAt: company.updatedAt,
      deletedAt: company.deletedAt,
      counts: {
        branches,
        employees,
        services,
        customers,
        appointments,
        activeUsers,
        roles,
      },
      subscription: company.subscription
        ? {
            id: company.subscription.id,
            status: company.subscription.status,
            planKey: company.subscription.plan.key,
            planName: company.subscription.plan.name,
            quantity: company.subscription.quantity,
            trialEndsAt: company.subscription.trialEndsAt,
            currentPeriodStart: company.subscription.currentPeriodStart,
            currentPeriodEnd: company.subscription.currentPeriodEnd,
            graceEndsAt: company.subscription.graceEndsAt,
            cancelAtPeriodEnd: company.subscription.cancelAtPeriodEnd,
            canceledAt: company.subscription.canceledAt,
          }
        : null,
      recentActivity: recentAudit,
    };
  }

  /**
   * Suspend, reactivate or switch a company off.
   *
   * ---------------------------------------------------------------------------
   * THE CACHE INVALIDATION IS PART OF THE SECURITY MODEL
   * ---------------------------------------------------------------------------
   *
   * `TenantDirectoryService` caches company status for `TENANT_CACHE_TTL_SECONDS`.
   * Skipping the invalidation below means a suspended tenant keeps working for
   * the rest of that window — silently, with no error anywhere. It is one line
   * and it is the whole difference between "suspended" and "suspended soon".
   *
   * ---------------------------------------------------------------------------
   * REACTIVATION IS THE REASON THIS ENDPOINT EXISTS
   * ---------------------------------------------------------------------------
   *
   * The company-facing `POST /companies/:id/deactivate` is deliberately ONE
   * WAY: `MembershipService` treats a CANCELED company as not-found, so the
   * owner who cancelled can no longer reach anything — including a reactivate
   * button. An operator is exactly who should be able to undo it, and this is
   * the only path back.
   */
  async changeCompanyStatus(companyId: string, input: ChangeCompanyStatusDto) {
    const before = await this.prisma.company.findFirst({
      where: { id: companyId },
      select: { id: true, slug: true, displayName: true, status: true, deletedAt: true },
    });
    if (!before) throw new ResourceNotFoundError('Company', companyId);

    if (before.deletedAt !== null) {
      // A purged company is gone. Flipping a status on it would produce a row
      // that looks live to every aggregate on the dashboard.
      throw new ConflictError('That company has been deleted.', { field: 'companyId' });
    }

    if (before.status === input.status) {
      throw new ConflictError(`That company is already ${input.status}.`, { field: 'status' });
    }

    assertTransitionAllowed(before.status, input.status);

    const now = new Date();
    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: {
        status: input.status,
        // Kept in step with the status rather than left behind: a company that
        // is ACTIVE with a `suspendedAt` reads as currently suspended to
        // anybody scanning the table.
        suspendedAt: input.status === 'SUSPENDED' ? now : null,
      },
      select: { id: true, slug: true, status: true, suspendedAt: true },
    });

    // AFTER the write, so a reader that raced it caches the new value.
    this.directory.invalidate(updated.id, updated.slug);

    await this.audit.recordForCompany(companyId, {
      action: `platform.company.${input.status.toLowerCase()}`,
      resourceType: 'company',
      resourceId: companyId,
      before: { status: before.status },
      after: { status: updated.status },
      // The reason is the point of the row. It is operator-authored text about
      // a business decision, not customer data.
      metadata: { reason: input.reason },
    });

    this.logger.warn(
      `Company ${before.slug} moved ${before.status} -> ${input.status} by a platform operator.`,
    );

    return this.getCompany(companyId);
  }

  /**
   * Who can sign in to this company.
   *
   * COMPANY USERS, not customers. These are the people who bought the product,
   * and an operator supporting them needs to know who to talk to. A customer of
   * a tenant is a member of the public who booked a haircut, and nothing here
   * returns one.
   *
   * Even so, no password hash, no session, no MFA secret and no token is
   * selected — the `user_account` row has all four.
   */
  async listCompanyUsers(companyId: string, query: CompanyUsersQueryDto) {
    await this.assertCompanyExists(companyId);

    const where: Prisma.CompanyUserWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            userAccount: {
              OR: [
                { email: { contains: query.search, mode: 'insensitive' } },
                { fullName: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.companyUser.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          status: true,
          isOwner: true,
          joinedAt: true,
          invitedAt: true,
          createdAt: true,
          userAccount: {
            select: {
              id: true,
              email: true,
              fullName: true,
              status: true,
              emailVerifiedAt: true,
              lastLoginAt: true,
            },
          },
          roles: { select: { role: { select: { key: true, name: true } } } },
        },
      }),
      this.prisma.companyUser.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        membershipId: row.id,
        userAccountId: row.userAccount.id,
        email: row.userAccount.email,
        fullName: row.userAccount.fullName,
        accountStatus: row.userAccount.status,
        emailVerified: row.userAccount.emailVerifiedAt !== null,
        lastLoginAt: row.userAccount.lastLoginAt,
        membershipStatus: row.status,
        isOwner: row.isOwner,
        roles: row.roles.map((link: { role: { key: string } }) => link.role.key),
        joinedAt: row.joinedAt,
        invitedAt: row.invitedAt ?? row.createdAt,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Subscription and usage, side by side.
   *
   * They are one question — "is this customer within what they are paying
   * for" — and answering it from two endpoints means a console that can show a
   * plan from one moment next to usage from another.
   */
  async getCompanySubscription(companyId: string) {
    await this.assertCompanyExists(companyId);

    const subscription = await this.prisma.subscription.findFirst({
      where: { companyId },
      select: {
        id: true,
        status: true,
        quantity: true,
        trialEndsAt: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
        cancelAtPeriodEnd: true,
        canceledAt: true,
        cancelReason: true,
        expiredAt: true,
        provider: true,
        createdAt: true,
        plan: {
          select: {
            key: true,
            name: true,
            entitlements: { select: { featureKey: true, limitInt: true, limitBool: true } },
          },
        },
      },
    });

    const periodKey = currentPeriodKey();

    const [counters, overrides, recentUsage] = await Promise.all([
      this.prisma.usageCounter.findMany({
        where: { companyId, periodKey },
        select: { metric: true, value: true, updatedAt: true },
      }),
      this.prisma.subscriptionEntitlementOverride.findMany({
        where: { companyId },
        select: {
          featureKey: true,
          limitInt: true,
          limitBool: true,
          reason: true,
          expiresAt: true,
        },
      }),
      // Last six periods, so a console can show whether usage is growing
      // without a second request.
      this.prisma.usageCounter.findMany({
        where: { companyId },
        orderBy: { periodKey: 'desc' },
        take: 60,
        select: { metric: true, periodKey: true, value: true },
      }),
    ]);

    const limits = new Map<string, { limitInt: number | null; limitBool: boolean | null }>();
    for (const entitlement of subscription?.plan.entitlements ?? []) {
      limits.set(entitlement.featureKey, {
        limitInt: entitlement.limitInt,
        limitBool: entitlement.limitBool,
      });
    }
    // A negotiated override beats the plan, which is what the table is for.
    for (const override of overrides) {
      if (override.expiresAt && override.expiresAt.getTime() <= Date.now()) continue;
      limits.set(override.featureKey, {
        limitInt: override.limitInt,
        limitBool: override.limitBool,
      });
    }

    return {
      companyId,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            planKey: subscription.plan.key,
            planName: subscription.plan.name,
            quantity: subscription.quantity,
            trialEndsAt: subscription.trialEndsAt,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            graceEndsAt: subscription.graceEndsAt,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            canceledAt: subscription.canceledAt,
            cancelReason: subscription.cancelReason,
            expiredAt: subscription.expiredAt,
            provider: subscription.provider,
            startedAt: subscription.createdAt,
          }
        : null,
      periodKey,
      usage: counters.map((counter) => {
        const limit = limits.get(counter.metric)?.limitInt ?? null;
        const used = Number(counter.value);
        return {
          metric: counter.metric,
          used,
          limit,
          // Null when the plan has no numeric cap, so a UI shows "unlimited"
          // rather than a bar at 0%.
          percentUsed: limit && limit > 0 ? Math.round((used / limit) * 100) : null,
          overLimit: limit !== null && limit > 0 && used > limit,
          updatedAt: counter.updatedAt,
        };
      }),
      entitlements: [...limits.entries()].map(([featureKey, value]) => ({
        featureKey,
        limitInt: value.limitInt,
        limitBool: value.limitBool,
        overridden: overrides.some((o) => o.featureKey === featureKey),
      })),
      history: recentUsage.map((row) => ({
        metric: row.metric,
        periodKey: row.periodKey,
        value: Number(row.value),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  /**
   * The whole platform in one request.
   *
   * ---------------------------------------------------------------------------
   * AGGREGATES, NOT SCANS
   * ---------------------------------------------------------------------------
   *
   * Every figure is a `groupBy` or a `count`. This screen is opened first every
   * morning and the tables it reads grow with every tenant, so loading rows to
   * reduce them in JavaScript would get slower exactly as the business gets
   * bigger.
   *
   * The company and subscription breakdowns are one grouped query each rather
   * than four counts apiece — eight round trips for two numbers that come out
   * of one index scan.
   */
  async dashboard(query: PlatformDashboardQueryDto) {
    const since = new Date(Date.now() - query.windowDays * 86_400_000);

    const [
      companiesByStatus,
      subscriptionsByStatus,
      totalUsers,
      activeUsers,
      totalAppointments,
      recentAppointments,
      newCompanies,
      trialsEndingSoon,
      topPlans,
    ] = await Promise.all([
      this.prisma.company.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.userAccount.count({ where: { deletedAt: null } }),
      this.prisma.companyUser.count({ where: { status: 'ACTIVE' } }),
      this.prisma.appointment.count(),
      this.prisma.appointment.count({ where: { createdAt: { gte: since } } }),
      this.prisma.company.count({ where: { deletedAt: null, createdAt: { gte: since } } }),
      // The number that drives the week's work: trials about to lapse.
      this.prisma.subscription.count({
        where: {
          status: 'TRIAL',
          trialEndsAt: { gte: new Date(), lte: new Date(Date.now() + 7 * 86_400_000) },
        },
      }),
      this.prisma.subscription.groupBy({
        by: ['planId'],
        _count: { _all: true },
        orderBy: { _count: { planId: 'desc' } },
        take: 5,
      }),
    ]);

    const planNames = await this.namePlans(topPlans.map((row) => row.planId));

    const companyCounts = countsByKey(companiesByStatus, 'status');
    const subscriptionCounts = countsByKey(subscriptionsByStatus, 'status');

    return {
      windowDays: query.windowDays,
      companies: {
        total: sum(companyCounts),
        active: companyCounts.ACTIVE ?? 0,
        suspended: companyCounts.SUSPENDED ?? 0,
        /** The brief's DISABLED. See the note in the DTO. */
        disabled: companyCounts.CANCELED ?? 0,
        pendingSetup: companyCounts.PENDING_SETUP ?? 0,
        newInWindow: newCompanies,
        byStatus: companyCounts,
      },
      subscriptions: {
        total: sum(subscriptionCounts),
        trial: subscriptionCounts.TRIAL ?? 0,
        active: subscriptionCounts.ACTIVE ?? 0,
        pastDue: subscriptionCounts.PAST_DUE ?? 0,
        grace: subscriptionCounts.GRACE ?? 0,
        suspended: subscriptionCounts.SUSPENDED ?? 0,
        cancelled: subscriptionCounts.CANCELLED ?? 0,
        expired: subscriptionCounts.EXPIRED ?? 0,
        trialsEndingWithin7Days: trialsEndingSoon,
        byStatus: subscriptionCounts,
        topPlans: topPlans.map((row) => ({
          planKey: planNames.get(row.planId)?.key ?? null,
          planName: planNames.get(row.planId)?.name ?? null,
          companies: row._count._all,
        })),
      },
      users: {
        /** Distinct accounts across the platform; one human with two companies counts once. */
        total: totalUsers,
        activeMemberships: activeUsers,
      },
      appointments: {
        total: totalAppointments,
        inWindow: recentAppointments,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  /**
   * Administrative history, across every tenant.
   *
   * ---------------------------------------------------------------------------
   * THE `before`/`after` PAYLOADS ARE NOT RETURNED
   * ---------------------------------------------------------------------------
   *
   * An audit row records what changed, which for a tenant's own actions means
   * customer names, phone numbers and prices. An operator needs to see THAT a
   * company suspended an employee at 14:02 and who did it — not the employee's
   * emergency contact.
   *
   * Only `metadata.reason` is surfaced, and only for platform actions, because
   * that field is operator-authored text about a business decision. The full
   * row remains in the database for a company's own `audit:read` screen, where
   * the tenant that owns the data can see it.
   *
   * `platform:audit:read` is a separate permission from `platform:company:list`
   * for this reason: reading the list of customers is a smaller grant than
   * reading the history of everything they have ever done.
   */
  async listAuditLogs(query: AuditLogQueryDto) {
    const occurredAt: Prisma.DateTimeFilter = {};
    if (query.from) occurredAt.gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) {
      const to = new Date(`${query.to}T00:00:00.000Z`);
      to.setUTCDate(to.getUTCDate() + 1);
      occurredAt.lt = to;
    }

    const where: Prisma.AuditLogWhereInput = {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.from || query.to ? { occurredAt } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          companyId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          actorType: true,
          actorId: true,
          actorLabel: true,
          occurredAt: true,
          requestId: true,
          metadata: true,
          company: { select: { slug: true, displayName: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        companySlug: row.company?.slug ?? null,
        companyName: row.company?.displayName ?? null,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        actorType: row.actorType,
        actorId: row.actorId,
        actorLabel: row.actorLabel,
        /** Operator-authored, and only for platform actions. See above. */
        reason: platformReason(row.action, row.metadata),
        occurredAt: row.occurredAt,
        requestId: row.requestId,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  // ---------------------------------------------------------------------------

  private buildCompanyWhere(query: CompanyListQueryDto): Prisma.CompanyWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.createdFrom) createdAt.gte = new Date(`${query.createdFrom}T00:00:00.000Z`);
    if (query.createdTo) {
      const to = new Date(`${query.createdTo}T00:00:00.000Z`);
      to.setUTCDate(to.getUTCDate() + 1);
      createdAt.lt = to;
    }

    return {
      // A purged company is gone from the console. Nothing here resurrects one.
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.createdFrom || query.createdTo ? { createdAt } : {}),
      // An explicit `is`, not a bare object: `subscription` is a NULLABLE
      // one-to-one, so the bare form is typed as the null-check filter and means
      // something else. Filtering on it also excludes companies with no
      // subscription, which is the right reading of "everyone on the PRO plan".
      ...(query.subscriptionStatus || query.planKey
        ? {
            subscription: {
              is: {
                ...(query.subscriptionStatus ? { status: query.subscriptionStatus } : {}),
                ...(query.planKey ? { plan: { key: query.planKey } } : {}),
              },
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: 'insensitive' } },
              { legalName: { contains: query.search, mode: 'insensitive' } },
              { slug: { contains: query.search, mode: 'insensitive' } },
              { contactEmail: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private async assertCompanyExists(companyId: string) {
    const found = await this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: { id: true },
    });
    if (!found) throw new ResourceNotFoundError('Company', companyId);
  }

  private async namePlans(planIds: string[]) {
    if (planIds.length === 0) return new Map<string, { key: string; name: string }>();
    const plans = await this.prisma.plan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, key: true, name: true },
    });
    return new Map(plans.map((plan) => [plan.id, { key: plan.key, name: plan.name }]));
  }
}

/**
 * Which status changes are legal.
 *
 * `PENDING_SETUP` is reachable only by provisioning, so it is not a target. The
 * transition that matters is `CANCELED -> ACTIVE`: it is the only way back from
 * a company deactivating itself, and the company-facing API deliberately cannot
 * offer it.
 */
function assertTransitionAllowed(from: CompanyStatus, to: CompanyStatus) {
  const allowed: Record<CompanyStatus, CompanyStatus[]> = {
    PENDING_SETUP: ['ACTIVE', 'SUSPENDED', 'CANCELED'],
    ACTIVE: ['SUSPENDED', 'CANCELED'],
    SUSPENDED: ['ACTIVE', 'CANCELED'],
    CANCELED: ['ACTIVE'],
  };

  if (!allowed[from].includes(to)) {
    throw new ValidationFailedError({
      status: `A company cannot move from ${from} to ${to}.`,
    });
  }
}

function toCompanySummary(company: {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  status: string;
  contactEmail: string | null;
  currencyCode: string;
  createdAt: Date;
  suspendedAt: Date | null;
  subscription: {
    status: string;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    plan: { key: string; name: string };
  } | null;
  _count: { users: number; branches: number; employees: number };
}) {
  return {
    id: company.id,
    slug: company.slug,
    displayName: company.displayName,
    legalName: company.legalName,
    status: company.status,
    contactEmail: company.contactEmail,
    currencyCode: company.currencyCode,
    createdAt: company.createdAt,
    suspendedAt: company.suspendedAt,
    subscriptionStatus: company.subscription?.status ?? null,
    planKey: company.subscription?.plan.key ?? null,
    planName: company.subscription?.plan.name ?? null,
    trialEndsAt: company.subscription?.trialEndsAt ?? null,
    currentPeriodEnd: company.subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: company.subscription?.cancelAtPeriodEnd ?? false,
    userCount: company._count.users,
    branchCount: company._count.branches,
    employeeCount: company._count.employees,
  };
}

/** `'2026-10'`. Matches how `usage_counter.period_key` is written. */
function currentPeriodKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function countsByKey<K extends string>(
  rows: Array<Record<K, string> & { _count: { _all: number } }>,
  key: K,
): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row[key], row._count._all]));
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

/**
 * The operator's own note, and nothing else from the payload.
 *
 * Guarded on the action prefix so a tenant's audit metadata — which can carry
 * anything a feature module put there — never reaches this response by
 * accidentally having a `reason` key.
 */
function platformReason(action: string, metadata: Prisma.JsonValue): string | null {
  if (!action.startsWith('platform.')) return null;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const reason = (metadata as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
}
