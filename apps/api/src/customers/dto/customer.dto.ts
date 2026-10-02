import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * Contact details, normalised on the way in.
 *
 * ---------------------------------------------------------------------------
 * NORMALISATION IS PART OF THE DUPLICATE CHECK, NOT COSMETICS
 * ---------------------------------------------------------------------------
 *
 * The partial unique indexes are on the STORED value. `Sara@x.com` and
 * `sara@x.com` would both be accepted by a raw unique index — the column is
 * `citext`, so those two actually do collide, but `+976 9911 2233` and
 * `+97699112233` would not. Stripping the spaces here is what makes the phone
 * index mean "the same person" rather than "the same keystrokes".
 *
 * Phone is deliberately NOT validated as E.164. This product is sold in a
 * market where a receptionist types `99112233`, and refusing that would make
 * the field unusable to protect a format nothing yet depends on. Digits,
 * spaces and the usual punctuation are accepted; only the separators are
 * removed.
 */
export const customerEmailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(320);

export const customerPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^\+?[\d\s()./-]+$/, 'Enter a phone number.')
  .transform((value) => value.replace(/[\s()./-]/g, ''))
  .refine((value) => value.replace(/\D/g, '').length >= 6, 'That phone number is too short.');

const customerFields = {
  firstName: z.string().trim().min(1, 'Enter a first name.').max(96),
  lastName: z.string().trim().max(96).nullable().optional(),
  email: customerEmailSchema.nullable().optional(),
  phone: customerPhoneSchema.nullable().optional(),
  /** One free-text line — see the schema comment for why it is not structured. */
  address: z.string().trim().max(512).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .nullable()
    .optional(),
  gender: z.string().trim().max(24).nullable().optional(),
  locale: z.string().trim().max(12).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(24).optional(),
  preferredEmployeeId: uuid.nullable().optional(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'ARCHIVED']).optional(),
};

/**
 * `companyId` is absent, and `.strict()` refuses it.
 *
 * The tenant comes from the authenticated context. Accepting it in a body
 * would be a way to write a row into another company — the composite foreign
 * keys would refuse it, but as a 500 nobody planned rather than a refusal
 * anybody designed.
 *
 * The denormalised statistics (`totalVisits`, `totalSpentMinor`,
 * `loyaltyPoints`, `lastVisitAt`) are absent too. They are projections of the
 * appointment and payment tables, and a client that could set them could make
 * a customer's history disagree with the ledger.
 */
export const createCustomerSchema = z
  .object(customerFields)
  .strict()
  .superRefine((value, ctx) => {
    // A customer with neither is unreachable and unfindable — two of them are
    // indistinguishable to whoever has to pick one at the desk.
    if (!value.email && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Give at least a phone number or an email address.',
        path: ['phone'],
      });
    }
  });
export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({ ...customerFields, firstName: customerFields.firstName.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;

/**
 * Searching and filtering, in SQL.
 *
 * `search` matches first name, last name, email and phone. The phone half is
 * normalised the same way input is, so searching `9911 2233` finds a customer
 * stored as `99112233` — otherwise the search box silently fails on exactly
 * the value people paste out of a message.
 */
export const customerQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(160).optional(),
    status: z.enum(['ACTIVE', 'BLOCKED', 'ARCHIVED']).optional(),
    tag: z.string().trim().min(1).max(32).optional(),
    preferredEmployeeId: uuid.optional(),
    /** Customers who have never been in. Useful for cleaning up a list. */
    hasVisited: z.enum(['true', 'false']).optional(),
    sortBy: z
      .enum(['firstName', 'lastName', 'createdAt', 'lastVisitAt', 'totalVisits'])
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type CustomerQueryDto = z.infer<typeof customerQuerySchema>;

export const customerAppointmentQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type CustomerAppointmentQueryDto = z.infer<typeof customerAppointmentQuerySchema>;

/** Exported so the service can normalise a search term the same way. */
export function normalisePhone(value: string): string {
  return value.replace(/[\s()./-]/g, '');
}
