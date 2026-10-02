import { Injectable } from '@nestjs/common';
import type { SubscriptionStatus } from '@prisma/client';
import { TtlCache } from '../common/cache';
import { FeatureNotAvailableError, PlanLimitExceededError } from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { FEATURE_KEYS, LIMIT_KEYS, type FeatureKey, type LimitKey } from './plan-catalog';
import { effectiveStatus, grantsAccess } from './subscription-state';

/** What a company may do, resolved from its subscription, plan and overrides. */
export interface Entitlements {
  /** False for a company provisioned before subscriptions existed: no limits. */
  readonly subscribed: boolean;
  /** Effective status (see `effectiveStatus`), or null when not subscribed. */
  readonly status: SubscriptionStatus | null;
  readonly planKey: string | null;
  readonly planName: string | null;
  readonly features: Readonly<Record<FeatureKey, boolean>>;
  /** null = unlimited. */
  readonly limits: Readonly<Record<LimitKey, number | null>>;
}

/** Things a plan limits the number of. */
export type Countable = 'BRANCH' | 'EMPLOYEE' | 'SERVICE' | 'RESOURCE' | 'CUSTOMER' | 'APPOINTMENT';

const LIMIT_FOR: Record<Countable, LimitKey> = {
  BRANCH: 'MAX_BRANCHES',
  EMPLOYEE: 'MAX_EMPLOYEES',
  SERVICE: 'MAX_SERVICES',
  RESOURCE: 'MAX_RESOURCES',
  CUSTOMER: 'MAX_CUSTOMERS',
  APPOINTMENT: 'MAX_APPOINTMENTS_PER_MONTH',
};

const UNRESTRICTED: Entitlements = {
  subscribed: false,
  status: null,
  planKey: null,
  planName: null,
  features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Record<FeatureKey, boolean>,
  limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, null])) as Record<LimitKey, number | null>,
};

/**
 * ===========================================================================
 * THE ONE PLACE THAT ANSWERS "MAY THIS COMPANY …?"
 * ===========================================================================
 *
 *   canUse(entitlements, 'GIFT_CARDS')          — a feature on or off
 *   assertFeature(companyId, 'PROMOTIONS')      — the same, throwing
 *   assertCanAdd(tx, companyId, 'EMPLOYEE')     — one more within the limit?
 *
 * Controllers do not check plans. A feature is declared on a route with
 * `@RequireFeature` (checked by `FeatureGuard`); a limit is checked by the
 * service that creates the thing, inside its own transaction, by one call here.
 *
 * Values come from the DATABASE: the plan's `plan_entitlement` rows, overlaid
 * by any unexpired `subscription_entitlement_override` for the company. They
 * are cached per company for 30 seconds and invalidated on every subscription
 * change made through this process.
 *
 * A company with no subscription row (provisioned before billing existed) is
 * unrestricted. An EXPIRED subscription has every feature off — though writes
 * are refused earlier anyway, by the read-only tenant state.
 */
@Injectable()
export class EntitlementsService {
  private readonly cache = new TtlCache<Entitlements>(30_000, 20_000);
  /**
   * Usage for the billing page. A minute-old figure is fine there; it is
   * dropped whenever a create passes `assertCanAdd`, so adding something shows
   * at once. Limits themselves are always counted live, under the lock.
   */
  private readonly usageCache = new TtlCache<Record<LimitKey, number>>(60_000, 20_000);

  constructor(private readonly db: TenantPrismaService) {}

  async forCompany(companyId: string): Promise<Entitlements> {
    return this.cache.getOrLoad(companyId, () =>
      this.db.runInCompany(companyId, (tx) => this.resolve(tx, companyId)),
    );
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
    this.usageCache.delete(companyId);
  }

  /** `usage`, cached per company for a minute (see `usageCache`). */
  async cachedUsage(tx: TenantTx, companyId: string): Promise<Record<LimitKey, number>> {
    return this.usageCache.getOrLoad(companyId, () => this.usage(tx, companyId));
  }

  canUse(entitlements: Entitlements, feature: FeatureKey): boolean {
    return entitlements.features[feature];
  }

  async assertFeature(companyId: string, feature: FeatureKey): Promise<void> {
    const entitlements = await this.forCompany(companyId);
    if (!this.canUse(entitlements, feature)) {
      throw new FeatureNotAvailableError(feature, entitlements.planKey);
    }
  }

