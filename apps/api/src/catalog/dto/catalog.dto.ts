import { z } from 'zod';

const uuid = z.string().uuid();

/** `#rgb`, `#rrggbb` or `#rrggbbaa` — the column is VarChar(9). */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Use a hex colour, e.g. #0F6B63.');

/**
 * `code`, not `slug`.
 *
 * The schema has no slug on a service, and inventing one would mean a second
 * identifier nobody indexed. `code` is what exists — `(company_id, code) WHERE
 * deleted_at IS NULL AND code IS NOT NULL` — so it is optional, tenant-local,
 * and released when a service is deleted. Uppercased so `hc` and `HC` cannot
 * both exist and confuse whoever reads a till receipt.
 */
const catalogCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(24)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, digits, hyphens and underscores.');

/**
 * Money as a STRING of minor units.
 *
 * The column is BigInt. A JS number silently rounds above 2^53, and a price is
 * exactly the value that must not — so it never becomes a number anywhere
 * between the request body and the column. `"50000"` is 500.00 in a two-decimal
 * currency; the currency decides, not this field.
 */
const minorUnits = z
  .string()
  .regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "50000".');

/**
 * Duration and buffers, in whole minutes.
 *
 * Integer minutes rather than a human string, because the availability engine
 * has to compute `start + bufferBefore + duration + bufferAfter` and cannot do
 * arithmetic on "1 hour 30 minutes". The upper bound is a day: the column is a
 * SmallInt and a service longer than that is a booking model this schema does
 * not have.
 */
const durationMinutes = z.number().int().min(1).max(1440);
const bufferMinutes = z.number().int().min(0).max(480);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Categories are HIERARCHICAL, because the schema says so.
 *
 * `parent_id` is a self-relation and the unique index is
 * `(company_id, parent_id, name)` — so two children of different parents may
 * share a name, which is what makes `Hair > Colouring` and `Nails > Colouring`
 * both legal. Flattening it would contradict the approved design.
 *
 * Depth is capped at two levels in the service, not here: a schema check cannot
 * see the parent's parent.
 */
export const createServiceCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    parentId: uuid.nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    color: hexColor.nullable().optional(),
    sortOrder: z.number().int().min(0).max(32_767).optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();
export type CreateServiceCategoryDto = z.infer<typeof createServiceCategorySchema>;

export const updateServiceCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    /** Moving a category between parents. Cycles are refused in the service. */
    parentId: uuid.nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    color: hexColor.nullable().optional(),
    sortOrder: z.number().int().min(0).max(32_767).optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateServiceCategoryDto = z.infer<typeof updateServiceCategorySchema>;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * What a service requires before it can be booked.
 *
 * `resourceTypeId` points at a TYPE, not a specific resource — "a treatment
 * room", not "room 3". Which actual room gets used is the availability engine's
 * decision at booking time, and encoding a specific one here would make every
 * booking fail whenever that room is busy.
 */
const resourceRequirement = z
  .object({
    resourceTypeId: uuid,
    quantity: z.number().int().min(1).max(32).default(1),
  })
  .strict();

const serviceFields = {
  name: z.string().trim().min(1).max(160),
  code: catalogCode.nullable().optional(),
  categoryId: uuid.nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),

  durationMin: durationMinutes,
  bufferBeforeMin: bufferMinutes.optional(),
  bufferAfterMin: bufferMinutes.optional(),

  priceMinor: minorUnits,
  /**
   * Optional: defaults to the company currency.
   *
   * Overridable because the schema allows it and a cross-border company is a
   * real case, but almost nobody should set it — a service priced in a currency
   * the company does not settle in is a reporting problem waiting to happen.
   */
  currencyCode: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.')
    .optional(),

  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  /**
   * Visible on the PUBLIC booking site.
   *
   * Distinct from whether it can be booked at all, which is `status`. An
   * internal-only service — a staff training slot, a supplier visit — is
   * `status: ACTIVE` and `isOnlineBookable: false`: reception can book it, the
   * public cannot see it. Two flags would be one too many; these two already
   * express the distinction.
   */
  isOnlineBookable: z.boolean().optional(),

  requiresEmployee: z.boolean().optional(),
  requiresResource: z.boolean().optional(),
  requiresDeposit: z.boolean().optional(),
  /** Nothing charges it yet; payments are a later module. */
  depositMinor: minorUnits.nullable().optional(),

  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).max(32_767).optional(),
};

export const createServiceSchema = z
  .object({
    ...serviceFields,
    /** Assigned at creation so a service is never briefly unavailable everywhere. */
    branchIds: z.array(uuid).max(50).optional(),
    employeeIds: z.array(uuid).max(200).optional(),
    resourceRequirements: z.array(resourceRequirement).max(10).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A deposit with no amount is a setting that does nothing, and an amount
    // with no flag is an amount nobody will charge. Either is a mistake worth
    // reporting rather than storing.
    if (value.requiresDeposit && !value.depositMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A service that requires a deposit needs a deposit amount.',
        path: ['depositMinor'],
      });
    }
  });
export type CreateServiceDto = z.infer<typeof createServiceSchema>;

/**
 * `companyId` is absent: it would be a way to move a service between tenants.
 * The composite foreign keys would refuse it, but as a 500 rather than a
 * refusal anyone planned.
 */
export const updateServiceSchema = z
  .object({
    ...serviceFields,
    name: serviceFields.name.optional(),
    durationMin: durationMinutes.optional(),
    priceMinor: minorUnits.optional(),
    resourceRequirements: z.array(resourceRequirement).max(10).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateServiceDto = z.infer<typeof updateServiceSchema>;

/**
 * Filtering, in SQL.
 *
 * `branchId` and `employeeId` go through the join tables. Together they are the
 * intersection the availability engine will need — "which services can be
 * booked here, with this person" — so the relationship is queried in the right
 * shape from the start.
 */
export const serviceQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(160).optional(),
    categoryId: uuid.optional(),
    branchId: uuid.optional(),
    employeeId: uuid.optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
    isOnlineBookable: z.enum(['true', 'false']).optional(),
    sortBy: z.enum(['name', 'sortOrder', 'priceMinor', 'durationMin', 'createdAt']).default('sortOrder'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ServiceQueryDto = z.infer<typeof serviceQuerySchema>;

export const assignServiceBranchSchema = z
  .object({
    branchId: uuid,
    /** Assigned but temporarily not offered here — a room being refitted. */
    isAvailable: z.boolean().optional(),
    /** This branch charges differently. Minor units as a string. */
    priceOverrideMinor: minorUnits.nullable().optional(),
    durationOverrideMin: durationMinutes.nullable().optional(),
  })
  .strict();
export type AssignServiceBranchDto = z.infer<typeof assignServiceBranchSchema>;

export const assignServiceEmployeeSchema = z
  .object({
    employeeId: uuid,
    durationOverrideMin: durationMinutes.nullable().optional(),
    priceOverrideMinor: minorUnits.nullable().optional(),
    proficiency: z.number().int().min(1).max(5).nullable().optional(),
  })
  .strict();
export type AssignServiceEmployeeDto = z.infer<typeof assignServiceEmployeeSchema>;
