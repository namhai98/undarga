import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type ActorType,
  type PaymentPurpose,
  type PaymentTransaction,
  type PaymentTransactionKind,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import {
  ConflictError,
  PaymentProviderError,
  PaymentsUnavailableError,
  PermissionDeniedError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  NOTIFICATION_EVENTS,
  writeNotificationEvent,
} from '../notifications/notification-event.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import {
  recordFailedInvoiceAttempt,
  settleInvoicePayment,
} from '../subscriptions/subscription-lifecycle.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { MockPaymentProvider } from './gateway/mock.provider';
import { PaymentGateway } from './gateway/payment-gateway';
import type {
  CheckoutDetails,
  PaymentProvider,
  ProviderPaymentState,
} from './gateway/payment-provider';
import { PaymentSigner } from './gateway/payment-signer';
import { PaymentsService } from './payments.service';
import type { RefundOnlinePaymentDto } from './dto/online-payment.dto';

/** A checkout nobody has paid is retired after this long, and a fresh one issued. */
const CHECKOUT_TTL_MS = 30 * 60_000;
/** A transaction reserved but never handed to the provider (a crash mid-start). */
const ABANDONED_AFTER_MS = 2 * 60_000;
/** How long a status read may reuse the last provider answer. */
const RECHECK_AFTER_MS = 10_000;
/** How long the payment link on a public booking confirmation works. */
const PAYMENT_LINK_TTL_MS = 48 * 3_600_000;

const OPEN = ['PENDING', 'PROCESSING'] as const;

interface Target {
  amountMinor: bigint;
  currencyCode: string;
  customerId: string | null;
  description: string;
  reference: string;
  purpose: PaymentPurpose;
}

interface StartSpec {
  kind: PaymentTransactionKind;
  appointmentId?: string;
  subscriptionInvoiceId?: string;
  idempotencyKey: string;
  initiatedBy: { type: ActorType; id: string | null };
  /** Read what is owed, inside the reservation transaction. Throws if nothing. */
  resolve: (tx: TenantTx) => Promise<Target>;
}

export interface ApplyResult {
  changed: boolean;
  status: PaymentTransaction['status'];
}

/**
 * ===========================================================================
 * ONLINE PAYMENTS: FROM "PAY NOW" TO MONEY IN THE BOOKS
 * ===========================================================================
 *
 *   start      reserve a PENDING transaction (one open per appointment or
 *              invoice — a partial unique index, not a hope), ask the provider
 *              for a checkout, store it. Idempotent on the caller's key.
 *   sync       ask the PROVIDER what happened (server to server) and apply it.
 *              Webhooks, status polls and the refresh button all end here.
 *   apply      under a row lock, move the state and, on success, settle into the
 *              existing records in the SAME transaction:
 *                appointment  -> a `payment` row, ledger entries, derived
 *                                appointment totals, the receipt event
 *                invoice      -> invoice PAID, `subscription_payment`, a lapsed
 *                                subscription reactivated
 *
 * Nothing a browser says is believed: the only inputs to `apply` are provider
 * answers this server fetched itself. Duplicate webhooks, a webhook racing a
 * poll, and a retried start are all no-ops by construction — the lock
 * serialises them and every transition checks where it is coming from.
 *
 * Provider calls never happen inside a database transaction.
 */
