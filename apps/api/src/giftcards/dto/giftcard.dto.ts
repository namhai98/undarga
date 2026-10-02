import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * Minor units as a STRING, everywhere money appears.
 *
 * The columns are BigInt. Above 2^53 a JS number silently rounds, and a
 * customer's stored value is exactly the number that must not.
 */
const minorUnits = z
  .string()
  .regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "5000000".');

/**
 * Above zero. The pattern is re-checked inside the refinement because zod runs
 * refinements even after a failed regex, and `BigInt('10.5')` throws — which
 * would turn a malformed amount into a 500 instead of a 400.
 */
const positiveMinorUnits = (message: string) =>
  minorUnits.refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, message);

/** Signed, for an adjustment that may go either way. */
const signedMinorUnits = z
  .string()
  .regex(/^-?\d{1,15}$/, 'Use a whole number of minor units, e.g. "-5000".')
  .refine((v) => v !== '0' && v !== '-0', 'An adjustment of zero does nothing.');

const isoDateTime = z.string().datetime({ offset: true });

export const issueGiftCardSchema = z
  .object({
    initialBalanceMinor: positiveMinorUnits('Load some value onto the card.'),
    currencyCode: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.')
      .optional(),
    /** Who it is for. Optional — a card bought off the shelf has no name on it. */
    issuedToCustomerId: uuid.optional(),
    /** Who paid. Separate from the recipient: gift cards are usually gifts. */
    purchasedByCustomerId: uuid.optional(),
    /** Restrict to one branch. Omit to make it good anywhere. */
    branchId: uuid.optional(),
    recipientName: z.string().trim().max(128).optional(),
    recipientEmail: z.string().trim().toLowerCase().email().max(320).optional(),
    message: z.string().trim().max(1000).optional(),
    /**
     * Omit for a card that never expires, which is the safe default: expiry on
     * stored value is restricted or outright prohibited in many jurisdictions.
     */
    expiresAt: isoDateTime.optional(),
  })
  .strict();
export type IssueGiftCardDto = z.infer<typeof issueGiftCardSchema>;

/** Future only: to stop a card now, disable it. */
const futureDateTime = isoDateTime.refine(
  (v) => new Date(v).getTime() > Date.now(),
  'Choose a date in the future. To stop a card now, disable it.',
);

export const GIFT_CARD_STATUSES = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'DEPLETED',
  'EXPIRED',
  'DISABLED',
  'VOID',
] as const;

export const giftCardQuerySchema = z
  .object({
    /** EXPIRED and ACTIVE are the effective status: an ACTIVE card past its expiry is EXPIRED. */
    status: z.enum(GIFT_CARD_STATUSES).optional(),
    issuedToCustomerId: uuid.optional(),
    /**
     * A full code (exact match against its hash — codes are never stored), the
     * last four characters, or the owning customer's / recipient's name, phone
     * or email.
     */
    search: z.string().trim().min(1).max(100).optional(),
    /** All a member of staff can read off a card the customer is holding. */
    last4: z.string().trim().length(4).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type GiftCardQueryDto = z.infer<typeof giftCardQuerySchema>;

/**
 * A code, as a human typed it.
 *
 * POST rather than a path parameter: a gift-card code in a URL lands in access
 * logs, proxy logs and the `Referer` header, and unlike a session it cannot be
 * rotated — it is bearer value until it is spent.
 */
export const giftCardLookupSchema = z
  .object({ code: z.string().trim().min(4).max(32) })
  .strict();
export type GiftCardLookupDto = z.infer<typeof giftCardLookupSchema>;

/**
 * What may change after issue. Deliberately NOT the balance or the currency:
 * the balance moves only through the ledger (redeem, refund, adjustment), and
 * `.strict()` turns an attempt to send one into a 400 rather than a silent
 * no-op.
 */
export const updateGiftCardSchema = z
  .object({
    /** `null` detaches the card from its customer. */
    issuedToCustomerId: uuid.nullable().optional(),
    /** `null` means never expires. */
    expiresAt: futureDateTime.nullable().optional(),
    recipientName: z.string().trim().max(128).nullable().optional(),
    recipientEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    message: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');
export type UpdateGiftCardDto = z.infer<typeof updateGiftCardSchema>;

export const disableGiftCardSchema = z
  .object({ reason: z.string().trim().min(3, 'Say why.').max(512) })
  .strict();
export type DisableGiftCardDto = z.infer<typeof disableGiftCardSchema>;

const idempotencyKey = z.string().trim().min(8).max(128);

/**
 * Spend part of a card outside the payments module — a service settled at the
 * desk, recorded here. Never partial: more than the balance is refused.
 */
export const redeemGiftCardSchema = z
  .object({
    amountMinor: positiveMinorUnits('Redeem a positive amount.'),
    /** Links the redemption to a booking; the card's owner, if any, must be its customer. */
    appointmentId: uuid.optional(),
    /** Where it was spent. A card restricted to one branch is refused elsewhere. */
    branchId: uuid.optional(),
    note: z.string().trim().max(512).optional(),
    /** Retrying with the same key returns the first result instead of spending twice. */
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();
export type RedeemGiftCardDto = z.infer<typeof redeemGiftCardSchema>;

/** Give back all or part of one earlier redemption. Never more than it took. */
export const refundGiftCardSchema = z
  .object({
    /** The REDEEM ledger row being reversed. */
    transactionId: uuid,
    /** Omit to give back everything not yet refunded from that redemption. */
    amountMinor: positiveMinorUnits('Refund a positive amount.').optional(),
    reason: z.string().trim().min(3, 'Say why.').max(512),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();
export type RefundGiftCardDto = z.infer<typeof refundGiftCardSchema>;

export const giftCardTransactionQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type GiftCardTransactionQueryDto = z.infer<typeof giftCardTransactionQuerySchema>;

export const adjustGiftCardSchema = z
  .object({
    amountMinor: signedMinorUnits,
    /** Required, and the database refuses an ADJUST without one. */
    reason: z.string().trim().min(3, 'Say why.').max(512),
  })
  .strict();
export type AdjustGiftCardDto = z.infer<typeof adjustGiftCardSchema>;

export const voidGiftCardSchema = z
  .object({ reason: z.string().trim().min(3, 'Say why.').max(512) })
  .strict();
export type VoidGiftCardDto = z.infer<typeof voidGiftCardSchema>;
