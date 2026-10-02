import { z } from 'zod';

const uuid = z.string().uuid();

const minorUnits = z
  .string()
  .regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "500000".');

const isoDateTime = z.string().datetime({ offset: true });

/**
 * Percentages are BASIS POINTS, never floats.
 *
 * 15% is 1500. `0.15 * total` in IEEE-754 is how a discount comes out a
 * tögrög short on some totals and a tögrög over on others, and a reconciliation
 * that is off by one is indistinguishable from fraud until somebody spends a
 * day on it.
 */
/**
 * A promotion code as a customer types it. Normalised to uppercase and trimmed
 * so `summer20` and `SUMMER20 ` are the same code.
 */
export const promotionCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,47}$/, 'Use 3–48 letters, digits, hyphens or underscores.');

const basisPoints = z
  .number()
  .int('Use basis points: 15% is 1500.')
  .min(1)
  .max(10000, '100% is 10000 basis points.');

const promotionFields = {
  name: z.string().trim().min(1, 'Give the promotion a name.').max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED']).optional(),

  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountValueBps: basisPoints.optional(),
  discountAmountMinor: minorUnits.optional(),
  /** Caps a percentage discount — "20% off, up to 30,000". */
  maxDiscountMinor: minorUnits.nullable().optional(),
  currencyCode: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.')
    .optional(),

  minPurchaseMinor: minorUnits.nullable().optional(),

  startsAt: isoDateTime,
  endsAt: isoDateTime.nullable().optional(),

  newCustomersOnly: z.boolean().optional(),
  isAutoApply: z.boolean().optional(),
  isStackable: z.boolean().optional(),
  priority: z.number().int().min(0).max(32767).optional(),

  maxRedemptions: z.number().int().min(1).nullable().optional(),
  maxRedemptionsPerCustomer: z.number().int().min(1).max(32767).nullable().optional(),

  /** Empty array means "anything". Explicit ids narrow it. */
  serviceIds: z.array(uuid).max(200).optional(),
  branchIds: z.array(uuid).max(50).optional(),
  employeeIds: z.array(uuid).max(200).optional(),

  /**
   * The code customers type. Setting one makes the promotion code-only: it can
   * no longer be applied by id or picked up automatically, only by someone who
   * has the code. `null` removes it.
   */
  code: promotionCode.nullable().optional(),
};

/**
 * `FREE_SERVICE` is accepted by the database enum and refused here.
 *
 * It cannot be priced without knowing WHICH service is free, and the schema has
 * nowhere to record that. Storing one would create a promotion the calculator
 * cannot evaluate — better to refuse it at the door than to discover it at the
 * till.
 */
const shapeMatchesType = (
  value: { discountType: string; discountValueBps?: number; discountAmountMinor?: string },
  ctx: z.RefinementCtx,
) => {
  if (value.discountType === 'PERCENTAGE') {
    if (value.discountValueBps === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A percentage promotion needs a value in basis points.',
        path: ['discountValueBps'],
      });
    }
    if (value.discountAmountMinor !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A percentage promotion cannot also carry a fixed amount.',
        path: ['discountAmountMinor'],
      });
    }
    return;
  }

  if (value.discountAmountMinor === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A fixed-amount promotion needs an amount.',
      path: ['discountAmountMinor'],
    });
  }
  if (value.discountValueBps !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A fixed-amount promotion cannot also carry a percentage.',
      path: ['discountValueBps'],
    });
  }
};

export const createPromotionSchema = z
  .object(promotionFields)
  .strict()
  .superRefine((value, ctx) => {
    shapeMatchesType(value, ctx);

    if (value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The end must be after the start.',
        path: ['endsAt'],
      });
    }
  });
export type CreatePromotionDto = z.infer<typeof createPromotionSchema>;

export const updatePromotionSchema = z
  .object({
    ...promotionFields,
    name: promotionFields.name.optional(),
    discountType: promotionFields.discountType.optional(),
    startsAt: isoDateTime.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdatePromotionDto = z.infer<typeof updatePromotionSchema>;

export const promotionQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(160).optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED']).optional(),
    /** Live right now: active, started, not finished. What the till cares about. */
    activeNow: z.enum(['true', 'false']).optional(),
    branchId: uuid.optional(),
    serviceId: uuid.optional(),
    employeeId: uuid.optional(),
    discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type PromotionQueryDto = z.infer<typeof promotionQuerySchema>;

/**
 * "What would this promotion take off?" — priced without committing anything.
 *
 * The till calls this before the customer agrees, so the number on the screen
 * and the number that gets charged come from the same code path.
 */
export const quotePromotionSchema = z
  .object({
    appointmentId: uuid.optional(),
    /** Or price a hypothetical basket, before an appointment exists. */
    subtotalMinor: minorUnits.optional(),
    promotionId: uuid.optional(),
    branchId: uuid.optional(),
    customerId: uuid.optional(),
    serviceIds: z.array(uuid).max(50).optional(),
    employeeIds: z.array(uuid).max(50).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.appointmentId) !== Boolean(v.subtotalMinor),
    'Give either an appointmentId or a subtotalMinor, not both.',
  );
export type QuotePromotionDto = z.infer<typeof quotePromotionSchema>;

/** Commit a promotion to an appointment: writes the redemption and the total. */
/**
 * Apply to an existing appointment by id or by code. A code-only promotion
 * (one with a code set) can only be applied with its code.
 */
export const applyPromotionSchema = z
  .object({
    promotionId: uuid.optional(),
    code: promotionCode.optional(),
    appointmentId: uuid,
  })
  .strict()
  .refine((v) => Boolean(v.promotionId) !== Boolean(v.code), {
    message: 'Give either a promotionId or a code, not both.',
    path: ['code'],
  });
export type ApplyPromotionDto = z.infer<typeof applyPromotionSchema>;

/**
 * Check a code against a booking that has not been made yet.
 *
 * Only ids — never a price. The server prices the service itself (service,
 * branch and employee overrides) and checks every id against the tenant.
 */
export const validatePromotionSchema = z
  .object({
    code: promotionCode,
    branchId: uuid,
    serviceId: uuid,
    employeeId: uuid.optional(),
    customerId: uuid.optional(),
  })
  .strict();
export type ValidatePromotionDto = z.infer<typeof validatePromotionSchema>;