@Injectable()
export class PaymentTransactionsService {
  private readonly logger = new Logger(PaymentTransactionsService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
    private readonly gateway: PaymentGateway,
    private readonly signer: PaymentSigner,
    private readonly payments: PaymentsService,
    private readonly entitlements: EntitlementsService,
    private readonly directory: TenantDirectoryService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // Starting a payment
  // ===========================================================================

  /** Staff take an online payment for an appointment (`payment:write`). */
  async createForAppointment(input: {
    appointmentId: string;
    amountMinor?: string;
    idempotencyKey: string;
  }) {
    const companyId = this.context.requireCompanyId('start an online payment');
    const requested = input.amountMinor ? BigInt(input.amountMinor) : null;

    const row = await this.start(companyId, {
      kind: 'APPOINTMENT',
      appointmentId: input.appointmentId,
      idempotencyKey: input.idempotencyKey,
      initiatedBy: this.staffActor(),
      resolve: (tx) => this.appointmentTarget(tx, companyId, input.appointmentId, { requested }),
    });
    return toView(row);
  }

  /** The owner pays a subscription invoice (`settings:billing:write`). */
  async createForInvoice(invoiceId: string, idempotencyKey: string) {
    const companyId = this.context.requireCompanyId('pay an invoice');

    const row = await this.start(companyId, {
      kind: 'SUBSCRIPTION_INVOICE',
      subscriptionInvoiceId: invoiceId,
      idempotencyKey,
      initiatedBy: this.staffActor(),
      resolve: async (tx) => {
        const invoice = await tx.subscriptionInvoice.findFirst({
          where: { id: invoiceId, companyId },
          select: {
            status: true,
            number: true,
            totalMinor: true,
            amountPaidMinor: true,
            currencyCode: true,
          },
        });
        if (!invoice) throw new ResourceNotFoundError('SubscriptionInvoice', invoiceId);
        if (invoice.status !== 'OPEN') {
          throw new ConflictError(`That invoice is ${invoice.status.toLowerCase()}, not open.`, {
            field: 'status',
          });
        }
        const amountMinor = invoice.totalMinor - invoice.amountPaidMinor;
        if (amountMinor <= 0n) throw new ConflictError('Nothing is owed on that invoice.');
        return {
          amountMinor,
          currencyCode: invoice.currencyCode,
          customerId: null,
          description: 'Subscription',
          reference: invoice.number,
          purpose: 'OTHER',
        };
      },
    });
    return toView(row);
  }

  /**
   * The anonymous booker pays from the confirmation page. `paymentToken` is the
   * signed capability issued with that booking — the only thing that names an
   * appointment here, so nobody can pay against, or read, another booking.
   */
  async createPublic(companyId: string, paymentToken: string, idempotencyKey: string) {
    const link = await this.resolveLink(companyId, paymentToken);
    const row = await this.start(companyId, {
      kind: 'APPOINTMENT',
      appointmentId: link.appointmentId,
      idempotencyKey: `pub:${idempotencyKey}`,
      initiatedBy: { type: 'CUSTOMER', id: null },
      resolve: (tx) =>
        this.appointmentTarget(tx, companyId, link.appointmentId, { publicDeposit: true }),
    });
    return toPublicView(row);
  }

  /**
   * What the booking confirmation offers, or null when online payment is not
   * possible (no provider, nothing owed, a currency the provider cannot take).
   */
  async publicOffer(companyId: string, appointmentId: string) {
    if (!this.gateway.enabled || !this.signer.configured) return null;
    const provider = this.gateway.active();
    try {
      const target = await this.db.runInCompany(companyId, (tx) =>
        this.appointmentTarget(tx, companyId, appointmentId, { publicDeposit: true }),
      );
      if (!provider.supportsCurrency(target.currencyCode)) return null;
      return {
        token: this.signer.issuePaymentLink(companyId, target.reference, PAYMENT_LINK_TTL_MS),
        amountMinor: target.amountMinor.toString(),
        currencyCode: target.currencyCode,
        purpose: target.purpose,
      };
    } catch {
      return null;
    }
  }

  /**
   * Reserve, ask the provider, store the checkout.
   *
   *   1. tx: replay by idempotency key; return an open transaction for the same
   *      target instead of making a second; retire a stale one; insert PENDING.
   *      The partial unique index makes "one open per target" true under
   *      concurrency — a racing insert loses, and step 1 re-runs to find it.
   *   2. no tx: provider.createPayment, keyed on our transaction id.
   *   3. tx: store the provider's id and checkout.
   *
   * A crash between 2 and 3 leaves a PENDING row with no provider id; a retry
   * with the same key resumes it (the provider call is keyed on the row id).
   */
  private async start(companyId: string, spec: StartSpec): Promise<PaymentTransaction> {
    const provider = this.gateway.active();
    if (!this.signer.configured) throw new PaymentsUnavailableError();

    const reserve = () =>
      this.db.runInCompany(companyId, async (tx) => {
        const now = Date.now();
        const retire: PaymentTransaction[] = [];

        const replay = await tx.paymentTransaction.findFirst({
          where: { companyId, idempotencyKey: spec.idempotencyKey },
        });
        if (replay) {
          if (
            replay.kind !== spec.kind ||
            replay.appointmentId !== (spec.appointmentId ?? null) ||
            replay.subscriptionInvoiceId !== (spec.subscriptionInvoiceId ?? null)
          ) {
            throw new ConflictError(
              'That idempotency key was already used for a different payment.',
              {
                field: 'idempotencyKey',
              },
            );
          }
          return { row: replay, minorUnit: await minorUnitOf(tx, replay.currencyCode), retire };
        }

        const open = await tx.paymentTransaction.findFirst({
          where: {
            companyId,
            status: { in: [...OPEN] },
            ...(spec.appointmentId
              ? { appointmentId: spec.appointmentId }
              : { subscriptionInvoiceId: spec.subscriptionInvoiceId }),
          },
        });
        if (open) {
          const abandoned =
            !open.providerTransactionId && open.createdAt.getTime() < now - ABANDONED_AFTER_MS;
          const expired =
            open.status === 'PENDING' && open.expiresAt !== null && open.expiresAt.getTime() <= now;
          if (!abandoned && !expired) {
            return { row: open, minorUnit: await minorUnitOf(tx, open.currencyCode), retire };
          }
          await tx.paymentTransaction.updateMany({
            where: { id: open.id, companyId, status: open.status },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(now),
              failureReason: abandoned ? 'Never reached the provider.' : 'Expired before payment.',
            },
          });
          retire.push(open);
        }

        const target = await spec.resolve(tx);
        if (!provider.supportsCurrency(target.currencyCode)) {
          throw new PaymentsUnavailableError(
            `Online payments in ${target.currencyCode} are not available.`,
          );
        }

        const row = await tx.paymentTransaction.create({
          data: {
            companyId,
            kind: spec.kind,
            status: 'PENDING',
            appointmentId: spec.appointmentId ?? null,
            subscriptionInvoiceId: spec.subscriptionInvoiceId ?? null,
            customerId: target.customerId,
            initiatedByType: spec.initiatedBy.type,
            initiatedById: spec.initiatedBy.id,
            amountMinor: target.amountMinor,
            currencyCode: target.currencyCode,
            provider: provider.name,
            idempotencyKey: spec.idempotencyKey,
            metadata: {
              purpose: target.purpose,
              reference: target.reference,
              description: target.description,
            },
          },
        });
        return { row, minorUnit: await minorUnitOf(tx, row.currencyCode), retire };
      });

    let reserved: Awaited<ReturnType<typeof reserve>>;
    try {
      reserved = await reserve();
    } catch (error) {
      // Lost the race for "one open transaction per target" or for the key:
      // the winner's row is the answer, so look again.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        reserved = await reserve();
      } else {
        throw error;
      }
    }

