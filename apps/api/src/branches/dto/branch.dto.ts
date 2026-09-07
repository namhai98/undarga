import { z } from 'zod';

/**
 * Uppercased and trimmed, unique WITHIN a company.
 *
 * Tenant-local rather than global, because a branch code is a customer's own
 * shorthand — half the salons in the country will want `HQ` or `MAIN`, and
 * making the first one to sign up the owner of that string would be absurd. The
 * partial unique index in 001_hardening.sql is `(company_id, code) WHERE
 * deleted_at IS NULL`, so a deleted branch also releases its code.
 *
 * Normalised to uppercase so `hq` and `HQ` cannot coexist and confuse a
 * receptionist reading a printed schedule.
 */
const branchCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(24)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, digits, hyphens and underscores.');

const timezoneName = z.string().min(1).max(64);

/**
 * Coordinates as strings, not numbers.
 *
 * The column is `Decimal(9,6)`. Accepting a JS number here would round-trip
 * through a float on the way in, which is the one thing a fixed-precision
 * column exists to avoid. A string is handed to Prisma's Decimal unchanged.
 */
const latitude = z
  .string()
  .regex(/^-?\d{1,3}(?:\.\d{1,6})?$/, 'Use decimal degrees, e.g. 47.918733.')
  .refine((v) => Math.abs(Number(v)) <= 90, 'Latitude must be between -90 and 90.');

const longitude = z
  .string()
  .regex(/^-?\d{1,3}(?:\.\d{1,6})?$/, 'Use decimal degrees, e.g. 106.917701.')
  .refine((v) => Math.abs(Number(v)) <= 180, 'Longitude must be between -180 and 180.');

const address = {
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  addressLine1: z.string().trim().max(160).nullable().optional(),
  addressLine2: z.string().trim().max(160).nullable().optional(),
  city: z.string().trim().max(96).nullable().optional(),
  district: z.string().trim().max(96).nullable().optional(),
  postalCode: z.string().trim().max(24).nullable().optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .length(2)
    .regex(/^[A-Z]{2}$/, 'Use a two-letter ISO 3166-1 country code.')
    .nullable()
    .optional(),
  latitude: latitude.nullable().optional(),
  longitude: longitude.nullable().optional(),
};

export const createBranchSchema = z
  .object({
    code: branchCode,
    name: z.string().trim().min(1).max(128),
    /**
     * Required, with no fallback to the company default.
     *
     * A branch in another city may sit in another timezone, and the BRANCH
     * timezone is what bookings are calculated against
     * (docs/DATABASE.md). Defaulting it silently would make the one field that
     * decides when a salon opens the easiest one to get wrong — so the caller
     * states it. The company default is what the UI should prefill.
     */
    timezoneName,
    /** Only for a genuinely cross-border company; inherits the company's otherwise. */
    currencyCode: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.')
      .nullable()
      .optional(),
    sortOrder: z.number().int().min(0).max(32_767).optional(),
    ...address,
  })
  .strict();
export type CreateBranchDto = z.infer<typeof createBranchSchema>;

/**
 * `companyId` is absent, and that is the point.
 *
 * The company comes from the resolved tenant context. A body that could carry
 * one would be a way to move a branch between tenants — and the composite
 * foreign key would refuse it, but as a 500 rather than a refusal anyone
 * planned.
 */
export const updateBranchSchema = z
  .object({
    code: branchCode.optional(),
    name: z.string().trim().min(1).max(128).optional(),
    timezoneName: timezoneName.optional(),
    currencyCode: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.')
      .nullable()
      .optional(),
    status: z.enum(['ACTIVE', 'TEMPORARILY_CLOSED', 'INACTIVE']).optional(),
    sortOrder: z.number().int().min(0).max(32_767).optional(),
    ...address,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateBranchDto = z.infer<typeof updateBranchSchema>;

export const listBranchesSchema = z.object({
  status: z.enum(['ACTIVE', 'TEMPORARILY_CLOSED', 'INACTIVE', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListBranchesDto = z.infer<typeof listBranchesSchema>;

/**
 * Per-branch overrides of the company booking policy.
 *
 * Every field is nullable, and null means "inherit" rather than "zero". That
 * distinction is why these are separate columns from the company's rather than
 * a copy — a branch that has never been configured should follow the company
 * automatically, including when the company changes.
 */
export const updateBranchSettingsSchema = z
  .object({
    slotGranularityMin: z.number().int().min(5).max(240).nullable().optional(),
    bookingLeadTimeMin: z.number().int().min(0).max(10_080).nullable().optional(),
    maxAdvanceBookingDays: z.number().int().min(1).max(730).nullable().optional(),
    cancellationWindowHours: z.number().int().min(0).max(720).nullable().optional(),
    allowOnlineBooking: z.boolean().nullable().optional(),
    requireDeposit: z.boolean().nullable().optional(),
    depositPercentBps: z.number().int().min(0).max(10_000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateBranchSettingsDto = z.infer<typeof updateBranchSettingsSchema>;

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

/** `HH:MM`, 24-hour. Seconds are not accepted: nobody opens at 09:00:30. */
const timeOfDay = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00.');

const businessHoursDay = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    isClosed: z.boolean().default(false),
    opensAt: timeOfDay.optional(),
    closesAt: timeOfDay.optional(),
  })
  .strict()
  .superRefine((day, ctx) => {
    if (day.isClosed) {
      // A closed day with times is a contradiction, and silently ignoring them
      // would hide a mistake in whatever generated the request.
      if (day.opensAt || day.closesAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A closed day must not carry opening times.',
          path: ['isClosed'],
        });
      }
      return;
    }

    if (!day.opensAt || !day.closesAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An open day needs both opensAt and closesAt.',
        path: [day.opensAt ? 'closesAt' : 'opensAt'],
      });
      return;
    }

    /**
     * `22:00 -> 06:00` is ACCEPTED, not rejected.
     *
     * Overnight trading is explicitly part of the approved design: the
     * `business_hours` table carries a `crosses_midnight` flag maintained by a
     * trigger, and the availability materializer reads it so it never has to
     * guess (docs/DATABASE.md). Refusing `closesAt < opensAt` here would break
     * every late-night venue and contradict the schema.
     *
     * What IS refused is the one genuinely meaningless case: the same instant
     * for both, which describes a zero-length day rather than a full one.
     */
    if (day.opensAt === day.closesAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Opening and closing time cannot be identical. Mark the day closed instead.',
        path: ['closesAt'],
      });
    }
  });

/**
 * The whole week, replaced at once.
 *
 * PUT rather than PATCH because opening hours are read as a set — "we are open
 * Tuesday to Saturday" is one decision, and applying it as seven independent
 * edits leaves windows where the schedule is half old and half new.
 */
export const putBusinessHoursSchema = z
  .object({
    /**
     * Hours are versioned by the date they take effect, so a company can set
     * summer hours in advance. Defaults to today.
     */
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .optional(),
    days: z.array(businessHoursDay).min(1).max(7),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    for (const day of value.days) {
      if (seen.has(day.dayOfWeek)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Day ${day.dayOfWeek} appears more than once.`,
          path: ['days'],
        });
        return;
      }
      seen.add(day.dayOfWeek);
    }
  });
export type PutBusinessHoursDto = z.infer<typeof putBusinessHoursSchema>;