  /**
   * Refuse to create one more `what` beyond the plan's limit.
   *
   * Call inside the transaction that creates the row. A transaction-scoped
   * advisory lock per (company, limit) serialises concurrent creates of the
   * same kind, so two requests for "the 10th employee" cannot both see 9.
   */
  async assertCanAdd(tx: TenantTx, companyId: string, what: Countable): Promise<void> {
    const entitlements = await this.forCompany(companyId);

    if (what === 'BRANCH' && !entitlements.features.MULTI_BRANCH) {
      const branches = await this.count(tx, companyId, 'BRANCH');
      if (branches >= 1) throw new FeatureNotAvailableError('MULTI_BRANCH', entitlements.planKey);
    }

    const limitKey = LIMIT_FOR[what];
    const max = entitlements.limits[limitKey];
    // Something is about to be created: the cached usage is out of date.
    this.usageCache.delete(companyId);
    if (max === null) return;

    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`plan-limit:${companyId}:${limitKey}`}, 0))`;
    const current = await this.count(tx, companyId, what);
    if (current >= max) {
      throw new PlanLimitExceededError({
        limit: limitKey,
        max,
        current,
        planKey: entitlements.planKey,
      });
    }
  }

  /** Current usage of every limit. Six indexed counts. */
  async usage(tx: TenantTx, companyId: string): Promise<Record<LimitKey, number>> {
    const kinds = Object.keys(LIMIT_FOR) as Countable[];
    const counts = await Promise.all(kinds.map((kind) => this.count(tx, companyId, kind)));
    return Object.fromEntries(kinds.map((kind, i) => [LIMIT_FOR[kind], counts[i]])) as Record<
      LimitKey,
      number
    >;
  }

  /**
   * What counts against each limit: things that exist and are in use. Deleted
   * rows never count; a terminated employee does not either. Appointments are
   * those CREATED this calendar month (UTC), excluding the seats the booking
   * page held and released, and excluding the second half of a reschedule.
   */
  async count(tx: TenantTx, companyId: string, what: Countable): Promise<number> {
    switch (what) {
      case 'BRANCH':
        return tx.branch.count({ where: { companyId, deletedAt: null } });
      case 'EMPLOYEE':
        return tx.employee.count({
          where: { companyId, deletedAt: null, status: { not: 'TERMINATED' } },
        });
      case 'SERVICE':
        return tx.service.count({ where: { companyId, deletedAt: null } });
      case 'RESOURCE':
        return tx.resource.count({ where: { companyId, deletedAt: null } });
      case 'CUSTOMER':
        return tx.companyCustomer.count({ where: { companyId, deletedAt: null } });
      case 'APPOINTMENT': {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        return tx.appointment.count({
          where: {
            companyId,
            createdAt: { gte: monthStart },
            rescheduledFromId: null,
            status: { notIn: ['EXPIRED'] },
          },
        });
      }
    }
  }

  private async resolve(tx: TenantTx, companyId: string): Promise<Entitlements> {
    const subscription = await tx.subscription.findFirst({
      where: { companyId },
      select: {
        status: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
        plan: {
          select: {
            key: true,
            name: true,
            entitlements: { select: { featureKey: true, limitInt: true, limitBool: true } },
          },
        },
      },
    });
    if (!subscription) return UNRESTRICTED;

    const overrides = await tx.subscriptionEntitlementOverride.findMany({
      where: { companyId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { featureKey: true, limitInt: true, limitBool: true },
    });

    const values = new Map<string, { limitInt: number | null; limitBool: boolean | null }>();
    for (const row of subscription.plan.entitlements) values.set(row.featureKey, row);
    for (const row of overrides) values.set(row.featureKey, row);

    const status = effectiveStatus(subscription);
    const live = grantsAccess(status);

    return {
      subscribed: true,
      status,
      planKey: subscription.plan.key,
      planName: subscription.plan.name,
      features: Object.fromEntries(
        FEATURE_KEYS.map((key) => [key, live && values.get(key)?.limitBool === true]),
      ) as Record<FeatureKey, boolean>,
      // A limit the plan does not mention is 0, not unlimited: forgetting a
      // row must fail closed.
      limits: Object.fromEntries(
        LIMIT_KEYS.map((key) => {
          const row = values.get(key);
          return [key, row ? row.limitInt : 0];
        }),
      ) as Record<LimitKey, number | null>,
    };
  }
}
