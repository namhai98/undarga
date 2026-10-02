import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type DiscountType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TokenHashService } from '../auth/token-hash.service';
import { loadBookingPrice } from '../catalog/service-price';
import {
  ConflictError,
  PromotionNotApplicableError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { allocateDiscount, calculateDiscount, eligibleAmount } from './discount.calculator';
import type {
  ApplyPromotionDto,
  CreatePromotionDto,
  PromotionQueryDto,
  QuotePromotionDto,
  UpdatePromotionDto,
  ValidatePromotionDto,
} from './dto/promotion.dto';
import { EntitlementsService } from '../subscriptions/entitlements.service';

interface PromotionRow {
  id: string;
  companyId: string;
  name: string;
  deletedAt: Date | null;
}

@Injectable()
export class PromotionRepository extends TenantScopedRepository<PromotionRow> {
  protected readonly modelName = 'Promotion';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<PromotionRow> {
    return tx.promotion;
  }
}

/** Why a promotion cannot be used right now. Safe to show a customer. */
export interface EligibilityProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * Discounts.
 *
 * ===========================================================================
 * TYPED COLUMNS, NOT A RULE ENGINE
 * ===========================================================================
 *
 * The schema comment says it and this service keeps to it: every condition a
 * promotion can express is a real column — `min_purchase_minor`,
 * `new_customers_only`, `starts_at`, the three targeting join tables. There is
 * no JSON predicate tree and no expression language.
 *
 * That is a deliberate ceiling. A rule engine can express "20% off Tuesdays for
 * customers whose third visit falls in a leap year", and then nobody can answer
 * "why did this customer get 3,000 off" without running the engine. Typed
 * columns can be read, indexed, and explained in a sentence.
 *
 * ===========================================================================
 * QUOTE AND APPLY SHARE ONE PATH
 * ===========================================================================
 *
 * `quote()` prices without committing; `apply()` commits. Both go through
 * `evaluate()`, so the number on the till screen is the number that gets
 * written. Two implementations of the same discount is how a customer is
 * quoted one price and charged another.
 *
 * ===========================================================================
 * THE USAGE LIMIT IS A CONDITIONAL UPDATE
 * ===========================================================================
 *
 * `redeemedCount` is consumed with
 *
 *     UPDATE … SET redeemed_count = redeemed_count + 1
 *      WHERE redeemed_count < max_redemptions
 *
 * and a zero row count means somebody else took the last one. Read-then-write
 * would let a promotion capped at 100 be redeemed 103 times under load, and
 * "limited to the first 100 customers" is a promise with legal weight.
 */
@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    private readonly promotions: PromotionRepository,
    private readonly audit: AuditService,
    /** Codes are looked up by keyed hash, as gift-card codes are. */
    private readonly hasher: TokenHashService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(query: PromotionQueryDto) {
    return this.promotions.transaction(async (tx, companyId) => {
      const now = new Date();
      const where: Prisma.PromotionWhereInput = {
        companyId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.discountType ? { discountType: query.discountType } : {}),
        // Name or code. Codes are stored uppercase, so the term is too.
        ...(query.search
          ? {
              AND: [
                {
                  OR: [
                    { name: { contains: query.search, mode: 'insensitive' as const } },
                    {
                      coupons: {
                        some: { companyId, code: { contains: query.search.toUpperCase() } },
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
        ...(query.branchId ? { branches: { some: { companyId, branchId: query.branchId } } } : {}),
        ...(query.serviceId
          ? { services: { some: { companyId, serviceId: query.serviceId } } }
          : {}),
        ...(query.employeeId
          ? { employees: { some: { companyId, employeeId: query.employeeId } } }
          : {}),
        ...(query.activeNow === 'true'
          ? {
              status: 'ACTIVE',
              startsAt: { lte: now },
              OR: [{ endsAt: null }, { endsAt: { gt: now } }],
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.promotion.findMany({
          where,
          orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
          skip: query.offset,
          take: query.limit,
          include: promotionInclude,
        }),
        tx.promotion.count({ where }),
      ]);

      return {
        items: rows.map(toPromotionResponse),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async findById(promotionId: string) {
    return this.promotions.transaction(async (tx, companyId) => {
      const promotion = await tx.promotion.findFirst({
        where: { id: promotionId, companyId, deletedAt: null },
        include: promotionInclude,
      });
      if (!promotion) throw new ResourceNotFoundError('Promotion', promotionId);
      return toPromotionResponse(promotion);
    });
  }

  async create(input: CreatePromotionDto) {
    const { serviceIds, branchIds, employeeIds, code, ...fields } = input;

    const created = await this.promotions.transaction(async (tx, companyId) => {
      const currencyCode = await this.resolveCurrency(tx, companyId, fields.currencyCode);
      await this.assertTargetsExist(tx, companyId, { serviceIds, branchIds, employeeIds });

      const promotion = await tx.promotion.create({
        data: {
          ...fields,
          companyId,
          currencyCode,
          requiresCoupon: Boolean(code),
          // A code-only promotion is never picked up automatically — that would
          // hand it to people who do not have the code.
          ...(code ? { isAutoApply: false } : {}),
          startsAt: new Date(fields.startsAt),
          endsAt: fields.endsAt ? new Date(fields.endsAt) : null,
          discountAmountMinor:
            fields.discountAmountMinor === undefined
              ? null
              : BigInt(fields.discountAmountMinor),
          maxDiscountMinor:
            fields.maxDiscountMinor == null ? null : BigInt(fields.maxDiscountMinor),
          minPurchaseMinor:
            fields.minPurchaseMinor == null ? null : BigInt(fields.minPurchaseMinor),
        },
      });

      await this.replaceTargets(tx, companyId, promotion.id, {
        serviceIds,
        branchIds,
        employeeIds,
      });
      if (code) await this.setCode(tx, companyId, promotion.id, code);

      return promotion;
    });

    await this.audit.record({
      action: 'promotion.created',
      resourceType: 'promotion',
      resourceId: created.id,
      after: {
        name: created.name,
        discountType: created.discountType,
        discountValueBps: created.discountValueBps,
        discountAmountMinor: created.discountAmountMinor?.toString() ?? null,
        status: created.status,
      },
    });

    return this.findById(created.id);
  }

  async update(promotionId: string, input: UpdatePromotionDto) {
    const { serviceIds, branchIds, employeeIds, code, ...fields } = input;

    const before = await this.promotions.transaction(async (tx, companyId) => {
      const before = await tx.promotion.findFirst({
        where: { id: promotionId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Promotion', promotionId);

      if (fields.currencyCode) await this.resolveCurrency(tx, companyId, fields.currencyCode);
      await this.assertTargetsExist(tx, companyId, { serviceIds, branchIds, employeeIds });

      // The merged shape has to stay legal: switching a percentage promotion to
      // a fixed amount without supplying one would violate the CHECK constraint
      // and surface as a 500.
      const discountType = fields.discountType ?? before.discountType;
      const valueBps =
        fields.discountValueBps ?? (fields.discountType ? null : before.discountValueBps);
      const amount =
        fields.discountAmountMinor !== undefined
          ? BigInt(fields.discountAmountMinor)
          : fields.discountType
            ? null
            : before.discountAmountMinor;

      if (discountType === 'PERCENTAGE' && (valueBps === null || valueBps === undefined)) {
        throw new ValidationFailedError({
          discountValueBps: 'A percentage promotion needs a value in basis points.',
        });
      }
      if (discountType === 'FIXED_AMOUNT' && (amount === null || amount === undefined)) {
        throw new ValidationFailedError({
          discountAmountMinor: 'A fixed-amount promotion needs an amount.',
        });
      }

      // The money fields are strings on the wire and BigInt in the column, so
      // they are pulled out of the spread and converted explicitly rather than
      // relying on Prisma to coerce something it will not.
      const {
        maxDiscountMinor: _max,
        minPurchaseMinor: _min,
        discountAmountMinor: _amount,
        ...rest
      } = fields;

      const data: Prisma.PromotionUncheckedUpdateManyInput = {
        ...rest,
        ...(fields.startsAt ? { startsAt: new Date(fields.startsAt) } : {}),
        ...(fields.endsAt !== undefined
          ? { endsAt: fields.endsAt ? new Date(fields.endsAt) : null }
          : {}),
        discountType,
        discountValueBps: discountType === 'PERCENTAGE' ? valueBps : null,
        discountAmountMinor: discountType === 'FIXED_AMOUNT' ? amount : null,
        ...(fields.maxDiscountMinor !== undefined
          ? {
              maxDiscountMinor:
                fields.maxDiscountMinor == null ? null : BigInt(fields.maxDiscountMinor),
            }
          : {}),
        ...(fields.minPurchaseMinor !== undefined
          ? {
              minPurchaseMinor:
                fields.minPurchaseMinor == null ? null : BigInt(fields.minPurchaseMinor),
            }
          : {}),
      };

      const { count } = await tx.promotion.updateMany({
        where: { id: promotionId, companyId, deletedAt: null },
        data,
      });
      if (count === 0) throw new ResourceNotFoundError('Promotion', promotionId);

      await this.replaceTargets(tx, companyId, promotionId, {
        serviceIds,
        branchIds,
        employeeIds,
      });
      if (code !== undefined) {
        await this.setCode(tx, companyId, promotionId, code);
        await tx.promotion.updateMany({
          where: { id: promotionId, companyId },
          data: { requiresCoupon: code !== null, ...(code ? { isAutoApply: false } : {}) },
        });
      }

      return before;
    });

    await this.audit.record({
      action: 'promotion.updated',
      resourceType: 'promotion',
      resourceId: promotionId,
      before: { name: before.name, status: before.status },
      after: { name: input.name, status: input.status },
    });

    return this.findById(promotionId);
  }

  /**
   * Soft delete.
   *
   * The row stays because `promotion_redemption` references it, and a receipt
   * that cannot name the discount it applied is a receipt nobody can audit.
   */
  async remove(promotionId: string) {
    const before = await this.promotions.transaction(async (tx, companyId) => {
      const before = await tx.promotion.findFirst({
        where: { id: promotionId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Promotion', promotionId);

      await tx.promotion.updateMany({
        where: { id: promotionId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'ARCHIVED' },
      });

      return before;
    });

    await this.audit.record({
      action: 'promotion.archived',
      resourceType: 'promotion',
      resourceId: promotionId,
      before: { name: before.name, status: before.status },
    });
  }

  // ---------------------------------------------------------------------------
  // Pricing
  // ---------------------------------------------------------------------------

  /**
   * Price a promotion without committing anything.
   *
   * When no `promotionId` is given, every auto-apply promotion is evaluated and
   * the best eligible one wins — that is what "automatic discount" means at a
   * till. Ties break on `priority`, which is what the column is for.
   */
  async quote(input: QuotePromotionDto) {
    return this.promotions.transaction(async (tx, companyId) => {
      const basket = await this.resolveBasket(tx, companyId, input);

      if (input.promotionId) {
        const promotion = await tx.promotion.findFirst({
          where: { id: input.promotionId, companyId, deletedAt: null },
          include: promotionInclude,
        });
        if (!promotion) throw new ResourceNotFoundError('Promotion', input.promotionId);

        const evaluated = await this.evaluate(tx, companyId, promotion, basket);
        return {
          subtotalMinor: basket.subtotalMinor.toString(),
          applicable: evaluated.problem === null,
          problem: evaluated.problem,
          ...(evaluated.problem === null
            ? {
                promotionId: promotion.id,
                promotionName: promotion.name,
                discountMinor: evaluated.discountMinor.toString(),
                totalMinor: (basket.subtotalMinor - evaluated.discountMinor).toString(),
                cappedBy: evaluated.cappedBy,
              }
            : {}),
        };
      }

      const candidates = await tx.promotion.findMany({
        // Never a code-only promotion: automatic means "for everyone".
        where: { companyId, deletedAt: null, status: 'ACTIVE', isAutoApply: true, requiresCoupon: false },
        orderBy: { priority: 'asc' },
        include: promotionInclude,
      });

      let best: {
        promotion: (typeof candidates)[number];
        discountMinor: bigint;
        cappedBy: string | null;
      } | null = null;

      for (const candidate of candidates) {
        const evaluated = await this.evaluate(tx, companyId, candidate, basket);
        if (evaluated.problem !== null) continue;
        // Strictly greater, so the first (lowest priority number) wins a tie.
        if (!best || evaluated.discountMinor > best.discountMinor) {
          best = {
            promotion: candidate,
            discountMinor: evaluated.discountMinor,
            cappedBy: evaluated.cappedBy,
          };
        }
      }

      if (!best) {
        return {
          subtotalMinor: basket.subtotalMinor.toString(),
          applicable: false,
          problem: { code: 'NO_PROMOTION', message: 'No automatic discount applies.' },
        };
      }

      return {
        subtotalMinor: basket.subtotalMinor.toString(),
        applicable: true,
        problem: null,
        promotionId: best.promotion.id,
        promotionName: best.promotion.name,
        discountMinor: best.discountMinor.toString(),
        totalMinor: (basket.subtotalMinor - best.discountMinor).toString(),
        cappedBy: best.cappedBy,
      };
    });
  }

  /**
   * Commit a promotion to an appointment.
   *
   * One transaction: consume the usage counter, write the redemption with its
   * per-line allocation, and move the appointment's discount and total. All
   * three or none — a counter consumed by a redemption that rolled back is a
   * promotion that quietly runs out early.
   */
  async apply(input: ApplyPromotionDto) {
    const result = await this.promotions
      .transaction((tx, companyId) =>
        this.applyInTransaction(tx, companyId, {
          appointmentId: input.appointmentId,
          promotionId: input.promotionId,
          code: input.code,
        }),
      )
      .catch((error: unknown) => {
        // This endpoint has always answered an exhausted limit with 409 CONFLICT
        // and an ineligible promotion with 400 VALIDATION_FAILED; keep that
        // contract for existing callers.
        if (error instanceof PromotionNotApplicableError) {
          const reason = (error.details?.['reason'] as string | undefined) ?? '';
          if (reason === 'LIMIT_REACHED' || reason === 'CODE_LIMIT_REACHED') {
            throw new ConflictError(error.message, { field: 'promotionId' });
          }
          if (reason !== 'INVALID_CODE') {
            throw new ValidationFailedError({ promotionId: error.message });
          }
        }
        throw error;
      });

    await this.audit.record({
      action: 'promotion.applied',
      resourceType: 'promotion_redemption',
      resourceId: input.appointmentId,
      after: {
        promotionId: result.promotionId,
        code: result.code,
        discountMinor: result.discountMinor.toString(),
      },
    });

    return {
      appointmentId: input.appointmentId,
      promotionId: result.promotionId,
      promotionName: result.promotionName,
      code: result.code,
      discountMinor: result.discountMinor.toString(),
      totalMinor: result.totalMinor.toString(),
    };
  }

  /**
   * THE commit path, inside the caller's transaction. Used by `apply()` and by
   * the Appointment Engine when a booking carries a code, so a discount is
   * validated, counted and written in exactly one way.
   *
   * In one transaction, all or nothing:
   *   1. resolve the promotion (by code, or by id if it is not code-only)
   *   2. serialise on (promotion, customer) so the per-customer limit cannot be
   *      raced — it is a count, not a counter
   *   3. evaluate every rule against the appointment as it stands
   *   4. consume the promotion's and the code's usage counters with conditional
   *      UPDATEs — a zero row count means somebody took the last one
   *   5. write the redemption with its per-line allocation
   *   6. move the discount onto the items (with a booking-time snapshot of the
   *      promotion) and onto the appointment's totals
   *
   * @throws PromotionNotApplicableError with the eligibility reason.
   */
  async applyInTransaction(
    tx: TenantTx,
    companyId: string,
    input: { appointmentId: string; promotionId?: string; code?: string },
  ): Promise<AppliedPromotion> {
    // A code typed at booking on a plan without promotions is refused like any
    // other code that does not apply — the booking rolls back with it.
    const entitlements = await this.entitlements.forCompany(companyId);
    if (!this.entitlements.canUse(entitlements, 'PROMOTIONS')) {
      throw new PromotionNotApplicableError({
        code: 'FEATURE_NOT_AVAILABLE',
        message: 'Promotion codes are not available for this business.',
      });
    }
    const found = input.code
      ? await this.findByCode(tx, companyId, input.code)
      : await this.findById_(tx, companyId, input.promotionId!);
    if (!found) {
      if (input.code) throw new PromotionNotApplicableError(INVALID_CODE);
      throw new ResourceNotFoundError('Promotion', input.promotionId);
    }
    const { promotion, coupon } = found;

    const basket = await this.resolveBasket(tx, companyId, { appointmentId: input.appointmentId });

    if (basket.customerId && promotion.maxRedemptionsPerCustomer !== null) {
      const key = `promo:${companyId}:${promotion.id}:${basket.customerId}`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }

    const evaluated = await this.evaluate(tx, companyId, promotion, basket, coupon);
    if (evaluated.problem) throw new PromotionNotApplicableError(evaluated.problem);

    // THE CONDITIONAL UPDATES. Zero rows means the last redemption went to a
    // concurrent request between the check above and this write.
    if (promotion.maxRedemptions !== null) {
      const consumed = await tx.$executeRaw`
        UPDATE promotion
           SET redeemed_count = redeemed_count + 1
         WHERE id = ${promotion.id}::uuid
           AND company_id = ${companyId}::uuid
           AND redeemed_count < ${promotion.maxRedemptions}
      `;
      if (consumed === 0) throw new PromotionNotApplicableError(LIMIT_REACHED);
    } else {
      await tx.promotion.updateMany({
        where: { id: promotion.id, companyId },
        data: { redeemedCount: { increment: 1 } },
      });
    }

    if (coupon) {
      const consumed = await tx.$executeRaw`
        UPDATE coupon
           SET redeemed_count = redeemed_count + 1
         WHERE id = ${coupon.id}::uuid
           AND company_id = ${companyId}::uuid
           AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
      `;
      if (consumed === 0) {
        throw new PromotionNotApplicableError({
          code: 'CODE_LIMIT_REACHED',
          message: 'That code has been used the maximum number of times.',
        });
      }
    }

    // Spread the discount back over the lines, so refunding one service of
    // three later knows how much of the discount belonged to it.
    const allocation = allocateDiscount(
      basket.lines.map((line) => ({ id: line.id, amountMinor: line.amountMinor })),
      evaluated.discountMinor,
    );

    try {
      await tx.promotionRedemption.create({
        data: {
          companyId,
          promotionId: promotion.id,
          couponId: coupon?.id ?? null,
          appointmentId: basket.appointmentId!,
          customerId: basket.customerId!,
          discountMinor: evaluated.discountMinor,
          allocation: allocation.map((a) => ({
            itemId: a.id,
            discountMinor: a.discountMinor.toString(),
          })),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // (company, promotion, appointment) is unique — one promotion cannot be
        // applied twice to the same ticket.
        throw new ConflictError('That promotion is already on this appointment.', {
          field: 'promotionId',
        });
      }
      throw error;
    }

    // The booking-time record: what was taken off each line, and what the
    // promotion was when it was taken. A later edit to the promotion changes
    // neither.
    const snapshot: PromotionSnapshot = {
      promotionId: promotion.id,
      name: promotion.name,
      code: coupon?.code ?? null,
      discountType: promotion.discountType,
      discountValueBps: promotion.discountValueBps,
      discountAmountMinor: promotion.discountAmountMinor?.toString() ?? null,
      discountMinor: evaluated.discountMinor.toString(),
    };
    const itemIds = new Set(basket.itemIds);
    for (const share of allocation) {
      if (!itemIds.has(share.id)) continue; // a synthetic line on an item-less appointment
      const item = await tx.appointmentItem.findFirstOrThrow({
        where: { id: share.id, companyId },
        select: { discountMinor: true, totalMinor: true, snapshot: true },
      });
      const previous = asRecord(item.snapshot);
      const recorded = previous['promotions'];
      const promotions: unknown[] = Array.isArray(recorded) ? (recorded as unknown[]) : [];
      const itemTotal = item.totalMinor - share.discountMinor;
      await tx.appointmentItem.updateMany({
        where: { id: share.id, companyId },
        data: {
          discountMinor: item.discountMinor + share.discountMinor,
          totalMinor: itemTotal < 0n ? 0n : itemTotal,
          snapshot: {
            ...previous,
            promotions: [...promotions, { ...snapshot, discountMinor: share.discountMinor.toString() }],
          } as Prisma.InputJsonValue,
        },
      });
    }

    const newDiscount = basket.existingDiscountMinor + evaluated.discountMinor;
    const newTotal = basket.grossMinor - newDiscount + basket.taxMinor;
    const totalMinor = newTotal < 0n ? 0n : newTotal;

    await tx.appointment.updateMany({
      where: { id: basket.appointmentId!, companyId },
      // Clamped at the calculator; asserted here because the CHECK constraint
      // would otherwise turn a logic error into a 500.
      data: { discountMinor: newDiscount, totalMinor },
    });

    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      code: coupon?.code ?? null,
      discountMinor: evaluated.discountMinor,
      totalMinor,
      snapshot,
    };
  }

  /**
   * Re-point an appointment's redemptions at its reschedule successor, inside
   * the reschedule transaction. The usage was consumed once, at booking; moving
   * the time neither refunds nor re-charges it.
   */
  async transferRedemptions(
    tx: TenantTx,
    companyId: string,
    from: { appointmentId: string },
    to: { appointmentId: string; itemId: string },
  ): Promise<void> {
    const redemptions = await tx.promotionRedemption.findMany({
      where: { companyId, appointmentId: from.appointmentId },
      select: { id: true, discountMinor: true },
    });
    for (const r of redemptions) {
      await tx.promotionRedemption.updateMany({
        where: { id: r.id, companyId },
        data: {
          appointmentId: to.appointmentId,
          allocation: [{ itemId: to.itemId, discountMinor: r.discountMinor.toString() }],
        },
      });
    }
  }

  /**
   * "Would this code work for this booking, and what would it cost?" — for a
   * booking that does not exist yet.
   *
   * The price is the server's: loaded from the service, branch and employee
   * overrides by the same rule the Appointment Engine uses when it writes the
   * booking. Nothing priced by a client is accepted. Rules that need a known
   * customer (new customers only, per-customer limit, a code issued to one
   * person) are checked when `customerId` is given, and always again at
   * booking.
   */
  async validateCode(input: ValidatePromotionDto, options: { publicOnly?: boolean } = {}) {
    return this.promotions.transaction(async (tx, companyId) => {
      const price = await loadBookingPrice(tx, companyId, input);
      if (options.publicOnly && !price.isOnlineBookable) {
        throw new ResourceNotFoundError('Service', input.serviceId);
      }

      if (input.customerId) {
        const customer = await tx.companyCustomer.findFirst({
          where: { id: input.customerId, companyId, deletedAt: null },
          select: { id: true },
        });
        if (!customer) throw new ResourceNotFoundError('CompanyCustomer', input.customerId);
      }

      const base = {
        originalMinor: price.priceMinor.toString(),
        currencyCode: price.currencyCode,
      };
      const refuse = (problem: EligibilityProblem) => ({
        ...base,
        valid: false,
        reason: problem.code,
        message: problem.message,
        discountMinor: '0',
        finalMinor: price.priceMinor.toString(),
        promotion: null,
      });

      const found = await this.findByCode(tx, companyId, input.code);
      if (!found) return refuse(INVALID_CODE);

      const basket: Basket = {
        appointmentId: null,
        customerId: input.customerId ?? null,
        branchId: input.branchId,
        currencyCode: price.currencyCode,
        employeeIds: input.employeeId ? [input.employeeId] : [],
        lines: [{ id: 'preview', serviceId: price.serviceId, amountMinor: price.priceMinor }],
        itemIds: [],
        subtotalMinor: price.priceMinor,
        grossMinor: price.priceMinor,
        taxMinor: 0n,
        existingDiscountMinor: 0n,
      };

      const evaluated = await this.evaluate(tx, companyId, found.promotion, basket, found.coupon);
      if (evaluated.problem) return refuse(evaluated.problem);

      return {
        ...base,
        valid: true,
        reason: null,
        message: null,
        discountMinor: evaluated.discountMinor.toString(),
        finalMinor: (price.priceMinor - evaluated.discountMinor).toString(),
        promotion: {
          name: found.promotion.name,
          code: found.coupon?.code ?? input.code,
          discountType: found.promotion.discountType,
          discountValueBps: found.promotion.discountValueBps,
          discountAmountMinor: found.promotion.discountAmountMinor?.toString() ?? null,
          cappedBy: evaluated.cappedBy,
        },
      };
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Every condition, in one place, returning the FIRST reason it fails.
   *
   * Order matters for the message quality, not the outcome: a customer told
   * "that promotion has expired" is better served than one told "minimum spend
   * not met" about a promotion that ended last month.
   */
  private async evaluate(
    tx: TenantTx,
    companyId: string,
    promotion: PromotionWithTargets,
    basket: Basket,
    coupon: CouponRow | null = null,
  ): Promise<{
    problem: EligibilityProblem | null;
    discountMinor: bigint;
    cappedBy: string | null;
  }> {
    const none = { discountMinor: 0n, cappedBy: null };
    const now = new Date();

    // A code-only promotion needs its code. Without this, anyone who can see a
    // promotion id — or guess one — could apply it without the code.
    if (promotion.requiresCoupon && !coupon) {
      return {
        ...none,
        problem: { code: 'CODE_REQUIRED', message: 'That promotion needs a promotion code.' },
      };
    }
    if (coupon) {
      if (coupon.status !== 'ACTIVE' || (coupon.expiresAt && coupon.expiresAt <= now)) {
        return { ...none, problem: INVALID_CODE };
      }
      if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
        return {
          ...none,
          problem: {
            code: 'CODE_LIMIT_REACHED',
            message: 'That code has been used the maximum number of times.',
          },
        };
      }
      if (coupon.issuedToCustomerId && coupon.issuedToCustomerId !== basket.customerId) {
        // Said the same way as an unknown code: a personal code must not
        // confirm to a stranger that it exists.
        return { ...none, problem: INVALID_CODE };
      }
    }

    if (promotion.status !== 'ACTIVE') {
      return { ...none, problem: { code: 'NOT_ACTIVE', message: 'That promotion is not active.' } };
    }
    if (promotion.startsAt > now) {
      return { ...none, problem: { code: 'NOT_STARTED', message: 'That promotion has not started yet.' } };
    }
    if (promotion.endsAt && promotion.endsAt <= now) {
      return { ...none, problem: { code: 'ENDED', message: 'That promotion has ended.' } };
    }
    if (promotion.maxRedemptions !== null && promotion.redeemedCount >= promotion.maxRedemptions) {
      return {
        ...none,
        problem: { code: 'LIMIT_REACHED', message: 'That promotion has reached its redemption limit.' },
      };
    }
    if (promotion.currencyCode !== basket.currencyCode) {
      return {
        ...none,
        problem: { code: 'CURRENCY_MISMATCH', message: 'That promotion is priced in another currency.' },
      };
    }

    const branchIds = new Set(promotion.branches.map((b) => b.branchId));
    if (branchIds.size > 0 && (!basket.branchId || !branchIds.has(basket.branchId))) {
      return {
        ...none,
        problem: { code: 'WRONG_BRANCH', message: 'That promotion is not available at this branch.' },
      };
    }

    const employeeIds = new Set(promotion.employees.map((e) => e.employeeId));
    if (employeeIds.size > 0 && !basket.employeeIds.some((id) => employeeIds.has(id))) {
      return {
        ...none,
        problem: {
          code: 'WRONG_EMPLOYEE',
          message: 'That promotion applies to a different member of staff.',
        },
      };
    }

    const serviceIds = new Set(promotion.services.map((s) => s.serviceId));
    const eligible = eligibleAmount(
      basket.lines.map((line) => ({ serviceId: line.serviceId, amountMinor: line.amountMinor })),
      serviceIds,
    );

    if (eligible <= 0n) {
      return {
        ...none,
        problem: {
          code: 'NO_ELIGIBLE_SERVICES',
          message: 'Nothing on this booking qualifies for that promotion.',
        },
      };
    }

    // Minimum spend is measured against the WHOLE basket, not the eligible
    // part: "spend 100,000 and get 20% off colouring" is the offer people
    // write, and testing it against the colouring alone would refuse a ticket
    // that plainly qualifies.
    if (promotion.minPurchaseMinor !== null && basket.subtotalMinor < promotion.minPurchaseMinor) {
      return {
        ...none,
        problem: {
          code: 'BELOW_MINIMUM',
          message: `That promotion needs a minimum spend of ${promotion.minPurchaseMinor.toString()}.`,
        },
      };
    }

    if (basket.customerId) {
      if (promotion.newCustomersOnly) {
        const customer = await tx.companyCustomer.findFirst({
          where: { id: basket.customerId, companyId },
          select: { totalVisits: true },
        });
        if ((customer?.totalVisits ?? 0) > 0) {
          return {
            ...none,
            problem: { code: 'NOT_NEW', message: 'That promotion is for new customers only.' },
          };
        }
      }

      if (promotion.maxRedemptionsPerCustomer !== null) {
        const used = await tx.promotionRedemption.count({
          where: { companyId, promotionId: promotion.id, customerId: basket.customerId },
        });
        if (used >= promotion.maxRedemptionsPerCustomer) {
          return {
            ...none,
            problem: {
              code: 'CUSTOMER_LIMIT_REACHED',
              message: 'This customer has already used that promotion.',
            },
          };
        }
      }
    }

    const result = calculateDiscount(
      {
        discountType: promotion.discountType,
        discountValueBps: promotion.discountValueBps,
        discountAmountMinor: promotion.discountAmountMinor,
        maxDiscountMinor: promotion.maxDiscountMinor,
      },
      eligible,
    );

    return { problem: null, discountMinor: result.discountMinor, cappedBy: result.cappedBy };
  }

  /**
   * Turn either an appointment or a hypothetical subtotal into one shape.
   *
   * A hypothetical basket has one synthetic line so the calculator and the
   * allocator need no special case for it.
   */
  private async resolveBasket(
    tx: TenantTx,
    companyId: string,
    input: Pick<
      QuotePromotionDto,
      'appointmentId' | 'subtotalMinor' | 'branchId' | 'customerId' | 'serviceIds' | 'employeeIds'
    >,
  ): Promise<Basket> {
    if (input.appointmentId) {
      const appointment = await tx.appointment.findFirst({
        where: { id: input.appointmentId, companyId },
        include: {
          items: { select: { id: true, serviceId: true, employeeId: true, totalMinor: true } },
        },
      });
      if (!appointment) throw new ResourceNotFoundError('Appointment', input.appointmentId);

      const lines = appointment.items.map((item) => ({
        id: item.id,
        serviceId: item.serviceId,
        amountMinor: item.totalMinor,
      }));

      // An appointment with no line items still has a subtotal on it. Falling
      // back keeps the calculator honest rather than quoting zero.
      const linesTotal = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
      const gross = linesTotal > 0n ? linesTotal : appointment.subtotalMinor;

      return {
        appointmentId: appointment.id,
        customerId: appointment.customerId,
        branchId: appointment.branchId,
        currencyCode: appointment.currencyCode,
        employeeIds: appointment.items
          .map((item) => item.employeeId)
          .filter((id): id is string => id !== null),
        lines:
          lines.length > 0
            ? lines
            : [{ id: appointment.id, serviceId: null, amountMinor: gross }],
        subtotalMinor: gross,
        grossMinor: gross,
        taxMinor: appointment.taxMinor,
        existingDiscountMinor: appointment.discountMinor,
        itemIds: appointment.items.map((item) => item.id),
      };
    }

    const company = await tx.company.findFirstOrThrow({
      where: { id: companyId },
      select: { currencyCode: true },
    });
    const subtotal = BigInt(input.subtotalMinor ?? '0');
    const serviceIds = input.serviceIds ?? [];

    return {
      appointmentId: null,
      customerId: input.customerId ?? null,
      branchId: input.branchId ?? null,
      currencyCode: company.currencyCode,
      employeeIds: input.employeeIds ?? [],
      lines:
        serviceIds.length > 0
          ? // Split evenly across the named services. Only the targeting
            // outcome depends on this, not the total.
            serviceIds.map((serviceId, index) => ({
              id: `hypothetical-${index}`,
              serviceId,
              amountMinor:
                subtotal / BigInt(serviceIds.length) +
                (index === 0 ? subtotal % BigInt(serviceIds.length) : 0n),
            }))
          : [{ id: 'hypothetical', serviceId: null, amountMinor: subtotal }],
      subtotalMinor: subtotal,
      grossMinor: subtotal,
      taxMinor: 0n,
      existingDiscountMinor: 0n,
      itemIds: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Codes
  // ---------------------------------------------------------------------------

  /**
   * A live code, and its promotion. `null` for an unknown code, a disabled one,
   * or one whose promotion was deleted — the caller says "invalid code" for all
   * of them.
   *
   * Looked up by keyed hash, the way gift-card codes are, so the plaintext a
   * customer typed never appears in a query plan or a slow-query log.
   */
  private async findByCode(tx: TenantTx, companyId: string, code: string) {
    const coupon = await tx.coupon.findFirst({
      where: {
        companyId,
        codeHash: this.hasher.hash(normaliseCode(code)),
        status: 'ACTIVE',
        promotion: { companyId, deletedAt: null },
      },
      include: { promotion: { include: promotionInclude } },
    });
    if (!coupon) return null;
    const { promotion, ...row } = coupon;
    const found: { promotion: PromotionWithTargets; coupon: CouponRow } = { promotion, coupon: row };
    return found;
  }

  private async findById_(tx: TenantTx, companyId: string, promotionId: string) {
    const promotion = await tx.promotion.findFirst({
      where: { id: promotionId, companyId, deletedAt: null },
      include: promotionInclude,
    });
    return promotion ? { promotion, coupon: null } : null;
  }

  /**
   * Set, change or remove a promotion's code.
   *
   * One live code per promotion through this API (the table allows many, for a
   * later "generate 500 single-use codes" feature). Changing it disables the
   * old coupon rather than deleting it: redemptions reference it, and a
   * receipt must still be able to say which code was used.
   */
  private async setCode(tx: TenantTx, companyId: string, promotionId: string, code: string | null) {
    const normalised = code ? normaliseCode(code) : null;

    const clash = normalised
      ? await tx.coupon.findFirst({
          where: { companyId, code: normalised },
          select: { id: true, promotionId: true },
        })
      : null;
    if (clash && clash.promotionId !== promotionId) {
      throw new ConflictError('Another promotion already uses that code.', { field: 'code' });
    }

    await tx.coupon.updateMany({
      where: {
        companyId,
        promotionId,
        status: 'ACTIVE',
        ...(normalised ? { code: { not: normalised } } : {}),
      },
      data: { status: 'DISABLED' },
    });

    if (!normalised) return;
    if (clash) {
      await tx.coupon.updateMany({
        where: { id: clash.id, companyId },
        data: { status: 'ACTIVE' },
      });
      return;
    }
    try {
      await tx.coupon.create({
        data: {
          companyId,
          promotionId,
          code: normalised,
          codeHash: this.hasher.hash(normalised),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('Another promotion already uses that code.', { field: 'code' });
      }
      throw error;
    }
  }

  private async assertTargetsExist(
    tx: TenantTx,
    companyId: string,
    targets: { serviceIds?: string[]; branchIds?: string[]; employeeIds?: string[] },
  ) {
    // 404 rather than 400 for each: an id belonging to another company must be
    // indistinguishable from one that does not exist.
    if (targets.serviceIds?.length) {
      const found = await tx.service.count({
        where: { companyId, id: { in: targets.serviceIds }, deletedAt: null },
      });
      if (found !== new Set(targets.serviceIds).size) {
        throw new ResourceNotFoundError('Service', targets.serviceIds.join(','));
      }
    }
    if (targets.branchIds?.length) {
      const found = await tx.branch.count({
        where: { companyId, id: { in: targets.branchIds }, deletedAt: null },
      });
      if (found !== new Set(targets.branchIds).size) {
        throw new ResourceNotFoundError('Branch', targets.branchIds.join(','));
      }
    }
    if (targets.employeeIds?.length) {
      const found = await tx.employee.count({
        where: { companyId, id: { in: targets.employeeIds }, deletedAt: null },
      });
      if (found !== new Set(targets.employeeIds).size) {
        throw new ResourceNotFoundError('Employee', targets.employeeIds.join(','));
      }
    }
  }

  /**
   * Targeting is replaced wholesale, never patched.
   *
   * Who a promotion applies to is read as a set. Adding and removing members
   * individually would leave it half-configured between two calls, and a
   * half-configured discount is one that either over-applies or under-applies
   * for the duration.
   */
  private async replaceTargets(
    tx: TenantTx,
    companyId: string,
    promotionId: string,
    targets: { serviceIds?: string[]; branchIds?: string[]; employeeIds?: string[] },
  ) {
    if (targets.serviceIds) {
      await tx.promotionService.deleteMany({ where: { companyId, promotionId } });
      if (targets.serviceIds.length > 0) {
        await tx.promotionService.createMany({
          data: [...new Set(targets.serviceIds)].map((serviceId) => ({
            companyId,
            promotionId,
            serviceId,
          })),
        });
      }
    }
    if (targets.branchIds) {
      await tx.promotionBranch.deleteMany({ where: { companyId, promotionId } });
      if (targets.branchIds.length > 0) {
        await tx.promotionBranch.createMany({
          data: [...new Set(targets.branchIds)].map((branchId) => ({
            companyId,
            promotionId,
            branchId,
          })),
        });
      }
    }
    if (targets.employeeIds) {
      await tx.promotionEmployee.deleteMany({ where: { companyId, promotionId } });
      if (targets.employeeIds.length > 0) {
        await tx.promotionEmployee.createMany({
          data: [...new Set(targets.employeeIds)].map((employeeId) => ({
            companyId,
            promotionId,
            employeeId,
          })),
        });
      }
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
}

interface Basket {
  appointmentId: string | null;
  customerId: string | null;
  branchId: string | null;
  currencyCode: string;
  employeeIds: string[];
  lines: Array<{ id: string; serviceId: string | null; amountMinor: bigint }>;
  /** Everything on the ticket, before discount. */
  subtotalMinor: bigint;
  grossMinor: bigint;
  taxMinor: bigint;
  /** Discounts already on the appointment, so a second promotion adds to them. */
  existingDiscountMinor: bigint;
  /** Real appointment_item ids — the lines that can carry a discount. */
  itemIds: string[];
}

const promotionInclude = {
  services: { select: { serviceId: true } },
  branches: { select: { branchId: true } },
  employees: { select: { employeeId: true } },
  coupons: { where: { status: 'ACTIVE' }, select: { code: true }, take: 1 },
} satisfies Prisma.PromotionInclude;

type PromotionWithTargets = Prisma.PromotionGetPayload<{ include: typeof promotionInclude }>;

type CouponRow = {
  id: string;
  code: string;
  status: string;
  maxRedemptions: number | null;
  redeemedCount: number;
  issuedToCustomerId: string | null;
  expiresAt: Date | null;
};

/** The booking-time record of a promotion, kept on the appointment item. */
export interface PromotionSnapshot {
  promotionId: string;
  name: string;
  code: string | null;
  discountType: DiscountType;
  discountValueBps: number | null;
  discountAmountMinor: string | null;
  discountMinor: string;
}

export interface AppliedPromotion {
  promotionId: string;
  promotionName: string;
  code: string | null;
  discountMinor: bigint;
  totalMinor: bigint;
  snapshot: PromotionSnapshot;
}

const INVALID_CODE: EligibilityProblem = {
  code: 'INVALID_CODE',
  message: 'That promotion code is not valid.',
};
const LIMIT_REACHED: EligibilityProblem = {
  code: 'LIMIT_REACHED',
  message: 'That promotion has reached its redemption limit.',
};

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toPromotionResponse(promotion: PromotionWithTargets) {
  const now = Date.now();

  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    status: promotion.status,
    /** Derived, so a promotion that ran out yesterday reads correctly today. */
    isLive:
      promotion.status === 'ACTIVE' &&
      promotion.startsAt.getTime() <= now &&
      (promotion.endsAt === null || promotion.endsAt.getTime() > now) &&
      (promotion.maxRedemptions === null || promotion.redeemedCount < promotion.maxRedemptions),
    discountType: promotion.discountType,
    discountValueBps: promotion.discountValueBps,
    discountAmountMinor: promotion.discountAmountMinor?.toString() ?? null,
    maxDiscountMinor: promotion.maxDiscountMinor?.toString() ?? null,
    minPurchaseMinor: promotion.minPurchaseMinor?.toString() ?? null,
    currencyCode: promotion.currencyCode,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    newCustomersOnly: promotion.newCustomersOnly,
    isAutoApply: promotion.isAutoApply,
    isStackable: promotion.isStackable,
    priority: promotion.priority,
    maxRedemptions: promotion.maxRedemptions,
    maxRedemptionsPerCustomer: promotion.maxRedemptionsPerCustomer,
    redeemedCount: promotion.redeemedCount,
    /** The live code, or null for a promotion applied by staff or automatically. */
    code: promotion.coupons[0]?.code ?? null,
    requiresCode: promotion.requiresCoupon,
    serviceIds: promotion.services.map((s) => s.serviceId),
    branchIds: promotion.branches.map((b) => b.branchId),
    employeeIds: promotion.employees.map((e) => e.employeeId),
    createdAt: promotion.createdAt,
    updatedAt: promotion.updatedAt,
  };
}