    for (const stale of reserved.retire) void this.cancelAtProvider(stale);

    const { row, minorUnit } = reserved;
    if (row.providerTransactionId || row.status !== 'PENDING') return row;

    // -- 2. Ask the provider -------------------------------------------------
    const meta = (row.metadata ?? {}) as { description?: string; reference?: string };
    const rowProvider = this.gateway.byName(row.provider) ?? provider;
    let created;
    try {
      created = await rowProvider.createPayment({
        transactionId: row.id,
        idempotencyKey: row.id,
        amountMinor: row.amountMinor,
        currencyCode: row.currencyCode,
        minorUnit,
        description: meta.description ?? 'Payment',
        reference: meta.reference ?? row.id,
        callbackUrl: this.signer.callbackUrl(rowProvider.name, row.id),
      });
    } catch (error) {
      await this.db.runInCompany(companyId, (tx) =>
        tx.paymentTransaction.updateMany({
          where: { id: row.id, companyId, status: 'PENDING', providerTransactionId: null },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            failureReason: 'The provider could not start this payment.',
          },
        }),
      );
      this.logger.error(`Provider ${rowProvider.name} could not start transaction ${row.id}.`);
      throw error instanceof PaymentProviderError ? error : new PaymentProviderError();
    }

    // -- 3. Store the checkout ------------------------------------------------
    const stored = await this.db.runInCompany(companyId, async (tx) => {
      await tx.paymentTransaction.updateMany({
        where: { id: row.id, companyId, providerTransactionId: null },
        data: {
          providerTransactionId: created.providerTransactionId,
          checkout: created.checkout as Prisma.InputJsonValue,
          expiresAt: created.expiresAt ?? new Date(Date.now() + CHECKOUT_TTL_MS),
          ...(created.status === 'PROCESSING' ? { status: 'PROCESSING' } : {}),
        },
      });
      return tx.paymentTransaction.findFirstOrThrow({ where: { id: row.id, companyId } });
    });

    await this.audit.recordForCompany(companyId, {
      action: 'payment.online_started',
      resourceType: 'payment_transaction',
      resourceId: stored.id,
      after: {
        kind: stored.kind,
        provider: stored.provider,
        amountMinor: stored.amountMinor.toString(),
        currencyCode: stored.currencyCode,
      },
    });
    return stored;
  }

  // ===========================================================================
  // Reading
  // ===========================================================================

  /** Staff/owner view. Re-checks a stale open transaction with the provider first. */
  async get(transactionId: string) {
    const companyId = this.context.requireCompanyId('read a payment');
    const row = await this.findRow(companyId, transactionId);
    this.assertKindPermission(row.kind, 'read');
    if (isOpen(row.status)) await this.syncSafely(companyId, row.id);
    return toView(await this.findRow(companyId, transactionId));
  }

  async getPublic(companyId: string, transactionId: string, token: string) {
    const link = await this.resolveLink(companyId, token);
    const row = await this.findRow(companyId, transactionId).catch(() => null);
    // A transaction for a different booking answers exactly like none at all.
    if (!row || row.appointmentId !== link.appointmentId) {
      throw new ResourceNotFoundError('PaymentTransaction', transactionId);
    }
    if (isOpen(row.status)) await this.syncSafely(companyId, row.id);
    return toPublicView(await this.findRow(companyId, transactionId));
  }

  // ===========================================================================
  // Provider state -> our state
  // ===========================================================================

  /**
   * Ask the provider and apply its answer. `force` skips the recheck window
   * (a webhook is a reason to look now); `fromWebhook` also lets a closed
   * transaction be re-examined, because money paid late must still be booked.
   */
  async syncWithProvider(
    companyId: string,
    transactionId: string,
    options: { force?: boolean; fromWebhook?: boolean } = {},
  ): Promise<ApplyResult> {
    const row = await this.findRow(companyId, transactionId);
    const unchanged = { changed: false, status: row.status };

    if (!row.providerTransactionId) return unchanged;
    if (row.status === 'SUCCEEDED' || row.status === 'REFUNDED') {
      if (!options.fromWebhook) return unchanged;
    } else if (!isOpen(row.status) && !options.fromWebhook) {
      return unchanged;
    }
    if (
      !options.force &&
      row.lastCheckedAt &&
      Date.now() - row.lastCheckedAt.getTime() < RECHECK_AFTER_MS
    ) {
      return unchanged;
    }

    const provider = this.gateway.byName(row.provider);
    if (!provider) return unchanged;

    const state = await provider.getPayment(row.providerTransactionId);
    return this.applyProviderState(companyId, row.id, state, provider);
  }

  /**
   * Move one transaction to what the provider says, settling on success.
   *
   * The row lock is taken by an UPDATE of `last_checked_at`, held to commit:
   * a webhook and a poll for the same payment serialise here, and the second
   * sees the first's result and does nothing.
   */
  async applyProviderState(
    companyId: string,
    transactionId: string,
    state: ProviderPaymentState,
    provider: PaymentProvider,
  ): Promise<ApplyResult> {
    let retireAtProvider: string | null = null;
    let audit: { action: string; after: Record<string, unknown> } | null = null;
    let settledInvoice = false;

    const result = await this.db.runInCompany(companyId, async (tx): Promise<ApplyResult> => {
      const now = new Date();
      await tx.paymentTransaction.updateMany({
        where: { id: transactionId, companyId },
        data: { lastCheckedAt: now },
      });
      const row = await tx.paymentTransaction.findFirstOrThrow({
        where: { id: transactionId, companyId },
      });
      const set = (data: Prisma.PaymentTransactionUpdateManyMutationInput) =>
        tx.paymentTransaction.updateMany({ where: { id: row.id, companyId }, data });

      // -- Paid --------------------------------------------------------------
      if (state.status === 'SUCCEEDED') {
        if (row.status === 'SUCCEEDED' || row.status === 'REFUNDED') {
          return { changed: false, status: row.status };
        }
        const paid = state.paidAmountMinor;
        if (
          (paid !== null && paid !== undefined && paid !== row.amountMinor) ||
          (state.currencyCode && state.currencyCode !== row.currencyCode)
        ) {
          // Never settle an amount we did not ask for. A human reconciles it.
          await set({
            status: 'PROCESSING',
            failureReason: 'The provider reported a different amount. Needs review.',
          });
          audit = {
            action: 'payment.amount_mismatch',
            after: {
              expectedMinor: row.amountMinor.toString(),
              reportedMinor: paid?.toString() ?? null,
            },
          };
          return { changed: true, status: 'PROCESSING' };
        }

        const feeMinor = state.feeMinor ?? 0n;
        const link: Prisma.PaymentTransactionUpdateManyMutationInput & {
          paymentId?: string;
          subscriptionPaymentId?: string;
        } = {};
        let note: string | null = null;

        if (row.kind === 'APPOINTMENT' && row.appointmentId) {
          const meta = (row.metadata ?? {}) as { purpose?: PaymentPurpose };
          const payment = await this.payments.recordSettledOnlineWithin(tx, companyId, {
            transactionId: row.id,
            appointmentId: row.appointmentId,
            customerId: row.customerId,
            amountMinor: row.amountMinor,
            feeMinor,
            currencyCode: row.currencyCode,
            provider: row.provider,
            providerTransactionId: row.providerTransactionId,
            providerPaymentId: state.providerPaymentId ?? null,
            purpose: meta.purpose ?? 'BOOKING',
          });
          link.paymentId = payment.id;
        } else if (row.kind === 'SUBSCRIPTION_INVOICE' && row.subscriptionInvoiceId) {
          const settled = await settleInvoicePayment(tx, companyId, row.subscriptionInvoiceId, {
            amountMinor: row.amountMinor,
            currencyCode: row.currencyCode,
            method: 'ONLINE',
            provider: row.provider,
            providerPaymentId: state.providerPaymentId ?? row.providerTransactionId ?? row.id,
          });
          link.subscriptionPaymentId = settled.subscriptionPaymentId;
          settledInvoice = true;
          if (!settled.invoiceWasOpen) {
            note = 'Paid after the invoice had closed. Refund or credit it.';
          }
        }

        await tx.paymentTransaction.updateMany({
          where: { id: row.id, companyId },
          data: {
            ...link,
            status: 'SUCCEEDED',
            providerPaymentId: state.providerPaymentId ?? null,
            feeMinor: feeMinor > row.amountMinor ? 0n : feeMinor,
            succeededAt: now,
            failureReason: note,
          },
        });
        audit = {
          action:
            row.kind === 'APPOINTMENT'
              ? 'payment.online_succeeded'
              : 'subscription.payment_succeeded',
          after: {
            amountMinor: row.amountMinor.toString(),
            currencyCode: row.currencyCode,
            providerPaymentId: state.providerPaymentId ?? null,
            lateAfter: row.status === 'PENDING' || row.status === 'PROCESSING' ? null : row.status,
          },
        };
        return { changed: true, status: 'SUCCEEDED' };
      }

      // -- Refunded at the provider, outside this system --------------------
      if (state.status === 'REFUNDED') {
        if (row.status === 'SUCCEEDED' && row.refundedMinor < row.amountMinor) {
          // Not booked automatically: the ledger reversal needs a person who
          // knows why. Flagged for reconciliation instead.
          await set({
            failureReason: 'Refunded at the provider outside this system. Reconcile it.',
          });
          audit = { action: 'payment.refunded_externally', after: {} };
          return { changed: true, status: row.status };
        }
        return { changed: false, status: row.status };
      }

      // Everything below only moves a transaction that is still open.
      if (!isOpen(row.status)) return { changed: false, status: row.status };

      if (state.status === 'PROCESSING') {
        if (row.status === 'PROCESSING') return { changed: false, status: row.status };
        await set({ status: 'PROCESSING' });
        return { changed: true, status: 'PROCESSING' };
      }

      if (state.status === 'FAILED') {
        await set({
          status: 'FAILED',
          failedAt: now,
          failureReason: state.failureReason ?? 'The payment failed.',
        });
        if (row.kind === 'SUBSCRIPTION_INVOICE' && row.subscriptionInvoiceId) {
          await recordFailedInvoiceAttempt(tx, companyId, row.subscriptionInvoiceId);
          await writeNotificationEvent(
            tx,
            companyId,
            NOTIFICATION_EVENTS.SUBSCRIPTION_PAYMENT_FAILED,
            {
              invoiceId: row.subscriptionInvoiceId,
              paymentStatus: 'declined or cancelled',
              dedupeBase: `subscription.payment_failed:${row.id}`,
            },
          );
        } else if (row.kind === 'APPOINTMENT' && row.customerId) {
          // In this transaction, so the notice exists exactly when the failure
          // does; the transition above only happens once per transaction.
          await writeNotificationEvent(tx, companyId, NOTIFICATION_EVENTS.PAYMENT_FAILED, {
            paymentTransactionId: row.id,
            appointmentId: row.appointmentId,
            customerId: row.customerId,
            amountMinor: row.amountMinor.toString(),
            currencyCode: row.currencyCode,
            dedupeBase: `payment.failed:${row.id}`,
          });
        }
        audit = {
          action:
            row.kind === 'APPOINTMENT' ? 'payment.online_failed' : 'subscription.payment_failed',
          after: { reason: state.failureReason ?? null },
        };
        return { changed: true, status: 'FAILED' };
      }

      if (state.status === 'CANCELLED') {
        await set({
          status: 'CANCELLED',
          cancelledAt: now,
          failureReason: state.failureReason ?? null,
        });
        return { changed: true, status: 'CANCELLED' };
      }

      // Still PENDING at the provider.
      if (row.status === 'PENDING' && row.expiresAt && row.expiresAt <= now) {
        await set({
          status: 'CANCELLED',
          cancelledAt: now,
          failureReason: 'Expired before payment.',
        });
        retireAtProvider = row.providerTransactionId;
        return { changed: true, status: 'CANCELLED' };
      }
      if (state.failureReason && state.failureReason !== row.failureReason) {
        await set({ failureReason: state.failureReason });
      }
      return { changed: false, status: row.status };
    });

    if (settledInvoice) {
      this.entitlements.invalidate(companyId);
      this.directory.invalidate(companyId);
    }
    if (retireAtProvider) void provider.cancelPayment(retireAtProvider).catch(() => undefined);
    if (audit) {
      const entry = audit as { action: string; after: Record<string, unknown> };
      await this.audit.recordForCompany(companyId, {
        action: entry.action,
        resourceType: 'payment_transaction',
        resourceId: transactionId,
        after: { ...entry.after, status: result.status, provider: provider.name },
      });
    }
    if (result.changed) {
      this.logger.log(`Transaction ${transactionId} is now ${result.status}.`);
    }
    return result;
  }

  // ===========================================================================
  // Cancelling and refunding
  // ===========================================================================

  /** Abandon an unpaid checkout. Money that still arrives later is booked anyway. */
  async cancel(transactionId: string) {
    const companyId = this.context.requireCompanyId('cancel a payment');
    const row = await this.findRow(companyId, transactionId);
    this.assertKindPermission(row.kind, 'write');
    if (row.status !== 'PENDING') {
      throw new ConflictError(
        `That payment is ${row.status.toLowerCase()} and cannot be cancelled.`,
        {
          field: 'status',
        },
      );
    }
    await this.db.runInCompany(companyId, (tx) =>
      tx.paymentTransaction.updateMany({
        where: { id: row.id, companyId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), failureReason: 'Cancelled.' },
      }),
    );
    await this.cancelAtProvider(row);
    await this.audit.recordForCompany(companyId, {
      action: 'payment.online_cancelled',
      resourceType: 'payment_transaction',
      resourceId: row.id,
    });
    return toView(await this.findRow(companyId, transactionId));
  }

  /**
   * Refund an appointment's online payment (`payment:refund`). Goes through
   * PaymentsService so the ledger, the appointment and the provider move
   * together; SaaS payments are refunded by the platform, not the tenant.
   */
  async refund(transactionId: string, input: RefundOnlinePaymentDto) {
    const companyId = this.context.requireCompanyId('refund a payment');
    const row = await this.findRow(companyId, transactionId);
    if (row.kind !== 'APPOINTMENT') {
      throw new PermissionDeniedError(['platform:billing:manage']);
    }
    if (!row.paymentId || (row.status !== 'SUCCEEDED' && row.status !== 'REFUNDED')) {
      throw new ValidationFailedError({ transactionId: 'Only a settled payment can be refunded.' });
    }
    await this.payments.refund(row.paymentId, {
      amountMinor: input.amountMinor,
      reason: input.reason,
      destination: 'ORIGINAL_METHOD',
    });
    return toView(await this.findRow(companyId, transactionId));
  }

  /**
   * Refund a SaaS subscription payment — operators only (platform route).
   * Whole payments only. The invoice stays PAID and the subscription is left
   * alone: what happens to the account afterwards is a separate decision.
   *
   * The refundable amount is reserved BEFORE the provider call (refunded_minor
   * set in the first transaction), so two operators clicking at once cannot
   * both refund; a failed provider call releases it.
   */
  async refundSubscription(companyId: string, transactionId: string, reason: string) {
    const reserved = await this.db.runInCompany(companyId, async (tx) => {
      await tx.paymentTransaction.updateMany({
        where: { id: transactionId, companyId },
        data: { lastCheckedAt: new Date() },
      });
      const row = await tx.paymentTransaction.findFirst({
        where: { id: transactionId, companyId },
      });
      if (!row) throw new ResourceNotFoundError('PaymentTransaction', transactionId);
      if (row.kind !== 'SUBSCRIPTION_INVOICE') {
        throw new ValidationFailedError({
          transactionId: 'Appointment payments are refunded by the company that took them.',
        });
      }
      if (row.status !== 'SUCCEEDED' || !row.providerPaymentId || row.refundedMinor > 0n) {
        throw new ValidationFailedError({
          transactionId: 'Only a settled, unrefunded payment can be refunded.',
        });
      }
      await tx.paymentTransaction.updateMany({
        where: { id: row.id, companyId },
        data: { refundedMinor: row.amountMinor },
      });
      return { row, minorUnit: await minorUnitOf(tx, row.currencyCode) };
    });

    const { row } = reserved;
    const provider = this.gateway.byName(row.provider);
    let outcome: { status: 'SUCCEEDED' | 'PENDING' | 'FAILED'; failureReason?: string | null };
    if (!provider) {
      outcome = {
        status: 'FAILED',
        failureReason: 'That payment’s provider is no longer configured.',
      };
    } else {
      try {
        outcome = await provider.refundPayment({
          providerTransactionId: row.providerTransactionId,
          providerPaymentId: row.providerPaymentId!,
          amountMinor: row.amountMinor,
          paymentAmountMinor: row.amountMinor,
          currencyCode: row.currencyCode,
          minorUnit: reserved.minorUnit,
          idempotencyKey: `refund:${row.id}`,
          reason,
        });
      } catch {
        outcome = { status: 'FAILED', failureReason: 'The provider could not be reached.' };
      }
    }

    await this.db.runInCompany(companyId, (tx) =>
      tx.paymentTransaction.updateMany({
        where: { id: row.id, companyId },
        data:
          outcome.status === 'FAILED'
            ? { refundedMinor: 0n }
            : { status: 'REFUNDED', refundedAt: new Date() },
      }),
    );
    await this.audit.recordForCompany(companyId, {
      action:
        outcome.status === 'FAILED'
          ? 'subscription.refund_failed'
          : 'subscription.payment_refunded',
      resourceType: 'payment_transaction',
      resourceId: row.id,
      after: { amountMinor: row.amountMinor.toString(), outcome: outcome.status },
      metadata: { reason },
    });

    if (outcome.status === 'FAILED') {
      throw new PaymentProviderError(outcome.failureReason ?? 'The provider declined the refund.');
    }
    return this.db.runInCompany(companyId, async (tx) =>
      toView(await tx.paymentTransaction.findFirstOrThrow({ where: { id: row.id, companyId } })),
    );
  }

  // ===========================================================================
  // Development: drive the mock provider through the real webhook path
  // ===========================================================================

  /**
   * Returns the signed webhook the mock "gateway" would send; the caller posts
   * it to the webhook handler. Refused unless the transaction's provider is the
   * mock — which env validation already keeps out of production.
   */
  async simulateOutcome(
    companyId: string,
    transactionId: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    options: { token?: string } = {},
  ) {
    const row = await this.findRow(companyId, transactionId);
    if (options.token !== undefined) {
      const link = await this.resolveLink(companyId, options.token);
      if (row.appointmentId !== link.appointmentId) {
        throw new ResourceNotFoundError('PaymentTransaction', transactionId);
      }
    }
    const provider = this.gateway.byName(row.provider);
    if (!(provider instanceof MockPaymentProvider) || !row.providerTransactionId) {
      throw new ResourceNotFoundError('PaymentTransaction', transactionId);
    }
    return provider.simulate(row.providerTransactionId, outcome);
  }

  // ===========================================================================

  private async appointmentTarget(
    tx: TenantTx,
    companyId: string,
    appointmentId: string,
    options: { requested?: bigint | null; publicDeposit?: boolean },
  ): Promise<Target> {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, companyId },
      select: {
        status: true,
        totalMinor: true,
        currencyCode: true,
        customerId: true,
        appointmentNumber: true,
      },
    });
    if (!appointment) throw new ResourceNotFoundError('Appointment', appointmentId);
    if (appointment.status === 'CANCELLED' || appointment.status === 'EXPIRED') {
      throw new ConflictError(`That appointment is ${appointment.status.toLowerCase()}.`, {
        field: 'status',
      });
    }

    const settled = await tx.payment.aggregate({
      where: { companyId, appointmentId, status: 'SUCCEEDED' },
      _sum: { amountMinor: true, refundedMinor: true },
    });
    const net = (settled._sum.amountMinor ?? 0n) - (settled._sum.refundedMinor ?? 0n);
    const outstanding = appointment.totalMinor - net;
    if (outstanding <= 0n) throw new ConflictError('Nothing is owed on that appointment.');

    let amountMinor = outstanding;
    let purpose: PaymentPurpose = net > 0n ? 'BALANCE' : 'BOOKING';

    if (options.requested !== undefined && options.requested !== null) {
      if (options.requested <= 0n)
        throw new ValidationFailedError({ amountMinor: 'Must be positive.' });
      if (options.requested > outstanding) {
        throw new ValidationFailedError({
          amountMinor: `At most ${outstanding.toString()} is owed on that appointment.`,
        });
      }
      amountMinor = options.requested;
    } else if (options.publicDeposit && net === 0n) {
      // The company's deposit policy, when it has one: the booker pays the
      // deposit online and the rest at the visit.
      const settings = await tx.companySettings.findFirst({
        where: { companyId },
        select: { requireDeposit: true, depositPercentBps: true },
      });
      if (settings?.requireDeposit && settings.depositPercentBps > 0) {
        const deposit =
          (appointment.totalMinor * BigInt(settings.depositPercentBps) + 9_999n) / 10_000n;
        if (deposit > 0n && deposit < outstanding) {
          amountMinor = deposit;
          purpose = 'DEPOSIT';
        }
      }
    }

    return {
      amountMinor,
      currencyCode: appointment.currencyCode,
      customerId: appointment.customerId,
      description: 'Appointment',
      reference: appointment.appointmentNumber,
      purpose,
    };
  }

  /** The appointment a payment link names, or a 404 for anything else. */
  private async resolveLink(companyId: string, token: string): Promise<{ appointmentId: string }> {
    const link = this.signer.configured ? this.signer.readPaymentLink(companyId, token) : null;
    const appointment = link
      ? await this.db.runInCompany(companyId, (tx) =>
          tx.appointment.findFirst({
            where: { companyId, appointmentNumber: link.appointmentNumber },
            select: { id: true },
          }),
        )
      : null;
    // Forged, expired, for another company, or naming nothing: indistinguishable.
    if (!appointment) throw new ResourceNotFoundError('PaymentLink');
    return { appointmentId: appointment.id };
  }

  private async findRow(companyId: string, transactionId: string) {
    const row = await this.db.runInCompany(companyId, (tx) =>
      tx.paymentTransaction.findFirst({ where: { id: transactionId, companyId } }),
    );
    if (!row) throw new ResourceNotFoundError('PaymentTransaction', transactionId);
    return row;
  }

  /** A provider outage must not turn a status read into a 502. */
  private async syncSafely(companyId: string, transactionId: string) {
    try {
      await this.syncWithProvider(companyId, transactionId);
    } catch (error) {
      this.logger.warn(`Status check for ${transactionId} failed: ${(error as Error).message}`);
    }
  }

  private async cancelAtProvider(
    row: Pick<PaymentTransaction, 'provider' | 'providerTransactionId'>,
  ) {
    const provider = this.gateway.byName(row.provider);
    if (provider && row.providerTransactionId) {
      await provider.cancelPayment(row.providerTransactionId).catch(() => undefined);
    }
  }

  /** Appointment money and SaaS billing are different permissions. */
  private assertKindPermission(kind: PaymentTransactionKind, access: 'read' | 'write') {
    const needed =
      kind === 'APPOINTMENT'
        ? access === 'read'
          ? COMPANY_PERMISSIONS.PAYMENT_READ
          : COMPANY_PERMISSIONS.PAYMENT_WRITE
        : access === 'read'
          ? COMPANY_PERMISSIONS.BILLING_READ
          : COMPANY_PERMISSIONS.BILLING_WRITE;
    if (!this.context.hasPermission(needed)) throw new PermissionDeniedError([needed]);
  }

  private staffActor(): { type: ActorType; id: string | null } {
    return { type: 'COMPANY_USER', id: this.context.membership()?.companyUserId ?? null };
  }
}

