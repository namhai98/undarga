import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type ActorType,
  type AppointmentPaymentStatus,
  type LedgerAccount,
  type PaymentMethod,
  type PaymentStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { GiftCardsService } from '../giftcards/giftcards.service';
import { NotificationEventService } from '../notifications/notification-event.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { PaymentProviderRegistry } from './providers/provider.registry';
import type { CreatePaymentDto, PaymentQueryDto, RefundPaymentDto } from './dto/payment.dto';

interface PaymentRow {
  id: string;
  companyId: string;
  amountMinor: bigint;
}

@Injectable()
export class PaymentRepository extends TenantScopedRepository<PaymentRow> {
  protected readonly modelName = 'Payment';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<PaymentRow> {
    return tx.payment;
  }
}

/**
 * What step 1 of `create` hands to step 3.
 *
 * A set `replayOf` means the whole call is a retry of a payment that already
 * exists, and the other fields are then meaningless and never read. A
 * discriminated union would be tidier in the type, and would make every field
 * access below conditional on a narrowing the code has already performed once —
 * so the flag is checked in exactly one place instead.
 */
interface Prepared {
  replayOf: string | null;
  currencyCode: string;
  amountMinor: bigint;
  branchId: string | null;
  customerId: string | null;
  appointmentId: string | null;
}

/** Which clearing account a method lands in. Every method must have one. */
const CLEARING_ACCOUNT: Record<PaymentMethod, LedgerAccount> = {
  CASH: 'CASH_CLEARING',
  CARD: 'CARD_CLEARING',
  BANK_TRANSFER: 'BANK_CLEARING',
  ONLINE: 'ONLINE_CLEARING',
  GIFT_CARD: 'GIFT_CARD_LIABILITY',
  WALLET: 'ONLINE_CLEARING',
  OTHER: 'CASH_CLEARING',
};

