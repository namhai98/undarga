import { z } from 'zod';

const uuid = z.string().uuid();

const minorUnits = z
  .string()
  .regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "5000000".')
  .refine((v) => BigInt(v) > 0n, 'A payment must be for a positive amount.');

/**
 * The methods a caller may name.
 *
 * `DEPOSIT`, `PARTIAL` and `REFUND` from the brief are deliberately NOT methods.
 * They are answers to different questions, and flattening them into one enum is
 * how a payments table stops being able to answer either:
 *
 *   METHOD   how the money moved            CASH, CARD, BANK_TRANSFER, ONLINE, GIFT_CARD
 *   PURPOSE  what it was for                BOOKING, DEPOSIT, BALANCE, NO_SHOW_FEE, TIP
 *   PARTIAL  a property of the AMOUNT       any payment smaller than the balance
 *   REFUND   the opposite direction         its own table, referencing the payment it reverses
 *
 * A deposit paid in cash is `method: CASH, purpose: DEPOSIT`. Making DEPOSIT a
 * method would lose the fact that it was cash — and the end-of-day drawer
 * reconciliation is exactly that fact.
 */
const paymentMethod = z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE', 'GIFT_CARD', 'WALLET', 'OTHER']);

const paymentPurpose = z.enum([
  'BOOKING',
  'DEPOSIT',
  'BALANCE',
  'NO_SHOW_FEE',
  'CANCELLATION_FEE',
  'GIFT_CARD_PURCHASE',
  'TIP',
  'OTHER',
]);

export const createPaymentSchema = z
  .object({
    amountMinor: minorUnits,
    method: paymentMethod,
    purpose: paymentPurpose.default('BOOKING'),
    currencyCode: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.')
      .optional(),

    /** Optional: a walk-in retail sale has no appointment. */
    appointmentId: uuid.optional(),
    customerId: uuid.optional(),
    branchId: uuid.optional(),

    /** Required when `method` is GIFT_CARD, refused otherwise. */
    giftCardCode: z.string().trim().min(4).max(32).optional(),

    /**
     * Stable across retries of the same logical payment.
     *
     * The column is GLOBALLY unique, so a double-submitted checkout returns the
     * existing payment rather than charging twice. Omitting it is allowed —
     * cash handed over the counter is a fact, not a request that can be
     * accidentally repeated by a flaky network — but any client that can retry
     * should send one.
     */
    idempotencyKey: z.string().trim().min(8).max(128).optional(),

    /** Passed to the provider. Never persisted as-is if it looks like a secret. */
    metadata: z.record(z.string(), z.unknown()).optional(),
    note: z.string().trim().max(512).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === 'GIFT_CARD' && !value.giftCardCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Redeeming a gift card needs its code.',
        path: ['giftCardCode'],
      });
    }
    if (value.method !== 'GIFT_CARD' && value.giftCardCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A gift-card code only belongs on a GIFT_CARD payment.',
        path: ['giftCardCode'],
      });
    }
  });
export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;

export const paymentQuerySchema = z
  .object({
    appointmentId: uuid.optional(),
    customerId: uuid.optional(),
    branchId: uuid.optional(),
    method: paymentMethod.optional(),
    status: z.enum(['PENDING', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']).optional(),
    /** Inclusive date bounds on `createdAt`, as YYYY-MM-DD. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    search: z.string().trim().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type PaymentQueryDto = z.infer<typeof paymentQuerySchema>;

export const refundPaymentSchema = z
  .object({
    /** Omit to refund everything still refundable on this payment. */
    amountMinor: minorUnits.optional(),
    reason: z.string().trim().min(3, 'Say why.').max(512),
    /**
     * ORIGINAL_METHOD puts it back the way it came. GIFT_CARD is the sensible
     * default for a cash sale being reversed weeks later, and is the only
     * destination that can credit a gift-card payment.
     */
    destination: z.enum(['ORIGINAL_METHOD', 'GIFT_CARD', 'CASH', 'BANK_TRANSFER']).default(
      'ORIGINAL_METHOD',
    ),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .strict();
export type RefundPaymentDto = z.infer<typeof refundPaymentSchema>;
