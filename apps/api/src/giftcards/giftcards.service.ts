import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type ActorType,
  type GiftCardStatus,
  type GiftCardTransactionType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TokenHashService } from '../auth/token-hash.service';
import {
  ConflictError,
  GiftCardNotUsableError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../common/errors';
import { customerSearchClauses } from '../customers/customers.service';
import {
  NOTIFICATION_EVENTS,
  NotificationEventService,
} from '../notifications/notification-event.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import type {
  AdjustGiftCardDto,
  GiftCardQueryDto,
  GiftCardTransactionQueryDto,
  IssueGiftCardDto,
  RedeemGiftCardDto,
  RefundGiftCardDto,
  UpdateGiftCardDto,
} from './dto/giftcard.dto';

interface GiftCardRow {
  id: string;
  companyId: string;
  codeLast4: string;
  currentBalanceMinor: bigint;
}

@Injectable()
export class GiftCardRepository extends TenantScopedRepository<GiftCardRow> {
  protected readonly modelName = 'GiftCard';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<GiftCardRow> {
    return tx.giftCard;
  }
}

/** Unambiguous alphabet: no O/0, no I/1/L. Codes get read aloud down a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 4;
const CODE_GROUP_LENGTH = 4;

type Actor = { type: ActorType; id: string | null };
type Problem = { code: string; message: string };

const customerSelect = { select: { id: true, firstName: true, lastName: true } } as const;

/**
 * Stored value.
 *
 * ===========================================================================
 * A GIFT CARD IS A LIABILITY, NOT A DISCOUNT
 * ===========================================================================
 *
 * The company already took the money. What is left is a debt owed to whoever
 * holds the card. That single fact decides everything here:
 *
 *   - The ledger is APPEND-ONLY and is the truth. `current_balance_minor` is a
 *     cached projection of it, and `001_hardening.sql` puts a trigger on the
 *     transaction table so nothing — not this service, not a superuser running
 *     an ad-hoc UPDATE — can rewrite history. EVERY balance change in this file
 *     writes its ledger row in the same transaction as the projection.
 *
 *   - Every transaction row carries `balance_after_minor`. That makes the
 *     ledger SELF-CHECKING: replaying it and disagreeing with the projection is
 *     a detected corruption rather than a silent one, and `verifyLedger` below
 *     is the check.
 *
 *   - Overdraw is structurally impossible. `CHECK (current_balance_minor >= 0)`
 *     means the worst case of a bug in this file is a failed transaction, not a
 *     card that owes the customer money.
 *
 * ===========================================================================
 * STATUS
 * ===========================================================================
 *
 *   ACTIVE    spendable.
 *   EXPIRED   derived, never stored: an ACTIVE card past `expires_at`.
 *   DISABLED  blocked, balance kept, reversible. Lost card, dispute, fraud check.
 *   DEPLETED  spent to zero. Spendable again if a refund puts value back.
 *   VOID      terminal. The balance was written off with a VOID ledger row.
 *
 * ===========================================================================
 * CONCURRENCY
 * ===========================================================================
 *
 * Two tills redeeming the same card at the same moment is the case that has to
 * be right. Read-then-write would let both see 5000 and both take 4000.
 *
 * The card row is locked with `SELECT … FOR UPDATE` before the balance is read,
 * so the second transaction blocks until the first commits and then sees the
 * true balance. The CHECK constraint is the backstop if that lock is ever
 * dropped by a refactor: the write fails rather than the balance going
 * negative. Idempotency keys are checked AFTER the lock, so a retried request
 * racing its own original sees the original's row.
 *
 * ===========================================================================
 * CODES
 * ===========================================================================
 *
 * Only an HMAC of the code is stored, and the index on it is GLOBAL rather than
 * per-company — so codes are unique within every company (and across them),
 * and a redemption lookup cannot even collide with another tenant's card before
 * the `company_id` predicate applies. The plaintext is returned exactly once,
 * at issue, and never logged. Searching by code therefore means an exact match
 * on its hash.
 */
@Injectable()
export class GiftCardsService {
  private readonly logger = new Logger(GiftCardsService.name);

  constructor(
    private readonly cards: GiftCardRepository,
    private readonly hasher: TokenHashService,
    private readonly audit: AuditService,
    private readonly context: RequestContextService,
    private readonly events: NotificationEventService,
  ) {}

