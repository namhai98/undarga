import { Injectable, Logger } from '@nestjs/common';
import type { Subscription } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError } from '../common/errors';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { EntitlementsService } from './entitlements.service';
import { GRACE_DAYS, addDays, addInterval, effectiveStatus } from './subscription-state';
import { issueInvoice, updateSubscription } from './subscriptions.service';

/**
 * ===========================================================================
 * THE PLATFORM SIDE OF SUBSCRIPTIONS
 * ===========================================================================
 *
 * Things no company may do to itself:
 *
 *   sweep          write down what time has done — trials ending, cancelled
 *                  periods running out, renewals coming due, invoices going
 *                  unpaid past their grace period.
 *   extend         give a company more time (support, a goodwill gesture).
 *   markPaid       record that an invoice was settled. This is the seam a
 *                  payment provider's webhook will call; today an operator does.
 *
 * Reads candidates across tenants on the platform connection; every write
 * re-enters that company's own transaction, under a row lock.
 *
 *   TRIAL whose trial ended                 → EXPIRED
 *   CANCELLED whose period ended            → EXPIRED
 *   PAST_DUE whose grace ended              → EXPIRED
 *   ACTIVE with an OPEN invoice past due    → PAST_DUE (grace: GRACE_DAYS)
 *   ACTIVE whose period ended               → next period; an OPEN invoice for
 *                                             it (none on a free plan)
 *
 * Expiry deletes nothing. The company turns read-only until it reactivates,
 * changes plan, or an operator extends it.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly db: TenantPrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly directory: TenantDirectoryService,
    private readonly audit: AuditService,
  ) {}

  async sweep(now = new Date()): Promise<{ expired: number; renewed: number; pastDue: number }> {
    const [due, overdue] = await Promise.all([
      this.platformDb.subscription.findMany({
        where: {
          OR: [
            { status: 'TRIAL', trialEndsAt: { lte: now } },
            { status: 'CANCELLED', currentPeriodEnd: { lte: now } },
            { status: 'PAST_DUE', graceEndsAt: { lte: now } },
            { status: 'ACTIVE', currentPeriodEnd: { lte: now } },
          ],
        },
        select: { id: true, companyId: true },
        take: 500,
      }),
      this.platformDb.subscriptionInvoice.findMany({
        where: { status: 'OPEN', dueAt: { lte: now }, subscription: { status: 'ACTIVE' } },
        select: { companyId: true },
        distinct: ['companyId'],
        take: 500,
      }),
    ]);

    const counts = { expired: 0, renewed: 0, pastDue: 0 };
    const companies = new Set([...due.map((d) => d.companyId), ...overdue.map((o) => o.companyId)]);

    for (const companyId of companies) {
      try {
        const outcome = await this.db.runInCompany(companyId, (tx) =>
          this.advance(tx, companyId, now),
        );
        if (outcome) {
          counts[outcome] += 1;
          this.invalidate(companyId);
        }
      } catch (error) {
        this.logger.error(
          `Subscription sweep failed for company ${companyId}: ${(error as Error).message}`,
        );
      }
    }

    if (companies.size > 0) {
      this.logger.log(
        `Subscriptions: ${counts.expired} expired, ${counts.renewed} renewed, ${counts.pastDue} past due.`,
      );
    }
    return counts;
  }

  async extend(companyId: string, days: number, reason: string) {
    const result = await this.inCompany(companyId, async (tx) => {
      const sub = await lock(tx, companyId);
      const now = new Date();
      const status = effectiveStatus(sub, now);
      const from = (date: Date | null) => (date && date > now ? date : now);

      if (status === 'TRIAL') {
        const trialEndsAt = addDays(from(sub.trialEndsAt), days);
        return updateSubscription(tx, companyId, sub.id, {
          trialEndsAt,
          currentPeriodEnd: trialEndsAt,
        });
      }
      if (status === 'EXPIRED') {
        return updateSubscription(tx, companyId, sub.id, {
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: addDays(now, days),
          trialEndsAt: null,
          graceEndsAt: null,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          expiredAt: null,
        });
      }
      return updateSubscription(tx, companyId, sub.id, {
        currentPeriodEnd: addDays(from(sub.currentPeriodEnd), days),
        ...(status === 'PAST_DUE' ? { graceEndsAt: addDays(from(sub.graceEndsAt), days) } : {}),
      });
    });

    this.invalidate(companyId);
    await this.audit.recordForCompany(companyId, {
      action: 'subscription.extended',
      resourceType: 'subscription',
      resourceId: result.id,
      after: { days, reason, currentPeriodEnd: result.currentPeriodEnd, status: result.status },
    });
    return result;
  }

  /**
   * Record that an invoice was paid, outside any payment provider. A past-due
   * or expired subscription whose invoice this was is ACTIVE again.
   */
  async markPaid(companyId: string, invoiceId: string, reference: string) {
    const result = await this.inCompany(companyId, async (tx) => {
      const sub = await lock(tx, companyId);
      const invoice = await tx.subscriptionInvoice.findFirst({
        where: { id: invoiceId, companyId },
      });
      if (!invoice) throw new ResourceNotFoundError('SubscriptionInvoice', invoiceId);
      if (invoice.status !== 'OPEN') {
        throw new ConflictError(`That invoice is ${invoice.status.toLowerCase()}, not open.`, {
          field: 'status',
        });
      }

      const now = new Date();
      await tx.subscriptionInvoice.updateMany({
        where: { id: invoice.id, companyId, status: 'OPEN' },
        data: { status: 'PAID', amountPaidMinor: invoice.totalMinor, paidAt: now },
      });
      await tx.subscriptionPayment.create({
        data: {
          companyId,
          invoiceId: invoice.id,
          amountMinor: invoice.totalMinor,
          currencyCode: invoice.currencyCode,
          method: 'BANK_TRANSFER',
          status: 'SUCCEEDED',
          provider: 'manual',
          providerPaymentId: reference,
          paidAt: now,
        },
      });

      const status = effectiveStatus(sub, now);
      if ((status === 'PAST_DUE' || status === 'EXPIRED') && invoice.periodEnd > now) {
        await updateSubscription(tx, companyId, sub.id, {
          status: 'ACTIVE',
          graceEndsAt: null,
          expiredAt: null,
          currentPeriodStart: invoice.periodStart,
          currentPeriodEnd: invoice.periodEnd,
        });
      }
      return { invoiceId: invoice.id, subscriptionStatus: status };
    });

    this.invalidate(companyId);
    await this.audit.recordForCompany(companyId, {
      action: 'subscription.invoice_paid',
      resourceType: 'subscription_invoice',
      resourceId: invoiceId,
      after: { reference },
    });
    return result;
  }

  // ---------------------------------------------------------------------------

  /** One step for one company. Re-reads under the lock: the sweep's list may be stale. */
  private async advance(
    tx: TenantTx,
    companyId: string,
    now: Date,
  ): Promise<'expired' | 'renewed' | 'pastDue' | null> {
    const sub = await lock(tx, companyId);
    const status = effectiveStatus(sub, now);

    if (status === 'EXPIRED' && sub.status !== 'EXPIRED') {
      await updateSubscription(tx, companyId, sub.id, { status: 'EXPIRED', expiredAt: now });
      return 'expired';
    }

    if (sub.status !== 'ACTIVE') return null;

    const overdue = await tx.subscriptionInvoice.findFirst({
      where: { companyId, subscriptionId: sub.id, status: 'OPEN', dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
    });
    if (overdue?.dueAt) {
      await updateSubscription(tx, companyId, sub.id, {
        status: 'PAST_DUE',
        graceEndsAt: addDays(overdue.dueAt, GRACE_DAYS),
      });
      return 'pastDue';
    }

    if (sub.currentPeriodEnd <= now) {
      const plan = await tx.plan.findUniqueOrThrow({
        where: { id: sub.planId },
        select: { id: true, name: true, priceMinor: true, currencyCode: true, interval: true },
      });
      const start = sub.currentPeriodEnd;
      const end = addInterval(start, plan.interval);
      await updateSubscription(tx, companyId, sub.id, {
        currentPeriodStart: start,
        currentPeriodEnd: end,
      });
      if (plan.priceMinor > 0n) await issueInvoice(tx, companyId, sub.id, plan, start, end);
      return 'renewed';
    }

    return null;
  }

  private async inCompany<T>(companyId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const company = await this.directory.getCompany(companyId);
    if (!company || company.deletedAt) throw new ResourceNotFoundError('Company', companyId);
    return this.db.runInCompany(companyId, fn);
  }

  private invalidate(companyId: string) {
    this.entitlements.invalidate(companyId);
    this.directory.invalidate(companyId);
  }
}

async function lock(tx: TenantTx, companyId: string): Promise<Subscription> {
  await tx.$queryRaw`SELECT id FROM subscription WHERE company_id = ${companyId}::uuid FOR UPDATE`;
  const sub = await tx.subscription.findFirst({ where: { companyId } });
  if (!sub) throw new ResourceNotFoundError('Subscription', companyId);
  return sub;
}
