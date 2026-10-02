import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Subscription } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  ConflictError,
  PlanLimitExceededError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { EntitlementsService } from './entitlements.service';
import { FEATURE_DEFINITIONS, FEATURE_KEYS, LIMIT_KEYS } from './plan-catalog';
import {
  INVOICE_DUE_DAYS,
  addDays,
  addInterval,
  daysUntil,
  effectiveStatus,
  grantsAccess,
} from './subscription-state';
import type { InvoiceQueryDto } from './dto/subscription.dto';

interface SubscriptionRow {
  id: string;
  companyId: string;
}

@Injectable()
export class SubscriptionRepository extends TenantScopedRepository<SubscriptionRow> {
  protected readonly modelName = 'Subscription';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<SubscriptionRow> {
    return tx.subscription;
  }
}

const planSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  priceMinor: true,
  currencyCode: true,
  interval: true,
  trialDays: true,
  sortOrder: true,
  entitlements: { select: { featureKey: true, limitInt: true, limitBool: true } },
} as const;
type PlanRow = Prisma.PlanGetPayload<{ select: typeof planSelect }>;

const LIMIT_LABEL: Record<string, string> = Object.fromEntries(
  FEATURE_DEFINITIONS.map((f) => [f.key, f.name]),
);

/**
 * ===========================================================================
 * A COMPANY'S OWN SUBSCRIPTION
 * ===========================================================================
 *
 * What a company may do to its own subscription: look at it, start its one
 * trial, change plan, cancel, reactivate, and read its invoices. Extending a
 * period or recording a payment is the PLATFORM's business
 * (`SubscriptionLifecycleService`, `/platform/...`) and is not reachable here.
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 * ---------------------------------------------------------------------------
 *
 *   start trial   only with no subscription yet; a plan with trial days.
 *   change plan   TRIAL/ACTIVE/PAST_DUE/EXPIRED → ACTIVE on the new plan, a new
 *                 period from now and an OPEN invoice for it (none for a free
 *                 plan). The replaced plan's unpaid invoices are VOIDed — there
 *                 is no proration in this foundation. A downgrade that current
 *                 usage would exceed is refused, naming each limit.
 *   cancel        → CANCELLED. Access continues to the end of the period (or
 *                 trial); then EXPIRED.
 *   reactivate    CANCELLED (period not over) → back where it was.
 *                 EXPIRED → a new ACTIVE period on the same plan, invoiced.
 *
 * EXPIRED never deletes anything: the company becomes read-only (see
 * MembershipService) and every one of these endpoints still works, so it can
 * always get back out.
 *
 * Every change runs under a row lock on the subscription and invalidates the
 * entitlement and tenant caches, so the very next request sees it.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly entitlements: EntitlementsService,
    private readonly directory: TenantDirectoryService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // Reads
  // ===========================================================================

  async overview() {
    return this.subscriptions.transaction(async (tx, companyId) => {
      const [subscription, plans, openInvoice] = await Promise.all([
        tx.subscription.findFirst({
          where: { companyId },
          include: { plan: { select: planSelect } },
        }),
        this.plans(tx),
        tx.subscriptionInvoice.findFirst({
          where: { companyId, status: 'OPEN' },
          orderBy: { dueAt: 'asc' },
          select: { id: true, number: true, totalMinor: true, currencyCode: true, dueAt: true },
        }),
      ]);
      // Usage is six counts; a minute-old figure is fine for a billing page,
      // and limits themselves are enforced live, under a lock, at create time.
      const usage = await this.entitlements.cachedUsage(tx, companyId);
      const entitlements = await this.entitlements.forCompany(companyId);
      const now = new Date();

      return {
        subscription: subscription ? this.describe(subscription, now) : null,
        trialAvailable: subscription === null && plans.some((p) => p.trialDays > 0),
        features: entitlements.features,
        usage: LIMIT_KEYS.map((key) => ({
          key,
          label: LIMIT_LABEL[key] ?? key,
          used: usage[key],
          limit: entitlements.limits[key],
        })),
        plans: plans.map((plan) => toPlan(plan, subscription?.planId ?? null)),
        openInvoice: openInvoice
          ? {
              id: openInvoice.id,
              number: openInvoice.number,
              totalMinor: openInvoice.totalMinor.toString(),
              currencyCode: openInvoice.currencyCode,
              dueAt: openInvoice.dueAt,
            }
          : null,
      };
    });
  }

  async invoices(query: InvoiceQueryDto) {
    return this.subscriptions.transaction(async (tx, companyId) => {
      const where: Prisma.SubscriptionInvoiceWhereInput = {
        companyId,
        ...(query.status ? { status: query.status } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.subscriptionInvoice.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: query.offset,
          take: query.limit,
        }),
        tx.subscriptionInvoice.count({ where }),
      ]);
      return { items: rows.map(toInvoice), total, limit: query.limit, offset: query.offset };
    });
  }

  async invoice(invoiceId: string) {
    return this.subscriptions.transaction(async (tx, companyId) => {
      const row = await tx.subscriptionInvoice.findFirst({ where: { id: invoiceId, companyId } });
      if (!row) throw new ResourceNotFoundError('SubscriptionInvoice', invoiceId);
      return toInvoice(row);
    });
  }

  // ===========================================================================
  // Changes
  // ===========================================================================

  async startTrial(planKey: string) {
    const result = await this.subscriptions.transaction(async (tx, companyId) => {
      const existing = await tx.subscription.findFirst({
        where: { companyId },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError(
          'This company already has a subscription. A trial is only for a first plan.',
          {
            field: 'planKey',
          },
        );
      }
      const plan = await this.plan(tx, planKey);
      if (plan.trialDays <= 0) {
        throw new ValidationFailedError({
          planKey: `The ${plan.name} plan has no trial. Choose it instead.`,
        });
      }
      return startTrialWithin(tx, companyId, plan);
    });
    await this.changed(result.companyId, 'subscription.trial_started', { planKey });
    return this.overview();
  }

  async changePlan(planKey: string) {
    const result = await this.subscriptions.transaction(async (tx, companyId) => {
      const current = await this.lock(tx, companyId);
      const plan = await this.plan(tx, planKey);
      const now = new Date();

      if (current) {
        const status = effectiveStatus(current, now);
        if (status === 'CANCELLED') {
          throw new ConflictError('Reactivate the subscription before changing its plan.', {
            field: 'status',
          });
        }
        if (current.planId === plan.id && status !== 'EXPIRED' && status !== 'TRIAL') {
          throw new ConflictError(`You are already on the ${plan.name} plan.`, {
            field: 'planKey',
          });
        }
      }

      await this.assertUsageFits(tx, companyId, plan);

      const periodEnd = addInterval(now, plan.interval);
      const data = {
        planId: plan.id,
        status: 'ACTIVE' as const,
        trialEndsAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancelReason: null,
        expiredAt: null,
      };

      const subscription = current
        ? await updateSubscription(tx, companyId, current.id, data)
        : await tx.subscription.create({ data: { companyId, ...data } });

      // Unpaid invoices for the plan being replaced. No proration here — a
      // payment integration would credit what was paid instead.
      await tx.subscriptionInvoice.updateMany({
        where: { companyId, subscriptionId: subscription.id, status: { in: ['OPEN', 'DRAFT'] } },
        data: { status: 'VOID' },
      });

      const invoice =
        plan.priceMinor > 0n
          ? await issueInvoice(tx, companyId, subscription.id, plan, now, periodEnd)
          : null;

      return { companyId, from: current?.planId ?? null, invoiceId: invoice?.id ?? null };
    });

    await this.changed(result.companyId, 'subscription.plan_changed', {
      planKey,
      fromPlanId: result.from,
      invoiceId: result.invoiceId,
    });
    return this.overview();
  }

  async cancel(reason?: string) {
    const companyId = await this.subscriptions.transaction(async (tx, companyId) => {
      const current = await this.lock(tx, companyId);
      if (!current) throw new ResourceNotFoundError('Subscription', 'current');
      const status = effectiveStatus(current);
      if (status === 'CANCELLED' || status === 'EXPIRED' || !grantsAccess(status)) {
        throw new ConflictError('This subscription is not active, so there is nothing to cancel.', {
          field: 'status',
        });
      }
      await updateSubscription(tx, companyId, current.id, {
        status: 'CANCELLED',
        cancelAtPeriodEnd: true,
        canceledAt: new Date(),
        cancelReason: reason ?? null,
        // A cancelled trial ends when the trial would have.
        ...(status === 'TRIAL' && current.trialEndsAt
          ? { currentPeriodEnd: current.trialEndsAt }
          : {}),
      });
      return companyId;
    });
    await this.changed(companyId, 'subscription.cancelled', { reason: reason ?? null });
    return this.overview();
  }

  async reactivate() {
    const result = await this.subscriptions.transaction(async (tx, companyId) => {
      const current = await this.lock(tx, companyId);
      if (!current) throw new ResourceNotFoundError('Subscription', 'current');
      const now = new Date();
      const status = effectiveStatus(current, now);

      if (status === 'CANCELLED') {
        // Undo the cancellation: back to the trial if it is still running.
        const backToTrial = current.trialEndsAt !== null && current.trialEndsAt > now;
        await updateSubscription(tx, companyId, current.id, {
          status: backToTrial ? 'TRIAL' : 'ACTIVE',
          cancelAtPeriodEnd: false,
          canceledAt: null,
          cancelReason: null,
        });
        return { companyId, renewed: false };
      }

      if (status === 'EXPIRED') {
        // Renewal: a fresh period on the same plan, invoiced.
        const plan = await tx.plan.findUniqueOrThrow({
          where: { id: current.planId },
          select: planSelect,
        });
        await this.assertUsageFits(tx, companyId, plan);
        const periodEnd = addInterval(now, plan.interval);
        await updateSubscription(tx, companyId, current.id, {
          status: 'ACTIVE',
          trialEndsAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          graceEndsAt: null,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          cancelReason: null,
          expiredAt: null,
        });
        if (plan.priceMinor > 0n)
          await issueInvoice(tx, companyId, current.id, plan, now, periodEnd);
        return { companyId, renewed: true };
      }

      throw new ConflictError('Only a cancelled or expired subscription can be reactivated.', {
        field: 'status',
      });
    });
    await this.changed(result.companyId, 'subscription.reactivated', { renewed: result.renewed });
    return this.overview();
  }

  // ---------------------------------------------------------------------------

  private async changed(companyId: string, action: string, after: Record<string, unknown>) {
    this.entitlements.invalidate(companyId);
    this.directory.invalidate(companyId);
    await this.audit.record({ action, resourceType: 'subscription', after });
    this.logger.log(`${action} for company ${companyId}`);
  }

  /** `SELECT … FOR UPDATE`: two plan changes at once must not both apply. */
  private async lock(tx: TenantTx, companyId: string): Promise<Subscription | null> {
    await tx.$queryRaw`SELECT id FROM subscription WHERE company_id = ${companyId}::uuid FOR UPDATE`;
    return tx.subscription.findFirst({ where: { companyId } });
  }

  private async plans(tx: TenantTx): Promise<PlanRow[]> {
    return tx.plan.findMany({
      where: { isPublic: true, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      select: planSelect,
    });
  }

  private async plan(tx: TenantTx, key: string): Promise<PlanRow> {
    const plan = await tx.plan.findFirst({
      where: { key, isPublic: true, deletedAt: null },
      select: planSelect,
    });
    if (!plan) throw new ResourceNotFoundError('Plan', key);
    return plan;
  }

  /** Refuse a plan whose limits current usage already exceeds, naming each one. */
  private async assertUsageFits(tx: TenantTx, companyId: string, plan: PlanRow) {
    const usage = await this.entitlements.usage(tx, companyId);
    const violations: Array<{ limit: string; max: number; current: number }> = [];
    for (const key of LIMIT_KEYS) {
      // Appointments per month is a flow, not a stock: this month's count
      // does not stop a downgrade.
      if (key === 'MAX_APPOINTMENTS_PER_MONTH') continue;
      const row = plan.entitlements.find((e) => e.featureKey === key);
      const max = row ? row.limitInt : 0;
      if (max !== null && usage[key] > max)
        violations.push({ limit: key, max, current: usage[key] });
    }
    if (violations.length > 0) {
      const first = violations[0]!;
      throw new PlanLimitExceededError({ ...first, planKey: plan.key, violations });
    }
  }

  private describe(subscription: Subscription & { plan: PlanRow }, now: Date) {
    const status = effectiveStatus(subscription, now);
    return {
      id: subscription.id,
      status,
      plan: {
        key: subscription.plan.key,
        name: subscription.plan.name,
        priceMinor: subscription.plan.priceMinor.toString(),
        currencyCode: subscription.plan.currencyCode,
        interval: subscription.plan.interval,
      },
      trial:
        subscription.trialEndsAt && status === 'TRIAL'
          ? { endsAt: subscription.trialEndsAt, daysLeft: daysUntil(subscription.trialEndsAt, now) }
          : null,
      currentPeriod: { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      canceledAt: subscription.canceledAt,
      graceEndsAt: subscription.graceEndsAt,
      expiredAt: subscription.expiredAt,
      /** True when the company is read-only because of this subscription. */
      readOnly: !grantsAccess(status),
    };
  }
}

// ---------------------------------------------------------------------------
// Shared with the platform lifecycle service and provisioning.
// ---------------------------------------------------------------------------

export async function startTrialWithin(
  tx: TenantTx,
  companyId: string,
  plan: { id: string; trialDays: number },
) {
  const now = new Date();
  const trialEndsAt = addDays(now, plan.trialDays);
  await tx.subscription.create({
    data: {
      companyId,
      planId: plan.id,
      status: 'TRIAL',
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    },
  });
  return { companyId, trialEndsAt };
}

/** updateMany so the company is in the filter (the tenant guard requires it). */
export async function updateSubscription(
  tx: TenantTx,
  companyId: string,
  id: string,
  data: Prisma.SubscriptionUncheckedUpdateManyInput,
) {
  await tx.subscription.updateMany({ where: { id, companyId }, data });
  return tx.subscription.findFirstOrThrow({ where: { id, companyId } });
}

/**
 * An OPEN invoice for one period. Numbered `INV-YYYYMM-NNNN` per company, under
 * the caller's subscription lock. Nothing is charged: a payment integration
 * will settle OPEN invoices; today a platform operator marks them paid.
 */
export async function issueInvoice(
  tx: TenantTx,
  companyId: string,
  subscriptionId: string,
  plan: { id: string; name: string; priceMinor: bigint; currencyCode: string },
  periodStart: Date,
  periodEnd: Date,
) {
  const now = new Date();
  const prefix = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}-`;
  const sameMonth = await tx.subscriptionInvoice.count({
    where: { companyId, number: { startsWith: prefix } },
  });
  return tx.subscriptionInvoice.create({
    data: {
      companyId,
      subscriptionId,
      planId: plan.id,
      planName: plan.name,
      number: `${prefix}${String(sameMonth + 1).padStart(4, '0')}`,
      status: 'OPEN',
      amountMinor: plan.priceMinor,
      taxMinor: 0n,
      totalMinor: plan.priceMinor,
      currencyCode: plan.currencyCode,
      periodStart,
      periodEnd,
      issuedAt: now,
      dueAt: addDays(now, INVOICE_DUE_DAYS),
    },
  });
}

function toPlan(plan: PlanRow, currentPlanId: string | null) {
  const value = (key: string) => plan.entitlements.find((e) => e.featureKey === key);
  return {
    key: plan.key,
    name: plan.name,
    description: plan.description,
    priceMinor: plan.priceMinor.toString(),
    currencyCode: plan.currencyCode,
    interval: plan.interval,
    trialDays: plan.trialDays,
    current: plan.id === currentPlanId,
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, value(k)?.limitBool === true])),
    limits: Object.fromEntries(
      LIMIT_KEYS.map((k) => {
        const row = value(k);
        return [k, row ? row.limitInt : 0];
      }),
    ),
  };
}

function toInvoice(row: {
  id: string;
  number: string;
  status: string;
  planId: string | null;
  planName: string | null;
  amountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  amountPaidMinor: bigint;
  currencyCode: string;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    plan: { id: row.planId, name: row.planName },
    amountMinor: row.amountMinor.toString(),
    taxMinor: row.taxMinor.toString(),
    totalMinor: row.totalMinor.toString(),
    amountPaidMinor: row.amountPaidMinor.toString(),
    currencyCode: row.currencyCode,
    period: { start: row.periodStart, end: row.periodEnd },
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}
