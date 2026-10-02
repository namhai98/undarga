import { z } from 'zod';

const planKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{2,48}$/, 'Use a plan key such as PRO.');

export const startTrialSchema = z.object({ planKey }).strict();
export type StartTrialDto = z.infer<typeof startTrialSchema>;

export const changePlanSchema = z.object({ planKey }).strict();
export type ChangePlanDto = z.infer<typeof changePlanSchema>;

export const cancelSubscriptionSchema = z
  .object({ reason: z.string().trim().min(3).max(512).optional() })
  .strict();
export type CancelSubscriptionDto = z.infer<typeof cancelSubscriptionSchema>;

export const invoiceQuerySchema = z
  .object({
    status: z.enum(['DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type InvoiceQueryDto = z.infer<typeof invoiceQuerySchema>;

/** Platform only. */
export const extendSubscriptionSchema = z
  .object({
    days: z.number().int().min(1).max(366),
    reason: z.string().trim().min(3).max(512),
  })
  .strict();
export type ExtendSubscriptionDto = z.infer<typeof extendSubscriptionSchema>;