/**
 * Money in and money back out.
 *
 * ===========================================================================
 * ONE TRANSACTION, OR IT DID NOT HAPPEN
 * ===========================================================================
 *
 * Taking a payment touches four things:
 *
 *   1. the `payment` row
 *   2. possibly a gift-card balance and its append-only ledger
 *   3. two `ledger_entry` rows (double entry)
 *   4. the appointment's `paid_minor` and `payment_status` projection
 *
 * All four happen in ONE database transaction. Any split produces a failure
 * mode somebody has to reconcile by hand: a gift card debited against a payment
 * that rolled back is money the customer simply lost, and an appointment marked
 * PAID with no payment row is a service given away.
 *
 * The provider call sits OUTSIDE that transaction — see `create` — because
 * holding a database transaction open across a network round trip is how a
 * connection pool dies under load.
 *
 * ===========================================================================
 * IDEMPOTENCY
 * ===========================================================================
 *
 * `payment.idempotency_key` is GLOBALLY unique. A retried checkout finds the
 * existing row and returns it unchanged rather than charging twice. The check
 * happens twice on purpose: a fast path before doing any work, and the unique
 * constraint catching whatever the race between two concurrent retries let
 * through. A service-layer check alone is a lie under concurrency.
 *
 * ===========================================================================
 * THE APPOINTMENT PROJECTION IS DERIVED, NEVER ACCUMULATED
 * ===========================================================================
 *
 * `paid_minor` is recomputed as the SUM of succeeded payments, not incremented.
 * An increment is correct exactly until one write is lost or replayed, and then
 * it is wrong forever with nothing to compare against. A sum can be recomputed
 * from the payments table at any time and is self-healing.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly payments: PaymentRepository,
    private readonly providers: PaymentProviderRegistry,
    private readonly giftCards: GiftCardsService,
    private readonly events: NotificationEventService,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async list(query: PaymentQueryDto) {
    return this.payments.transaction(async (tx, companyId) => {
      const where = buildPaymentWhere(companyId, query);

      const [rows, total, totals] = await Promise.all([
        tx.payment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.offset,
          take: query.limit,
          include: paymentInclude,
        }),
        tx.payment.count({ where }),
        // The number the person looking at this screen actually wants, and it
        // is one aggregate rather than a sum over the page they can see.
        tx.payment.aggregate({
          where: { ...where, status: 'SUCCEEDED' },
          _sum: { amountMinor: true, refundedMinor: true },
        }),
      ]);

      return {
        items: rows.map(toPaymentResponse),
        total,
        limit: query.limit,
        offset: query.offset,
        summary: {
          collectedMinor: (totals._sum.amountMinor ?? 0n).toString(),
          refundedMinor: (totals._sum.refundedMinor ?? 0n).toString(),
          netMinor: ((totals._sum.amountMinor ?? 0n) - (totals._sum.refundedMinor ?? 0n)).toString(),
        },
      };
    });
  }

  async findById(paymentId: string) {
    return this.payments.transaction(async (tx, companyId) => {
      const payment = await tx.payment.findFirst({
        where: { id: paymentId, companyId },
        include: { ...paymentInclude, refunds: { orderBy: { createdAt: 'desc' } } },
      });
      if (!payment) throw new ResourceNotFoundError('Payment', paymentId);

      return {
        ...toPaymentResponse(payment),
        refunds: payment.refunds.map((refund) => ({
          id: refund.id,
          amountMinor: refund.amountMinor.toString(),
          status: refund.status,
          destination: refund.destination,
          reason: refund.reason,
          createdAt: refund.createdAt,
          processedAt: refund.processedAt,
        })),
      };
    });
  }

  /**
   * What is still owed on an appointment.
   *
   * The single most-asked question at a till, and it must be answered from the
   * payments table rather than from the appointment's cached `paid_minor` — the
   * cache is what this endpoint exists to double-check.
   */
  async appointmentBalance(appointmentId: string) {
    return this.payments.transaction(async (tx, companyId) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, companyId },
        select: {
          id: true,
          totalMinor: true,
          discountMinor: true,
          subtotalMinor: true,
          currencyCode: true,
          paymentStatus: true,
        },
      });
      if (!appointment) throw new ResourceNotFoundError('Appointment', appointmentId);

      const { paidMinor, refundedMinor } = await this.sumSettled(tx, companyId, appointmentId);
      const outstanding = appointment.totalMinor - (paidMinor - refundedMinor);

      return {
        appointmentId,
        currencyCode: appointment.currencyCode,
        subtotalMinor: appointment.subtotalMinor.toString(),
        discountMinor: appointment.discountMinor.toString(),
        totalMinor: appointment.totalMinor.toString(),
        paidMinor: paidMinor.toString(),
        refundedMinor: refundedMinor.toString(),
        // Clamped: an overpayment (a tip recorded against the booking) must not
        // show as a negative balance owed.
        outstandingMinor: (outstanding > 0n ? outstanding : 0n).toString(),
        isSettled: outstanding <= 0n,
        paymentStatus: appointment.paymentStatus,
      };
    });
  }

  /**
   * Take a payment.
   *
   * The provider is called BETWEEN two transactions rather than inside one:
   *
   *   1. tx: validate, resolve the idempotency key, reserve a payment number
   *   2. no tx: ask the provider (a network call for a real gateway)
   *   3. tx: write the payment, redeem the gift card, post the ledger, update
   *      the appointment
   *
   * Holding a database transaction open across step 2 is how a connection pool
   * dies the first time a gateway is slow. The cost is that a crash between 2
   * and 3 leaves a charge with no row — which is exactly what the idempotency
   * key makes recoverable: the retry finds the same provider outcome and
   * completes step 3.
   */
  async create(input: CreatePaymentDto) {
    const actor = this.actor();
    const idempotencyKey = input.idempotencyKey ?? null;

    // -- 1. Validate and check for a replay -----------------------------------
    const prepared = await this.payments.transaction(async (tx, companyId): Promise<Prepared> => {
      if (idempotencyKey) {
        const existing = await tx.payment.findFirst({
          where: { companyId, idempotencyKey },
          select: { id: true },
        });
        if (existing) {
          return {
            replayOf: existing.id,
            currencyCode: '',
            amountMinor: 0n,
            branchId: null,
            customerId: null,
            appointmentId: null,
          };
        }
      }

      const currencyCode = await this.resolveCurrency(tx, companyId, input.currencyCode);
      const amountMinor = BigInt(input.amountMinor);

      let appointment: { id: string; branchId: string; customerId: string; currencyCode: string } | null =
        null;

      if (input.appointmentId) {
        appointment = await tx.appointment.findFirst({
          where: { id: input.appointmentId, companyId },
          select: { id: true, branchId: true, customerId: true, currencyCode: true },
        });
        if (!appointment) throw new ResourceNotFoundError('Appointment', input.appointmentId);

        if (appointment.currencyCode !== currencyCode) {
          // No FX. Converting silently at an invented rate is worse than
          // refusing, and the appointment's own currency is the authority.
          throw new ValidationFailedError({
            currencyCode: `That appointment is priced in ${appointment.currencyCode}.`,
          });
        }
      }

      if (input.customerId) await this.assertCustomerExists(tx, companyId, input.customerId);
      if (input.branchId) await this.assertBranchExists(tx, companyId, input.branchId);

      return {
        replayOf: null,
        currencyCode,
        amountMinor,
        // Inherit from the appointment when the caller did not say, so a
        // payment is attributed to the right branch for the drawer count.
        branchId: input.branchId ?? appointment?.branchId ?? null,
        customerId: input.customerId ?? appointment?.customerId ?? null,
        appointmentId: appointment?.id ?? null,
      };
    });

    if (prepared.replayOf) {
      this.logger.log(`Replayed payment for idempotency key; returning the existing row.`);
      return this.findById(prepared.replayOf);
    }

    // -- 2. Ask the provider --------------------------------------------------
    // A gift card is not a charge: no money enters the business, a liability the
    // company already owes is drawn down instead. It is settled inside step 3.
    const chargeKey = idempotencyKey ?? randomUUID();
    const outcome =
      input.method === 'GIFT_CARD'
        ? { status: 'SUCCEEDED' as const, provider: 'gift-card', feeMinor: 0n }
        : await this.providers.forMethod(input.method).charge({
            amountMinor: prepared.amountMinor,
            currencyCode: prepared.currencyCode,
            method: input.method,
            idempotencyKey: chargeKey,
            reference: prepared.appointmentId ?? 'walk-in',
            metadata: input.metadata,
          });

    // -- 3. Write everything, atomically -------------------------------------
    const created = await this.payments.transaction(async (tx, companyId) => {
      const settled = outcome.status === 'SUCCEEDED';

      const feeMinor = outcome.feeMinor ?? 0n;

      /**
       * The payment row goes FIRST, before the gift-card redemption.
       *
       * Not an ordering preference — a hard constraint. `gift_card_transaction`
       * is append-only (a trigger in 001_hardening.sql refuses UPDATE for
       * everyone, superusers included), so a redemption row cannot have its
       * `payment_id` backfilled afterwards. The link has to be correct at
       * INSERT, which means the payment id must already exist.
       *
       * Atomicity is unaffected: an insufficient balance below aborts the whole
       * transaction, so the payment row written a moment ago disappears with
       * it. A test asserts that an overspend leaves no payment behind.
       */
      const payment = await this.insertPayment(tx, companyId, {
        input,
        prepared,
        outcome,
        feeMinor,
        idempotencyKey,
        actorId: actor.id,
      });

      if (input.method === 'GIFT_CARD' && settled) {
        await this.giftCards.redeemWithin(tx, companyId, {
          code: input.giftCardCode!,
          amountMinor: prepared.amountMinor,
          currencyCode: prepared.currencyCode,
          appointmentId: prepared.appointmentId,
          paymentId: payment.id,
          branchId: prepared.branchId,
          actor,
        });
      }

      if (settled) {
        await this.postLedger(tx, companyId, {
          paymentId: payment.id,
          method: input.method,
          amountMinor: prepared.amountMinor,
          feeMinor,
          currencyCode: prepared.currencyCode,
          description: `Payment ${payment.paymentNumber}`,
        });

        if (prepared.appointmentId) {
          await this.refreshAppointmentTotals(tx, companyId, prepared.appointmentId);
        }
      }

      return payment;
    });

    await this.audit.record({
      action: 'payment.created',
      resourceType: 'payment',
      resourceId: created.id,
      after: {
        paymentNumber: created.paymentNumber,
        method: created.method,
        purpose: created.purpose,
        status: created.status,
        amountMinor: created.amountMinor.toString(),
        currencyCode: created.currencyCode,
      },
    });

    if (created.status === 'SUCCEEDED') {
      // Outbox, in a separate call rather than inside the payment transaction:
      // see NotificationEventService for why that trade is made deliberately.
      await this.events.emit('payment.completed', {
        paymentId: created.id,
        appointmentId: created.appointmentId,
        customerId: created.customerId,
        amountMinor: created.amountMinor.toString(),
        currencyCode: created.currencyCode,
      });
    }

    return this.findById(created.id);
  }

  /**
   * Give money back.
   *
   * Refusals worth naming:
   *
   *   - more than is left on the payment. `payment_refund_within_amount` in
   *     001_hardening.sql would refuse it too, as a 500 nobody planned.
   *   - a payment that never settled. There is nothing to reverse; the right
   *     operation is a cancellation, and pretending otherwise creates a refund
   *     row for money that never arrived.
   *
   * `destination: GIFT_CARD` credits stored value instead of moving cash, which
   * is what a shop actually does weeks after a cash sale. It is also the only
   * destination that can reverse a GIFT_CARD payment — putting cash in
   * somebody's hand for a card they were given is a different transaction.
   */
  async refund(paymentId: string, input: RefundPaymentDto) {
    const actor = this.actor();

    const result = await this.payments.transaction(async (tx, companyId) => {
      // Lock the payment row: two refund clicks must not both see the same
      // remaining amount and both succeed.
      const locked = await this.lockPayment(tx, companyId, paymentId);

      if (locked.status !== 'SUCCEEDED') {
        throw new ValidationFailedError({
          paymentId: 'Only a settled payment can be refunded.',
        });
      }

      const remaining = locked.amountMinor - locked.refundedMinor;
      const amount = input.amountMinor ? BigInt(input.amountMinor) : remaining;

      if (amount <= 0n) {
        throw new ValidationFailedError({ amountMinor: 'A refund must be a positive amount.' });
      }
      if (amount > remaining) {
        throw new ValidationFailedError({
          amountMinor: `Only ${remaining.toString()} is still refundable on this payment.`,
        });
      }

      const destination =
        input.destination === 'ORIGINAL_METHOD' && locked.method === 'GIFT_CARD'
          ? 'GIFT_CARD'
          : input.destination;

      let issuedGiftCardId: string | null = null;
      if (destination === 'GIFT_CARD') {
        const original = await tx.giftCardTransaction.findFirst({
          where: { companyId, paymentId: locked.id, type: 'REDEEM' },
          select: { giftCardId: true },
        });
        if (!original) {
          throw new ValidationFailedError({
            destination:
              'This payment did not come from a gift card, so there is no card to credit.',
          });
        }
        await this.giftCards.refundWithin(tx, companyId, {
          giftCardId: original.giftCardId,
          amountMinor: amount,
          appointmentId: locked.appointmentId,
          paymentId: locked.id,
          reason: input.reason,
          actor,
        });
        issuedGiftCardId = original.giftCardId;
      }

      const refund = await tx.refund.create({
        data: {
          companyId,
          paymentId: locked.id,
          appointmentId: locked.appointmentId,
          amountMinor: amount,
          currencyCode: locked.currencyCode,
          destination,
          status: 'SUCCEEDED',
          reason: input.reason,
          issuedGiftCardId,
          requestedByType: actor.type,
          requestedById: actor.id,
          processedAt: new Date(),
        },
      });

      await tx.payment.updateMany({
        where: { id: locked.id, companyId },
        data: { refundedMinor: locked.refundedMinor + amount },
      });

      await this.postLedger(tx, companyId, {
        paymentId: locked.id,
        refundId: refund.id,
        method: locked.method,
        amountMinor: amount,
        feeMinor: 0n,
        currencyCode: locked.currencyCode,
        description: `Refund of ${locked.paymentNumber}`,
        reverse: true,
      });

      if (locked.appointmentId) {
        await this.refreshAppointmentTotals(tx, companyId, locked.appointmentId);
      }

      return { refund, payment: locked };
    });

    await this.audit.record({
      action: 'payment.refunded',
      resourceType: 'refund',
      resourceId: result.refund.id,
      after: {
        paymentId,
        amountMinor: result.refund.amountMinor.toString(),
        destination: result.refund.destination,
        reason: input.reason,
      },
    });

    return this.findById(paymentId);
  }

  // ---------------------------------------------------------------------------

  /**
   * Two rows, always balancing.
   *
   * Taking money debits a clearing account (an asset rises) and credits revenue
   * (income earned). A refund is the same two rows the other way round, against
   * REFUNDS rather than REVENUE so the gross and the reversals stay separately
   * reportable — netting them would make "we refunded 12% of takings last
   * month" unanswerable.
   *
   * A gateway fee is a third pair: the clearing account only receives the net,
   * and the commission is an expense. Skipping it makes revenue look like cash
   * and the two never reconcile.
   *
   * `ledger_single_sided` and the append-only trigger in 001_hardening.sql mean
   * a row with both sides, or an edit to a posted row, is refused by the
   * database rather than caught here.
   */
  private async postLedger(
    tx: TenantTx,
    companyId: string,
    entry: {
      paymentId: string;
      refundId?: string;
      method: PaymentMethod;
      amountMinor: bigint;
      feeMinor: bigint;
      currencyCode: string;
      description: string;
      reverse?: boolean;
    },
  ) {
    const journalId = randomUUID();
    const clearing = CLEARING_ACCOUNT[entry.method];
    const income: LedgerAccount = entry.reverse ? 'REFUNDS' : 'REVENUE';
    const refType = entry.reverse ? 'refund' : 'payment';
    const refId = entry.reverse ? (entry.refundId ?? entry.paymentId) : entry.paymentId;

    const rows: Prisma.LedgerEntryCreateManyInput[] = entry.reverse
      ? [
          { debitMinor: entry.amountMinor, creditMinor: 0n, account: income },
          { debitMinor: 0n, creditMinor: entry.amountMinor, account: clearing },
        ].map((side) => ({
          companyId,
          journalId,
          currencyCode: entry.currencyCode,
          refType,
          refId,
          paymentId: entry.paymentId,
          refundId: entry.refundId ?? null,
          description: entry.description,
          ...side,
        }))
      : [
          { debitMinor: entry.amountMinor - entry.feeMinor, creditMinor: 0n, account: clearing },
          { debitMinor: 0n, creditMinor: entry.amountMinor, account: income },
        ].map((side) => ({
          companyId,
          journalId,
          currencyCode: entry.currencyCode,
          refType,
          refId,
          paymentId: entry.paymentId,
          description: entry.description,
          ...side,
        }));

    if (!entry.reverse && entry.feeMinor > 0n) {
      rows.push({
        companyId,
        journalId,
        currencyCode: entry.currencyCode,
        refType,
        refId,
        paymentId: entry.paymentId,
        account: 'PROCESSING_FEES',
        debitMinor: entry.feeMinor,
        creditMinor: 0n,
        description: `${entry.description} — processing fee`,
      });
    }

    await tx.ledgerEntry.createMany({ data: rows });
  }

  /**
   * Recompute an appointment's money from the payments themselves.
   *
   * Derived, never incremented — an increment is correct until one write is
   * lost or replayed, and then it is wrong forever with nothing to compare
   * against. This is cheap (`(company_id, appointment_id)` is indexed) and it
   * is self-healing.
   */
  private async refreshAppointmentTotals(tx: TenantTx, companyId: string, appointmentId: string) {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, companyId },
      select: { totalMinor: true, status: true },
    });
    if (!appointment) return;

    const { paidMinor, refundedMinor } = await this.sumSettled(tx, companyId, appointmentId);
    const net = paidMinor - refundedMinor;

    await tx.appointment.updateMany({
      where: { id: appointmentId, companyId },
      data: {
        paidMinor,
        refundedMinor,
        paymentStatus: derivePaymentStatus(appointment.totalMinor, paidMinor, refundedMinor),
      },
    });

    void net;
  }

  private async sumSettled(tx: TenantTx, companyId: string, appointmentId: string) {
    const totals = await tx.payment.aggregate({
      where: { companyId, appointmentId, status: 'SUCCEEDED' },
      _sum: { amountMinor: true, refundedMinor: true },
    });

    return {
      paidMinor: totals._sum.amountMinor ?? 0n,
      refundedMinor: totals._sum.refundedMinor ?? 0n,
    };
  }

  /**
   * Insert with a generated payment number, retrying a collision.
   *
   * The number is `PAY-YYYYMMDD-XXXXXX` with a random suffix rather than a
   * per-company counter. A counter needs either a serialisable read or a lock
   * on every payment, and buys a property nobody has asked for — the numbers
   * only have to be unique, stable and readable down a phone.
   */
  private async insertPayment(
    tx: TenantTx,
    companyId: string,
    args: {
      input: CreatePaymentDto;
      prepared: {
        currencyCode: string;
        amountMinor: bigint;
        branchId: string | null;
        customerId: string | null;
        appointmentId: string | null;
      };
      outcome: {
        status: 'SUCCEEDED' | 'AUTHORIZED' | 'PENDING' | 'FAILED';
        provider: string;
        providerIntentId?: string;
        providerChargeId?: string;
        failureReason?: string;
      };
      feeMinor: bigint;
      idempotencyKey: string | null;
      actorId: string | null;
    },
  ) {
    const { input, prepared, outcome, feeMinor } = args;
    const now = new Date();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await tx.payment.create({
          data: {
            companyId,
            branchId: prepared.branchId,
            appointmentId: prepared.appointmentId,
            customerId: prepared.customerId,
            paymentNumber: generatePaymentNumber(),
            method: input.method,
            purpose: input.purpose,
            status: outcome.status as PaymentStatus,
            amountMinor: prepared.amountMinor,
            feeMinor,
            netMinor: prepared.amountMinor - feeMinor,
            currencyCode: prepared.currencyCode,
            provider: outcome.provider,
            providerIntentId: outcome.providerIntentId ?? null,
            providerChargeId: outcome.providerChargeId ?? null,
            idempotencyKey: args.idempotencyKey,
            receivedByCompanyUserId: args.actorId,
            failureReason: outcome.failureReason ?? null,
            metadata: input.note ? { note: input.note } : undefined,
            capturedAt: outcome.status === 'SUCCEEDED' ? now : null,
            authorizedAt:
              outcome.status === 'AUTHORIZED' || outcome.status === 'SUCCEEDED' ? now : null,
            failedAt: outcome.status === 'FAILED' ? now : null,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const target = JSON.stringify(error.meta?.target ?? '');
          if (target.includes('idempotency')) {
            // Another request with the same key won the race. Its row is the
            // one that counts.
            throw new ConflictError('That payment has already been recorded.', {
              field: 'idempotencyKey',
            });
          }
          // A payment-number collision. Try another.
          continue;
        }
        throw error;
      }
    }

    throw new ConflictError('Could not allocate a payment number. Try again.', {
      field: 'paymentNumber',
    });
  }

  private async lockPayment(tx: TenantTx, companyId: string, paymentId: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        payment_number: string;
        status: PaymentStatus;
        method: PaymentMethod;
        amount_minor: bigint;
        refunded_minor: bigint;
        currency_code: string;
        appointment_id: string | null;
        provider: string | null;
        provider_charge_id: string | null;
      }>
    >`
      SELECT id, payment_number, status, method, amount_minor, refunded_minor,
             currency_code, appointment_id, provider, provider_charge_id
        FROM payment
       WHERE id = ${paymentId}::uuid AND company_id = ${companyId}::uuid
       FOR UPDATE
    `;

    const row = rows[0];
    if (!row) throw new ResourceNotFoundError('Payment', paymentId);

    return {
      id: row.id,
      paymentNumber: row.payment_number,
      status: row.status,
      method: row.method,
      amountMinor: BigInt(row.amount_minor),
      refundedMinor: BigInt(row.refunded_minor),
      currencyCode: row.currency_code,
      appointmentId: row.appointment_id,
      provider: row.provider,
      providerChargeId: row.provider_charge_id,
    };
  }

  /** Who is taking the money, for the ledger and the audit trail. */
  private actor(): { type: ActorType; id: string | null } {
    const membership = this.context.tenantOrNull()?.membership;
    return { type: 'COMPANY_USER', id: membership?.companyUserId ?? null };
  }

  private async resolveCurrency(tx: TenantTx, companyId: string, requested?: string) {
    if (!requested) {
      const company = await tx.company.findFirstOrThrow({
        where: { id: companyId },
        select: { currencyCode: true },
      });
      return company.currencyCode;
    }
    const currency = await tx.currency.findUnique({ where: { code: requested } });
    if (!currency) throw new ValidationFailedError({ currencyCode: 'Unknown currency.' });
    return currency.code;
  }

  private async assertCustomerExists(tx: TenantTx, companyId: string, customerId: string) {
    const found = await tx.companyCustomer.findFirst({
      where: { id: customerId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!found) throw new ResourceNotFoundError('CompanyCustomer', customerId);
  }

  private async assertBranchExists(tx: TenantTx, companyId: string, branchId: string) {
    const found = await tx.branch.findFirst({
      where: { id: branchId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!found) throw new ResourceNotFoundError('Branch', branchId);
  }
}

/**
 * What the appointment's payment status should be, given the money.
 *
 * Derived from three numbers rather than set by whichever code path last
 * touched it — that is what stops "PAID" and a non-zero balance coexisting.
 */
export function derivePaymentStatus(
  totalMinor: bigint,
  paidMinor: bigint,
  refundedMinor: bigint,
): AppointmentPaymentStatus {
  const net = paidMinor - refundedMinor;

  if (paidMinor > 0n && net <= 0n) return 'REFUNDED';
  if (refundedMinor > 0n) return 'PARTIALLY_REFUNDED';
  if (net <= 0n) return 'UNPAID';
  if (net >= totalMinor) return 'PAID';
  return 'PARTIALLY_PAID';
}

function generatePaymentNumber(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Crockford-ish: no O/0/I/1 confusion when somebody reads it down a phone.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `PAY-${day}-${suffix}`;
}

function buildPaymentWhere(companyId: string, query: PaymentQueryDto): Prisma.PaymentWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (query.from) createdAt.gte = new Date(`${query.from}T00:00:00.000Z`);
  // Exclusive upper bound on the following day, so "to" includes its whole day
  // rather than only its midnight.
  if (query.to) {
    const to = new Date(`${query.to}T00:00:00.000Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    createdAt.lt = to;
  }

  return {
    companyId,
    ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to ? { createdAt } : {}),
    ...(query.search
      ? { paymentNumber: { contains: query.search.toUpperCase() } }
      : {}),
  };
}

const paymentInclude = {
  customer: { select: { id: true, firstName: true, lastName: true } },
  branch: { select: { id: true, name: true } },
  appointment: { select: { id: true, appointmentNumber: true } },
} satisfies Prisma.PaymentInclude;

type PaymentWithRelations = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

function toPaymentResponse(payment: PaymentWithRelations) {
  return {
    id: payment.id,
    paymentNumber: payment.paymentNumber,
    method: payment.method,
    purpose: payment.purpose,
    status: payment.status,
    // Money as strings throughout: the columns are BigInt.
    amountMinor: payment.amountMinor.toString(),
    feeMinor: payment.feeMinor.toString(),
    netMinor: payment.netMinor.toString(),
    refundedMinor: payment.refundedMinor.toString(),
    refundableMinor: (payment.amountMinor - payment.refundedMinor).toString(),
    currencyCode: payment.currencyCode,
    appointmentId: payment.appointmentId,
    appointmentNumber: payment.appointment?.appointmentNumber ?? null,
    customerId: payment.customerId,
    customerName: payment.customer
      ? [payment.customer.firstName, payment.customer.lastName].filter(Boolean).join(' ')
      : null,
    branchId: payment.branchId,
    branchName: payment.branch?.name ?? null,
    provider: payment.provider,
    /**
     * The gateway's own id, so a dispute can be traced from this screen to the
     * provider's dashboard. Deliberately exposed — it is a reference, not a
     * secret, and its absence is what makes reconciliation manual.
     */
    providerReference: payment.providerChargeId ?? payment.providerIntentId,
    failureReason: payment.failureReason,
    createdAt: payment.createdAt,
    capturedAt: payment.capturedAt,
  };
}