  async list(query: GiftCardQueryDto) {
    return this.cards.transaction(async (tx, companyId) => {
      const and: Prisma.GiftCardWhereInput[] = [];
      const status = statusFilter(query.status);
      if (status) and.push(status);
      if (query.search) and.push({ OR: this.searchClauses(query.search) });

      const where: Prisma.GiftCardWhereInput = {
        companyId,
        ...(query.issuedToCustomerId ? { issuedToCustomerId: query.issuedToCustomerId } : {}),
        // The last four characters are what a member of staff can read off a
        // card somebody is holding.
        ...(query.last4 ? { codeLast4: query.last4.toUpperCase() } : {}),
        ...(and.length ? { AND: and } : {}),
      };

      const [rows, total] = await Promise.all([
        tx.giftCard.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: query.offset,
          take: query.limit,
          include: { issuedTo: customerSelect, purchasedBy: customerSelect },
        }),
        tx.giftCard.count({ where }),
      ]);

      return {
        items: rows.map(toGiftCardResponse),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async findById(giftCardId: string) {
    return this.cards.transaction(async (tx, companyId) => {
      const card = await tx.giftCard.findFirst({
        where: { id: giftCardId, companyId },
        include: { issuedTo: customerSelect, purchasedBy: customerSelect },
      });
      if (!card) throw new ResourceNotFoundError('GiftCard', giftCardId);
      return toGiftCardResponse(card);
    });
  }

  /** The balance and whether it can be spent right now — what a till needs. */
  async balance(giftCardId: string) {
    return this.cards.transaction(async (tx, companyId) => {
      const card = await tx.giftCard.findFirst({ where: { id: giftCardId, companyId } });
      if (!card) throw new ResourceNotFoundError('GiftCard', giftCardId);
      const problem = redeemabilityProblem(card);
      return {
        giftCardId: card.id,
        last4: card.codeLast4,
        status: effectiveStatus(card),
        initialBalanceMinor: card.initialBalanceMinor.toString(),
        currentBalanceMinor: card.currentBalanceMinor.toString(),
        currencyCode: card.currencyCode,
        expiresAt: card.expiresAt,
        isRedeemable: problem === null,
        problem: problem?.message ?? null,
        problemCode: problem?.code ?? null,
      };
    });
  }

  /**
   * The append-only ledger, newest first. This is the audit trail customers
   * ask for.
   *
   * REDEEM rows carry how much of them has been given back and how much still
   * can be, so the screen offering a refund offers exactly what the server will
   * accept.
   */
  async listTransactions(giftCardId: string, query: GiftCardTransactionQueryDto) {
    return this.cards.transaction(async (tx, companyId) => {
      const card = await tx.giftCard.findFirst({
        where: { id: giftCardId, companyId },
        select: { id: true },
      });
      if (!card) throw new ResourceNotFoundError('GiftCard', giftCardId);

      const where = { companyId, giftCardId };
      const [rows, total] = await Promise.all([
        tx.giftCardTransaction.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: query.offset,
          take: query.limit,
        }),
        tx.giftCardTransaction.count({ where }),
      ]);

      const redemptionIds = rows.filter((r) => r.type === 'REDEEM').map((r) => r.id);
      const refunded = new Map<string, bigint>();
      if (redemptionIds.length > 0) {
        const sums = await tx.giftCardTransaction.groupBy({
          by: ['reversesTransactionId'],
          where: { companyId, reversesTransactionId: { in: redemptionIds } },
          _sum: { amountMinor: true },
        });
        for (const sum of sums) {
          if (sum.reversesTransactionId) {
            refunded.set(sum.reversesTransactionId, sum._sum.amountMinor ?? 0n);
          }
        }
      }

      return {
        items: rows.map((row) => {
          const isRedeem = row.type === 'REDEEM';
          const given = refunded.get(row.id) ?? 0n;
          return {
            id: row.id,
            type: row.type,
            amountMinor: row.amountMinor.toString(),
            balanceAfterMinor: row.balanceAfterMinor.toString(),
            currencyCode: row.currencyCode,
            appointmentId: row.appointmentId,
            paymentId: row.paymentId,
            reversesTransactionId: row.reversesTransactionId,
            reason: row.reason,
            performedByType: row.performedByType,
            occurredAt: row.occurredAt,
            // A redemption made by a payment is given back by refunding that
            // payment, never here — two refund paths would pay out twice.
            refundedMinor: isRedeem ? given.toString() : null,
            refundableMinor: isRedeem
              ? (row.paymentId ? 0n : -row.amountMinor - given).toString()
              : null,
          };
        }),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  /**
   * Issue a card and return its code exactly once.
   *
   * The plaintext is in the response and nowhere else — not in the row, not in
   * the audit metadata, not in a log line. Losing it means voiding the card and
   * issuing another, which is the correct trade: a code recoverable from the
   * database is a code an attacker with read access can spend.
   */
  async issue(input: IssueGiftCardDto) {
    const code = generateCode();
    const codeHash = this.hasher.hash(code);
    const actor = this.actor();

    const created = await this.cards.transaction(async (tx, companyId) => {
      const currencyCode = await this.resolveCurrency(tx, companyId, input.currencyCode);
      if (input.issuedToCustomerId) {
        await this.assertCustomerExists(tx, companyId, input.issuedToCustomerId);
      }
      if (input.purchasedByCustomerId) {
        await this.assertCustomerExists(tx, companyId, input.purchasedByCustomerId);
      }
      if (input.branchId) await this.assertBranchExists(tx, companyId, input.branchId);

      const amount = BigInt(input.initialBalanceMinor);
      const now = new Date();

      const card = await tx.giftCard.create({
        data: {
          companyId,
          codeHash,
          codeLast4: code.slice(-4),
          status: 'ACTIVE',
          initialBalanceMinor: amount,
          currentBalanceMinor: amount,
          currencyCode,
          issuedToCustomerId: input.issuedToCustomerId ?? null,
          purchasedByCustomerId: input.purchasedByCustomerId ?? null,
          branchId: input.branchId ?? null,
          recipientName: input.recipientName ?? null,
          recipientEmail: input.recipientEmail ?? null,
          message: input.message ?? null,
          issuedAt: now,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
        include: { issuedTo: customerSelect, purchasedBy: customerSelect },
      });

      // The opening balance is a ledger row like any other, so a replay starts
      // from zero and reaches the projection with no special case.
      await this.appendTransaction(tx, companyId, {
        giftCardId: card.id,
        type: 'ISSUE',
        amountMinor: amount,
        balanceAfterMinor: amount,
        currencyCode,
        actor,
      });

      // Only a card with an owner has anybody to tell. The message never
      // carries the code.
      if (card.issuedToCustomerId) {
        await this.events.emitWithin(tx, companyId, NOTIFICATION_EVENTS.GIFT_CARD_ISSUED, {
          giftCardId: card.id,
        });
      }

      return card;
    });

    await this.audit.record({
      action: 'gift_card.issued',
      resourceType: 'gift_card',
      resourceId: created.id,
      // The code is absent on purpose. `last4` identifies the card in a support
      // conversation without being spendable.
      after: {
        last4: created.codeLast4,
        initialBalanceMinor: created.initialBalanceMinor.toString(),
        currencyCode: created.currencyCode,
        issuedToCustomerId: created.issuedToCustomerId,
      },
    });

    return { ...toGiftCardResponse(created), code };
  }

  /**
   * Change what may change after issue: owner, expiry, recipient details.
   *
   * Never the balance or the currency — the DTO refuses them. A voided card is
   * closed; editing it would suggest otherwise.
   */
  async update(giftCardId: string, input: UpdateGiftCardDto) {
    const { before, after } = await this.cards.transaction(async (tx, companyId) => {
      const card = await tx.giftCard.findFirst({ where: { id: giftCardId, companyId } });
      if (!card) throw new ResourceNotFoundError('GiftCard', giftCardId);
      if (card.status === 'VOID') {
        throw new ConflictError('A voided card cannot be changed.', { field: 'status' });
      }
      if (input.issuedToCustomerId) {
        await this.assertCustomerExists(tx, companyId, input.issuedToCustomerId);
      }

      const data: Prisma.GiftCardUncheckedUpdateManyInput = {};
      if (input.issuedToCustomerId !== undefined)
        data.issuedToCustomerId = input.issuedToCustomerId;
      if (input.expiresAt !== undefined) {
        data.expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
      }
      if (input.recipientName !== undefined) data.recipientName = input.recipientName || null;
      if (input.recipientEmail !== undefined) data.recipientEmail = input.recipientEmail || null;
      if (input.message !== undefined) data.message = input.message || null;

      await tx.giftCard.updateMany({ where: { id: card.id, companyId }, data });

      // Assigned to somebody new: tell them it is theirs.
      if (data.issuedToCustomerId && data.issuedToCustomerId !== card.issuedToCustomerId) {
        await this.events.emitWithin(tx, companyId, NOTIFICATION_EVENTS.GIFT_CARD_ASSIGNED, {
          giftCardId: card.id,
        });
      }

      return {
        before: {
          issuedToCustomerId: card.issuedToCustomerId,
          expiresAt: card.expiresAt,
          recipientName: card.recipientName,
        },
        after: {
          issuedToCustomerId: data.issuedToCustomerId ?? card.issuedToCustomerId,
          expiresAt: data.expiresAt !== undefined ? data.expiresAt : card.expiresAt,
          recipientName: data.recipientName !== undefined ? data.recipientName : card.recipientName,
        },
      };
    });

    await this.audit.record({
      action: 'gift_card.updated',
      resourceType: 'gift_card',
      resourceId: giftCardId,
      before,
      after,
    });

    return this.findById(giftCardId);
  }

  /**
   * Stop a card being used, keeping its balance.
   *
   * Not a ledger event — no money moves — so it is recorded on the card and in
   * the audit log. Reversible with `enable`, unlike `void`.
   */
  async disable(giftCardId: string, reason: string) {
    await this.cards.transaction(async (tx, companyId) => {
      const locked = await this.lockCard(tx, companyId, giftCardId);
      if (locked.status === 'VOID') {
        throw new ConflictError('That card has been voided.', { field: 'status' });
      }
      if (locked.status === 'DISABLED') {
        throw new ConflictError('That card is already disabled.', { field: 'status' });
      }
      await tx.giftCard.updateMany({
        where: { id: locked.id, companyId },
        data: { status: 'DISABLED', disabledAt: new Date(), disabledReason: reason },
      });
    });

    await this.audit.record({
      action: 'gift_card.disabled',
      resourceType: 'gift_card',
      resourceId: giftCardId,
      after: { reason },
    });

    return this.findById(giftCardId);
  }

  /** Undo `disable`. The card goes back to ACTIVE, or DEPLETED if it holds nothing. */
  async enable(giftCardId: string) {
    await this.cards.transaction(async (tx, companyId) => {
      const locked = await this.lockCard(tx, companyId, giftCardId);
      if (locked.status !== 'DISABLED') {
        throw new ConflictError('Only a disabled card can be re-enabled.', { field: 'status' });
      }
      await tx.giftCard.updateMany({
        where: { id: locked.id, companyId },
        data: {
          status: locked.currentBalanceMinor === 0n ? 'DEPLETED' : 'ACTIVE',
          disabledAt: null,
          disabledReason: null,
        },
      });
    });

    await this.audit.record({
      action: 'gift_card.enabled',
      resourceType: 'gift_card',
      resourceId: giftCardId,
    });

    return this.findById(giftCardId);
  }

  /**
   * Look a card up by the code somebody typed, without spending it.
   *
   * Used by the till before taking a payment. Returns the same 404 whether the
   * code is wrong or belongs to another company — a lookup that distinguished
   * those would be an oracle for guessing codes.
   */
  async lookup(code: string) {
    return this.cards.transaction(async (tx, companyId) => {
      const card = await this.findByCode(tx, companyId, code);
      if (!card) throw new ResourceNotFoundError('GiftCard', 'code');
      const problem = redeemabilityProblem(card);

      return {
        id: card.id,
        last4: card.codeLast4,
        status: effectiveStatus(card),
        currentBalanceMinor: card.currentBalanceMinor.toString(),
        currencyCode: card.currencyCode,
        expiresAt: card.expiresAt,
        branchId: card.branchId,
        isRedeemable: problem === null,
        problem: problem?.message ?? null,
      };
    });
  }

  /**
   * Spend part of a card, recorded directly rather than through a payment.
   *
   * Its own transaction around `redeemWithin`, so the rules are exactly the
   * ones a payment redemption obeys.
   */
  async redeem(giftCardId: string, input: RedeemGiftCardDto) {
    const actor = this.actor();
    const result = await this.cards.transaction((tx, companyId) =>
      this.redeemWithin(tx, companyId, {
        giftCardId,
        amountMinor: BigInt(input.amountMinor),
        appointmentId: input.appointmentId ?? null,
        branchId: input.branchId ?? null,
        reason: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        actor,
      }),
    );

    if (!result.replayed) {
      await this.audit.record({
        action: 'gift_card.redeemed',
        resourceType: 'gift_card',
        resourceId: result.giftCardId,
        after: {
          amountMinor: input.amountMinor,
          balanceAfterMinor: result.balanceAfterMinor.toString(),
          appointmentId: input.appointmentId ?? null,
          transactionId: result.transactionId,
        },
      });
    }

    return {
      transactionId: result.transactionId,
      replayed: result.replayed,
      card: await this.findById(result.giftCardId),
    };
  }

  /**
   * Draw down a card, inside the CALLER's transaction.
   *
   * Takes a `tx` rather than opening its own: when a redemption is one leg of a
   * payment, the two must commit together. A gift card debited against a
   * payment that then failed is money the customer lost.
   *
   * @throws GiftCardNotUsableError when the card cannot be used, or the amount
   *         exceeds the balance. Never partially redeems — the caller decides
   *         how to split a bill across tenders, not this method.
   */
  async redeemWithin(
    tx: TenantTx,
    companyId: string,
    options: {
      code?: string;
      giftCardId?: string;
      amountMinor: bigint;
      /** When given, must match the card. Otherwise the appointment's currency, if any. */
      currencyCode?: string;
      appointmentId?: string | null;
      paymentId?: string | null;
      branchId?: string | null;
      reason?: string | null;
      idempotencyKey?: string | null;
      actor: Actor;
    },
  ): Promise<{
    giftCardId: string;
    transactionId: string;
    balanceAfterMinor: bigint;
    replayed: boolean;
  }> {
    if (options.amountMinor <= 0n) {
      throw new ValidationFailedError({ amountMinor: 'A redemption must be a positive amount.' });
    }

    const found = options.code
      ? await this.findByCode(tx, companyId, options.code)
      : await tx.giftCard.findFirst({
          where: { id: options.giftCardId, companyId },
          select: { id: true },
        });
    if (!found) throw new ResourceNotFoundError('GiftCard', options.giftCardId ?? 'code');

    // THE LOCK. Everything below reads a balance and writes a smaller one, so
    // without this two tills both see the old value. `FOR UPDATE` makes the
    // second one wait for the first to commit.
    const locked = await this.lockCard(tx, companyId, found.id);

    // After the lock: a retry racing its original now sees the committed row.
    if (options.idempotencyKey) {
      const replay = await this.replay(tx, companyId, options.idempotencyKey, {
        giftCardId: locked.id,
        type: 'REDEEM',
        amountMinor: -options.amountMinor,
      });
      if (replay) return { ...replay, replayed: true };
    }

    const problem = redeemabilityProblem(locked);
    if (problem) throw new GiftCardNotUsableError(problem);

    let currencyCode = options.currencyCode ?? null;
    let branchId = options.branchId ?? null;

    if (options.appointmentId) {
      const appointment = await tx.appointment.findFirst({
        where: { id: options.appointmentId, companyId },
        select: { customerId: true, currencyCode: true, branchId: true },
      });
      if (!appointment) throw new ResourceNotFoundError('Appointment', options.appointmentId);

      // A card with an owner is theirs. Spending it on somebody else's booking
      // needs the card detached first — a deliberate step, and an audited one.
      if (locked.issuedToCustomerId && appointment.customerId !== locked.issuedToCustomerId) {
        throw new GiftCardNotUsableError({
          code: 'WRONG_CUSTOMER',
          message: 'That card belongs to a different customer.',
        });
      }
      currencyCode ??= appointment.currencyCode;
      branchId ??= appointment.branchId;
    }

    if (currencyCode && locked.currencyCode !== currencyCode) {
      // No FX in this system. Converting silently at an invented rate is worse
      // than refusing.
      throw new GiftCardNotUsableError({
        code: 'CURRENCY_MISMATCH',
        message: `That card holds ${locked.currencyCode}, not ${currencyCode}.`,
      });
    }

    if (branchId && locked.branchId && locked.branchId !== branchId) {
      throw new GiftCardNotUsableError({
        code: 'WRONG_BRANCH',
        message: 'That card is only valid at another branch.',
      });
    }

    if (locked.currentBalanceMinor < options.amountMinor) {
      throw new GiftCardNotUsableError({
        code: 'INSUFFICIENT_BALANCE',
        message:
          `That card holds ${locked.currentBalanceMinor.toString()} and the redemption is ` +
          `${options.amountMinor.toString()}. Take the remainder another way.`,
      });
    }

    const balanceAfter = locked.currentBalanceMinor - options.amountMinor;

    await tx.giftCard.updateMany({
      where: { id: locked.id, companyId },
      data: {
        currentBalanceMinor: balanceAfter,
        ...(balanceAfter === 0n ? { status: 'DEPLETED', depletedAt: new Date() } : {}),
      },
    });

    const transactionId = await this.appendTransaction(tx, companyId, {
      giftCardId: locked.id,
      type: 'REDEEM',
      // Signed negative — the CHECK constraint enforces the sign per type, so a
      // positive REDEEM cannot be written even by mistake.
      amountMinor: -options.amountMinor,
      balanceAfterMinor: balanceAfter,
      currencyCode: locked.currencyCode,
      appointmentId: options.appointmentId ?? null,
      paymentId: options.paymentId ?? null,
      reason: options.reason ?? null,
      idempotencyKey: options.idempotencyKey ?? null,
      actor: options.actor,
    });

    return {
      giftCardId: locked.id,
      transactionId,
      balanceAfterMinor: balanceAfter,
      replayed: false,
    };
  }

  /**
   * Give back all or part of one manual redemption.
   *
   * Capped at what that redemption took, less what has already been given back
   * — so no sequence of refunds can create value. A redemption made by a
   * payment is refused here: it is refunded by refunding the payment, and two
   * paths would pay out twice.
   */
  async refund(giftCardId: string, input: RefundGiftCardDto) {
    const actor = this.actor();

    const result = await this.cards.transaction(async (tx, companyId) => {
      const locked = await this.lockCard(tx, companyId, giftCardId);

      // Before anything is recomputed: on a retry the "remaining" amount has
      // already dropped, so the match is on what the refund reversed.
      if (input.idempotencyKey) {
        const earlier = await tx.giftCardTransaction.findFirst({
          where: { companyId, idempotencyKey: input.idempotencyKey },
        });
        if (earlier) {
          const same =
            earlier.giftCardId === locked.id &&
            earlier.type === 'REFUND' &&
            earlier.reversesTransactionId === input.transactionId &&
            (!input.amountMinor || earlier.amountMinor === BigInt(input.amountMinor));
          if (!same) {
            throw new ConflictError(
              'That idempotency key was already used for a different request.',
              { field: 'idempotencyKey' },
            );
          }
          return {
            giftCardId: earlier.giftCardId,
            transactionId: earlier.id,
            balanceAfterMinor: earlier.balanceAfterMinor,
            replayed: true,
          };
        }
      }

      const redemption = await tx.giftCardTransaction.findFirst({
        where: { id: input.transactionId, companyId, giftCardId: locked.id, type: 'REDEEM' },
      });
      if (!redemption) throw new ResourceNotFoundError('GiftCardTransaction', input.transactionId);

      const refundedSoFar = await tx.giftCardTransaction.aggregate({
        where: { companyId, reversesTransactionId: redemption.id },
        _sum: { amountMinor: true },
      });
      const remaining = -redemption.amountMinor - (refundedSoFar._sum.amountMinor ?? 0n);
      const amount = input.amountMinor ? BigInt(input.amountMinor) : remaining;

      if (locked.status === 'VOID') {
        throw new GiftCardNotUsableError({
          code: 'VOID',
          message: 'That card has been voided and cannot take value back.',
        });
      }
      if (redemption.paymentId) {
        throw new GiftCardNotUsableError({
          code: 'REDEEMED_BY_PAYMENT',
          message: 'That redemption was part of a payment. Refund the payment instead.',
        });
      }
      if (remaining <= 0n) {
        throw new GiftCardNotUsableError({
          code: 'ALREADY_REFUNDED',
          message: 'That redemption has already been given back in full.',
        });
      }
      if (amount > remaining) {
        throw new GiftCardNotUsableError({
          code: 'REFUND_EXCEEDS_REDEMPTION',
          message: `Only ${remaining.toString()} of that redemption can still be given back.`,
        });
      }

      const balanceAfter = locked.currentBalanceMinor + amount;
      if (balanceAfter > locked.initialBalanceMinor) {
        // Unreachable while refunds are capped by redemptions, and the CHECK
        // constraint would refuse it anyway; this turns it into a sentence.
        throw new GiftCardNotUsableError({
          code: 'ABOVE_INITIAL_BALANCE',
          message: 'A refund cannot take a card above the value it was issued with.',
        });
      }

      await tx.giftCard.updateMany({
        where: { id: locked.id, companyId },
        data: {
          currentBalanceMinor: balanceAfter,
          ...(locked.status === 'DEPLETED' ? { status: 'ACTIVE', depletedAt: null } : {}),
        },
      });

      const transactionId = await this.appendTransaction(tx, companyId, {
        giftCardId: locked.id,
        type: 'REFUND',
        amountMinor: amount,
        balanceAfterMinor: balanceAfter,
        currencyCode: locked.currencyCode,
        appointmentId: redemption.appointmentId,
        reversesTransactionId: redemption.id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey ?? null,
        actor,
      });

      return {
        giftCardId: locked.id,
        transactionId,
        balanceAfterMinor: balanceAfter,
        replayed: false,
      };
    });

    if (!result.replayed) {
      await this.audit.record({
        action: 'gift_card.refunded',
        resourceType: 'gift_card',
        resourceId: giftCardId,
        after: {
          reversesTransactionId: input.transactionId,
          balanceAfterMinor: result.balanceAfterMinor.toString(),
          reason: input.reason,
        },
      });
    }

    return {
      transactionId: result.transactionId,
      replayed: result.replayed,
      card: await this.findById(giftCardId),
    };
  }

  /** Put value back on a card for a refunded payment, inside the caller's transaction. */
  async refundWithin(
    tx: TenantTx,
    companyId: string,
    options: {
      giftCardId: string;
      amountMinor: bigint;
      appointmentId?: string | null;
      paymentId?: string | null;
      reason: string;
      actor: Actor;
    },
  ): Promise<bigint> {
    if (options.amountMinor <= 0n) {
      throw new ValidationFailedError({ amountMinor: 'A refund must be a positive amount.' });
    }

    const locked = await this.lockCard(tx, companyId, options.giftCardId);
    if (locked.status === 'VOID') {
      throw new GiftCardNotUsableError({
        code: 'VOID',
        message: 'That card has been voided and cannot take value back. Refund another way.',
      });
    }

    const balanceAfter = locked.currentBalanceMinor + options.amountMinor;

    if (balanceAfter > locked.initialBalanceMinor) {
      // `gift_card_balance_within_initial` in 001_hardening.sql would refuse
      // this anyway; saying it here gives a message instead of a constraint
      // name. Relaxing the rule is a documented decision, not a code change.
      throw new ValidationFailedError({
        amountMinor: 'A refund cannot take a card above the value it was issued with.',
      });
    }

    await tx.giftCard.updateMany({
      where: { id: locked.id, companyId },
      data: {
        currentBalanceMinor: balanceAfter,
        // A depleted card that gets value back is spendable again. A disabled
        // one stays disabled — getting money back is not a reason to unblock.
        ...(locked.status === 'DEPLETED' ? { status: 'ACTIVE', depletedAt: null } : {}),
      },
    });

    await this.appendTransaction(tx, companyId, {
      giftCardId: locked.id,
      type: 'REFUND',
      amountMinor: options.amountMinor,
      balanceAfterMinor: balanceAfter,
      currencyCode: locked.currencyCode,
      appointmentId: options.appointmentId ?? null,
      paymentId: options.paymentId ?? null,
      reason: options.reason,
      actor: options.actor,
    });

    return balanceAfter;
  }

  /**
   * A manual correction, which is the operation that needs a reason most.
   *
   * `giftcard:adjust` is a separate permission from `giftcard:issue` because
   * this one can write money onto a card without anybody paying for it. The
   * database refuses an ADJUSTMENT with no reason.
   */
  async adjust(giftCardId: string, input: AdjustGiftCardDto) {
    const actor = this.actor();

    const result = await this.cards.transaction(async (tx, companyId) => {
      const locked = await this.lockCard(tx, companyId, giftCardId);
      const delta = BigInt(input.amountMinor);

      if (delta === 0n) {
        throw new ValidationFailedError({ amountMinor: 'An adjustment of zero does nothing.' });
      }
      if (locked.status === 'VOID') {
        // Otherwise an adjustment would bring a written-off card back to life.
        throw new ConflictError('A voided card cannot be adjusted.', { field: 'status' });
      }

      const balanceAfter = locked.currentBalanceMinor + delta;
      if (balanceAfter < 0n) {
        throw new ValidationFailedError({
          amountMinor: 'That adjustment would take the card below zero.',
        });
      }
      if (balanceAfter > locked.initialBalanceMinor) {
        throw new ValidationFailedError({
          amountMinor: 'That adjustment would take the card above the value it was issued with.',
        });
      }

      await tx.giftCard.updateMany({
        where: { id: locked.id, companyId },
        data: {
          currentBalanceMinor: balanceAfter,
          // Only moves between ACTIVE and DEPLETED. A disabled card stays
          // disabled; a correction is not a reason to unblock it.
          ...(locked.status === 'ACTIVE' || locked.status === 'DEPLETED'
            ? {
                status: balanceAfter === 0n ? 'DEPLETED' : 'ACTIVE',
                depletedAt: balanceAfter === 0n ? new Date() : null,
              }
            : {}),
        },
      });

      await this.appendTransaction(tx, companyId, {
        giftCardId: locked.id,
        type: 'ADJUSTMENT',
        amountMinor: delta,
        balanceAfterMinor: balanceAfter,
        currencyCode: locked.currencyCode,
        reason: input.reason,
        actor,
      });

      return { balanceAfter, last4: locked.codeLast4 };
    });

    await this.audit.record({
      action: 'gift_card.adjusted',
      resourceType: 'gift_card',
      resourceId: giftCardId,
      after: {
        last4: result.last4,
        amountMinor: input.amountMinor,
        balanceAfterMinor: result.balanceAfter.toString(),
        reason: input.reason,
      },
    });

    return this.findById(giftCardId);
  }

  /**
   * Kill a card for good — issued in error, or refunded as cash.
   *
   * The remaining balance is written off as a VOID transaction rather than
   * silently zeroed, so the liability leaving the books has a row explaining
   * itself. To stop a card temporarily, `disable` it instead.
   */
  async void(giftCardId: string, reason: string) {
    const actor = this.actor();

    await this.cards.transaction(async (tx, companyId) => {
      const locked = await this.lockCard(tx, companyId, giftCardId);
      if (locked.status === 'VOID') {
        throw new ConflictError('That card has already been voided.', { field: 'status' });
      }

      if (locked.currentBalanceMinor > 0n) {
        await this.appendTransaction(tx, companyId, {
          giftCardId: locked.id,
          type: 'VOID',
          amountMinor: -locked.currentBalanceMinor,
          balanceAfterMinor: 0n,
          currencyCode: locked.currencyCode,
          reason,
          actor,
        });
      }

      await tx.giftCard.updateMany({
        where: { id: locked.id, companyId },
        data: { currentBalanceMinor: 0n, status: 'VOID' },
      });
    });

    await this.audit.record({
      action: 'gift_card.voided',
      resourceType: 'gift_card',
      resourceId: giftCardId,
      after: { reason },
    });
  }

  /**
   * Replay the ledger and compare it with the projection.
   *
   * This is what `balance_after_minor` on every row is for. It is exposed as an
   * endpoint rather than kept as a script because the first time somebody
   * suspects a gift-card bug, the useful answer is "the ledger agrees" or "it
   * diverges at this row" — not a shrug.
   */
  async verifyLedger(giftCardId: string) {
    return this.cards.transaction(async (tx, companyId) => {
      const card = await tx.giftCard.findFirst({ where: { id: giftCardId, companyId } });
      if (!card) throw new ResourceNotFoundError('GiftCard', giftCardId);

      const rows = await tx.giftCardTransaction.findMany({
        where: { companyId, giftCardId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });

      let running = 0n;
      let divergedAt: string | null = null;

      for (const row of rows) {
        running += row.amountMinor;
        if (running !== row.balanceAfterMinor && divergedAt === null) {
          divergedAt = row.id;
        }
      }

      const consistent = divergedAt === null && running === card.currentBalanceMinor;
      if (!consistent) {
        this.logger.error(
          `Gift card ${giftCardId} ledger disagrees with its balance ` +
            `(replay ${running.toString()} vs stored ${card.currentBalanceMinor.toString()})`,
        );
      }

      return {
        giftCardId,
        consistent,
        replayedBalanceMinor: running.toString(),
        storedBalanceMinor: card.currentBalanceMinor.toString(),
        transactionCount: rows.length,
        divergedAtTransactionId: divergedAt,
      };
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * `SELECT … FOR UPDATE` on one card.
   *
   * Raw SQL because Prisma has no row-lock API. The `company_id` predicate is
   * still in the WHERE and RLS is still active on the connection — the lock
   * narrows concurrency, it does not widen visibility.
   */
  private async lockCard(tx: TenantTx, companyId: string, giftCardId: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: GiftCardStatus;
        current_balance_minor: bigint;
        initial_balance_minor: bigint;
        currency_code: string;
        branch_id: string | null;
        issued_to_customer_id: string | null;
        expires_at: Date | null;
        code_last4: string;
      }>
    >`
      SELECT id, status, current_balance_minor, initial_balance_minor,
             currency_code, branch_id, issued_to_customer_id, expires_at, code_last4
        FROM gift_card
       WHERE id = ${giftCardId}::uuid AND company_id = ${companyId}::uuid
       FOR UPDATE
    `;

    const row = rows[0];
    if (!row) throw new ResourceNotFoundError('GiftCard', giftCardId);

    return {
      id: row.id,
      status: row.status,
      currentBalanceMinor: BigInt(row.current_balance_minor),
      initialBalanceMinor: BigInt(row.initial_balance_minor),
      currencyCode: row.currency_code,
      branchId: row.branch_id,
      issuedToCustomerId: row.issued_to_customer_id,
      expiresAt: row.expires_at,
      codeLast4: row.code_last4,
    };
  }

  /**
   * The earlier result for a repeated idempotency key, or null for a new one.
   *
   * A key reused for something DIFFERENT — another card, another amount — is a
   * client bug, and answering it with the old result would hide that.
   */
  private async replay(
    tx: TenantTx,
    companyId: string,
    idempotencyKey: string,
    expected: { giftCardId: string; type: GiftCardTransactionType; amountMinor: bigint },
  ): Promise<{ giftCardId: string; transactionId: string; balanceAfterMinor: bigint } | null> {
    const earlier = await tx.giftCardTransaction.findFirst({
      where: { companyId, idempotencyKey },
    });
    if (!earlier) return null;

    if (
      earlier.giftCardId !== expected.giftCardId ||
      earlier.type !== expected.type ||
      earlier.amountMinor !== expected.amountMinor
    ) {
      throw new ConflictError('That idempotency key was already used for a different request.', {
        field: 'idempotencyKey',
      });
    }

    return {
      giftCardId: earlier.giftCardId,
      transactionId: earlier.id,
      balanceAfterMinor: earlier.balanceAfterMinor,
    };
  }

  private async findByCode(tx: TenantTx, companyId: string, code: string) {
    const codeHash = this.hasher.hash(normaliseCode(code));
    // Both predicates: the hash index is global so the tenant filter is what
    // makes another company's card invisible rather than merely unlikely.
    return tx.giftCard.findFirst({ where: { companyId, codeHash } });
  }

  /**
   * The search box: a full code (by hash), the last four, or the owner's or
   * recipient's name, phone or email.
   */
  private searchClauses(search: string): Prisma.GiftCardWhereInput[] {
    const bare = search.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const clauses: Prisma.GiftCardWhereInput[] = [
      { issuedTo: { OR: customerSearchClauses(search) } },
      { recipientName: { contains: search, mode: 'insensitive' } },
    ];
    if (bare.length === 4) clauses.push({ codeLast4: bare });
    if (bare.length >= 8) clauses.push({ codeHash: this.hasher.hash(normaliseCode(bare)) });
    return clauses;
  }

  private async appendTransaction(
    tx: TenantTx,
    companyId: string,
    entry: {
      giftCardId: string;
      type: GiftCardTransactionType;
      amountMinor: bigint;
      balanceAfterMinor: bigint;
      currencyCode: string;
      appointmentId?: string | null;
      paymentId?: string | null;
      reversesTransactionId?: string | null;
      reason?: string | null;
      idempotencyKey?: string | null;
      actor: Actor;
    },
  ): Promise<string> {
    try {
      const row = await tx.giftCardTransaction.create({
        data: {
          companyId,
          giftCardId: entry.giftCardId,
          type: entry.type,
          amountMinor: entry.amountMinor,
          balanceAfterMinor: entry.balanceAfterMinor,
          currencyCode: entry.currencyCode,
          appointmentId: entry.appointmentId ?? null,
          paymentId: entry.paymentId ?? null,
          reversesTransactionId: entry.reversesTransactionId ?? null,
          reason: entry.reason ?? null,
          idempotencyKey: entry.idempotencyKey ?? null,
          performedByType: entry.actor.type,
          performedById: entry.actor.id,
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      // Only reachable when the same key is used for two DIFFERENT cards at
      // once (the per-card lock serialises everything else).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('That idempotency key is already in use.', {
          field: 'idempotencyKey',
        });
      }
      throw error;
    }
  }

  /** Who is doing this, for the ledger row. The acting membership, not the account. */
  private actor(): Actor {
    const actor = this.context.requireActor();
    switch (actor.kind) {
      case 'COMPANY_USER':
        return { type: 'COMPANY_USER', id: this.context.membership()?.companyUserId ?? null };
      case 'PLATFORM_USER':
        return { type: 'PLATFORM_USER', id: actor.platformUserId };
      case 'CUSTOMER':
        return { type: 'CUSTOMER', id: actor.companyCustomerId };
      case 'SYSTEM':
        return { type: 'SYSTEM', id: null };
    }
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

  /** 404 for another company's customer — indistinguishable from one that does not exist. */
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

/** Why this card cannot be spent, or null. The message is safe to show a customer. */
function redeemabilityProblem(card: {
  status: string;
  currentBalanceMinor: bigint;
  expiresAt: Date | null;
}): Problem | null {
  if (card.status === 'VOID') return { code: 'VOID', message: 'That card has been cancelled.' };
  if (card.status === 'DISABLED')
    return { code: 'DISABLED', message: 'That card has been disabled.' };
  if (card.status === 'PENDING_ACTIVATION') {
    return { code: 'NOT_ACTIVATED', message: 'That card has not been activated yet.' };
  }
  if (card.expiresAt && card.expiresAt.getTime() <= Date.now()) {
    return { code: 'EXPIRED', message: 'That card has expired.' };
  }
  if (card.currentBalanceMinor <= 0n) {
    return { code: 'NO_BALANCE', message: 'That card has no balance left.' };
  }
  return null;
}

/** EXPIRED is derived, not stored — nothing runs at midnight to flip it. */
function effectiveStatus(card: { status: string; expiresAt: Date | null }): string {
  if (card.status === 'ACTIVE' && card.expiresAt && card.expiresAt.getTime() <= Date.now()) {
    return 'EXPIRED';
  }
  return card.status;
}

/** Filter on the EFFECTIVE status, so ACTIVE and EXPIRED mean what the list shows. */
function statusFilter(status: GiftCardQueryDto['status']): Prisma.GiftCardWhereInput | null {
  const now = new Date();
  switch (status) {
    case undefined:
      return null;
    case 'ACTIVE':
      return { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    case 'EXPIRED':
      return {
        OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiresAt: { lte: now } }],
      };
    default:
      return { status };
  }
}

/** `ABCD-EFGH-JKMN-PQRS`. Grouped because somebody has to read it aloud. */
function generateCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < CODE_GROUP_LENGTH; i += 1) {
      group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/** Accept what a human types: lower case, missing dashes, stray spaces. */
export function normaliseCode(code: string): string {
  const bare = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (bare.match(/.{1,4}/g) ?? []).join('-');
}

function toGiftCardResponse(card: {
  id: string;
  codeLast4: string;
  status: string;
  initialBalanceMinor: bigint;
  currentBalanceMinor: bigint;
  currencyCode: string;
  branchId: string | null;
  issuedToCustomerId: string | null;
  purchasedByCustomerId: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  depletedAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  issuedTo?: { id: string; firstName: string; lastName: string | null } | null;
  purchasedBy?: { id: string; firstName: string; lastName: string | null } | null;
}) {
  const problem = redeemabilityProblem(card);

  return {
    id: card.id,
    /** The only part of the code that ever leaves the database after issue. */
    last4: card.codeLast4,
    status: effectiveStatus(card),
    // Money as strings: the columns are BigInt.
    initialBalanceMinor: card.initialBalanceMinor.toString(),
    currentBalanceMinor: card.currentBalanceMinor.toString(),
    currencyCode: card.currencyCode,
    isRedeemable: problem === null,
    problem: problem?.message ?? null,
    branchId: card.branchId,
    issuedToCustomerId: card.issuedToCustomerId,
    issuedToName: fullName(card.issuedTo),
    purchasedByCustomerId: card.purchasedByCustomerId,
    purchasedByName: fullName(card.purchasedBy),
    recipientName: card.recipientName,
    recipientEmail: card.recipientEmail,
    message: card.message,
    issuedAt: card.issuedAt,
    expiresAt: card.expiresAt,
    depletedAt: card.depletedAt,
    disabledAt: card.disabledAt,
    disabledReason: card.disabledReason,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function fullName(person?: { firstName: string; lastName: string | null } | null): string | null {
  if (!person) return null;
  return [person.firstName, person.lastName].filter(Boolean).join(' ');
}