// ---------------------------------------------------------------------------

function isOpen(status: PaymentTransaction['status']): boolean {
  return status === 'PENDING' || status === 'PROCESSING';
}

async function minorUnitOf(tx: TenantTx, currencyCode: string): Promise<number> {
  const currency = await tx.currency.findUnique({
    where: { code: currencyCode },
    select: { minorUnit: true },
  });
  return currency?.minorUnit ?? 2;
}

function checkoutOf(row: PaymentTransaction): CheckoutDetails | null {
  // Only while it can still be paid: a settled payment's QR is just noise.
  return isOpen(row.status) ? ((row.checkout ?? null) as CheckoutDetails | null) : null;
}

function common(row: PaymentTransaction) {
  const meta = (row.metadata ?? {}) as { purpose?: string; reference?: string };
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    purpose: meta.purpose ?? null,
    reference: meta.reference ?? null,
    amountMinor: row.amountMinor.toString(),
    refundedMinor: row.refundedMinor.toString(),
    currencyCode: row.currencyCode,
    provider: row.provider,
    checkout: checkoutOf(row),
    expiresAt: row.expiresAt,
    failureReason: row.failureReason,
    /** A new attempt may be started (a fresh idempotency key). */
    retryable: row.status === 'FAILED' || row.status === 'CANCELLED',
    createdAt: row.createdAt,
    succeededAt: row.succeededAt,
  };
}

export function toView(row: PaymentTransaction) {
  return {
    ...common(row),
    feeMinor: row.feeMinor.toString(),
    appointmentId: row.appointmentId,
    subscriptionInvoiceId: row.subscriptionInvoiceId,
    paymentId: row.paymentId,
    providerReference: row.providerPaymentId ?? row.providerTransactionId,
    failedAt: row.failedAt,
    cancelledAt: row.cancelledAt,
    refundedAt: row.refundedAt,
  };
}

/** What an anonymous booker sees: their payment, none of our internal ids. */
export function toPublicView(row: PaymentTransaction) {
  return common(row);
}
