import { z } from 'zod';

const uuid = z.string().uuid();
const minorUnits = z
  .string()
  .regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "50000".');

/**
 * Required, not optional, on every call that starts an online payment: a
 * checkout is exactly the request a browser retries on a flaky connection, and
 * the key is what makes the retry return the same payment instead of a second
 * one. Generate it once per checkout (a UUID is fine).
 */
const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Letters, digits and . _ : - only.');

/** `POST /payments` — staff take an online payment for an appointment. */
export const createOnlinePaymentSchema = z
  .object({
    appointmentId: uuid,
    /** Defaults to everything still owed. Never more than that. */
    amountMinor: minorUnits.optional(),
    idempotencyKey,
  })
  .strict();
export type CreateOnlinePaymentDto = z.infer<typeof createOnlinePaymentSchema>;

/** `POST /companies/:companyId/billing/:invoiceId/pay` */
export const payInvoiceSchema = z.object({ idempotencyKey }).strict();
export type PayInvoiceDto = z.infer<typeof payInvoiceSchema>;

/** `POST /payments/:id/refund` */
export const refundOnlinePaymentSchema = z
  .object({
    /** Omit for everything still refundable. Some providers refund whole payments only. */
    amountMinor: minorUnits.optional(),
    reason: z.string().trim().min(3, 'Say why.').max(512),
  })
  .strict();
export type RefundOnlinePaymentDto = z.infer<typeof refundOnlinePaymentSchema>;

/** `POST /public/companies/:slug/payments` — the booker pays from the confirmation. */
export const publicCreatePaymentSchema = z
  .object({
    /** From the booking confirmation. Proves this caller made that booking. */
    paymentToken: z.string().min(1).max(512),
    idempotencyKey,
  })
  .strict();
export type PublicCreatePaymentDto = z.infer<typeof publicCreatePaymentSchema>;

export const publicPaymentQuerySchema = z.object({ token: z.string().min(1).max(512) }).strict();
export type PublicPaymentQueryDto = z.infer<typeof publicPaymentQuerySchema>;

/** Development only: drive the mock provider through its real webhook path. */
export const simulatePaymentSchema = z
  .object({
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
    /** Public route only: the booking's payment token. */
    token: z.string().min(1).max(512).optional(),
  })
  .strict();
export type SimulatePaymentDto = z.infer<typeof simulatePaymentSchema>;

export const platformPaymentQuerySchema = z
  .object({
    companyId: uuid.optional(),
    kind: z.enum(['APPOINTMENT', 'SUBSCRIPTION_INVOICE']).optional(),
    status: z
      .enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type PlatformPaymentQueryDto = z.infer<typeof platformPaymentQuerySchema>;

export const webhookEventQuerySchema = z
  .object({
    status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'REJECTED']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type WebhookEventQueryDto = z.infer<typeof webhookEventQuerySchema>;

export const platformRefundSchema = z
  .object({ reason: z.string().trim().min(5, 'Say why — this goes on the audit trail.').max(512) })
  .strict();
export type PlatformRefundDto = z.infer<typeof platformRefundSchema>;
