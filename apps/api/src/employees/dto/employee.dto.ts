import { z } from 'zod';

/**
 * Uppercased, unique WITHIN a company, and optional.
 *
 * Tenant-local for the same reason branch codes are: `EMP-001` is a customer's
 * own numbering, and making the first company to sign up its owner would be
 * absurd. The partial unique index is
 * `(company_id, employee_code) WHERE deleted_at IS NULL AND employee_code IS
 * NOT NULL`, so codes are optional, a deleted employee releases theirs, and any
 * number of employees may have none.
 */
const employeeCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(24)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, digits, hyphens and underscores.');

const uuid = z.string().uuid();

/** `#rgb`, `#rrggbb` or `#rrggbbaa` — the column is VarChar(9). */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Use a hex colour, e.g. #0F6B63.');

/**
 * The public-facing half of an employee.
 *
 * Kept as its own object because these are the fields a customer sees on a
 * booking page, and the separation is what stops `emergencyContact` — which
 * lives on the same table — from ever being lumped in with them.
 */
const profileFields = {
  jobTitle: z.string().trim().max(96).nullable().optional(),
  bio: z.string().trim().max(2000).nullable().optional(),
  languages: z.array(z.string().trim().min(2).max(12)).max(10).optional(),
  specialties: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  /** The employee's WORK phone. Their personal one lives on their user account. */
  phone: z.string().trim().max(32).nullable().optional(),
  /** Private. Never returned by the public profile projection. */
  emergencyContact: z.string().trim().max(255).nullable().optional(),
};

export const createEmployeeSchema = z
  .object({
    /**
     * The one required field.
     *
     * Deliberately not first/last name: the schema has neither. What a salon
     * puts on a calendar and a booking page is a single display name, which is
     * frequently not a legal name at all — a stage name, one mononym, or a
     * transliteration. Splitting it would force every consumer to reassemble
     * it and would get the order wrong in half the world's locales.
     */
    displayName: z.string().trim().min(1).max(128),
    employeeCode: employeeCode.optional(),
    status: z.enum(['ACTIVE', 'ON_LEAVE', 'INACTIVE', 'TERMINATED']).optional(),
    /** Whether the availability engine will ever offer this person a slot. */
    isBookable: z.boolean().optional(),
    acceptsWalkIns: z.boolean().optional(),
    calendarColor: hexColor.nullable().optional(),
    hiredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .optional(),
    /**
     * Assigned at creation so an employee is never briefly branch-less. Every
     * id is checked against this company before anything is written.
     */
    branchIds: z.array(uuid).max(50).optional(),
    profile: z.object(profileFields).strict().optional(),
  })
  .strict();
export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;

/**
 * `companyId` and `userAccountId` are both absent, for different reasons.
 *
 * `companyId` would be a way to move an employee between tenants. The composite
 * foreign keys would refuse it, but as a 500 rather than a refusal anyone
 * planned.
 *
 * `userAccountId` is absent because linking a login is not a profile edit — it
 * creates an account, a membership and an invitation, so it has its own
 * endpoint where those steps can be transactional and audited as one thing.
 */
export const updateEmployeeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    employeeCode: employeeCode.nullable().optional(),
    status: z.enum(['ACTIVE', 'ON_LEAVE', 'INACTIVE', 'TERMINATED']).optional(),
    isBookable: z.boolean().optional(),
    acceptsWalkIns: z.boolean().optional(),
    calendarColor: hexColor.nullable().optional(),
    hiredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .nullable()
      .optional(),
    employmentEndedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .nullable()
      .optional(),
    profile: z.object(profileFields).strict().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;

/**
 * Filtering, searching and pagination.
 *
 * `branchId` and `serviceId` filter through the join tables — the question the
 * availability engine will eventually ask ("who can do this here?") is the same
 * shape, so the query is worth getting right now rather than bolting on later.
 */
export const employeeQuerySchema = z
  .object({
    /** Matched against display name and employee code, case-insensitively. */
    search: z.string().trim().min(1).max(128).optional(),
    status: z.enum(['ACTIVE', 'ON_LEAVE', 'INACTIVE', 'TERMINATED']).optional(),
    branchId: uuid.optional(),
    serviceId: uuid.optional(),
    isBookable: z.enum(['true', 'false']).optional(),
    /** Whether the employee has a login. Useful for "who still needs an account". */
    hasAccount: z.enum(['true', 'false']).optional(),
    sortBy: z.enum(['displayName', 'employeeCode', 'createdAt', 'status']).default('displayName'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type EmployeeQueryDto = z.infer<typeof employeeQuerySchema>;

export const assignBranchSchema = z
  .object({
    branchId: uuid,
    /**
     * At most one primary branch per employee, enforced in the service. It is
     * where they are assumed to be when nothing says otherwise — which the
     * schedule engine will need and cannot infer.
     */
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type AssignBranchDto = z.infer<typeof assignBranchSchema>;

export const assignServiceSchema = z
  .object({
    serviceId: uuid,
    /** This employee takes longer, or is quicker, than the service's default. */
    durationOverrideMin: z.number().int().min(1).max(1440).nullable().optional(),
    /**
     * Minor units as a STRING. The column is BigInt and money never travels as
     * a JS number in this codebase — above 2^53 `Number` silently rounds, and a
     * price is exactly the value that must not.
     */
    priceOverrideMinor: z
      .string()
      .regex(/^\d{1,15}$/, 'Use a whole number of minor units, e.g. "4500" for 45.00.')
      .nullable()
      .optional(),
    /** 1–5, a hint for ranking rather than a rule. */
    proficiency: z.number().int().min(1).max(5).nullable().optional(),
  })
  .strict();
export type AssignServiceDto = z.infer<typeof assignServiceSchema>;

/**
 * Give an employee a login.
 *
 * Creates or reuses a `user_account`, links it, and issues an invitation — the
 * same machinery an ordinary invitation uses, so there is one account-creation
 * path and one place the rules live. The company MEMBERSHIP is created when the
 * invitation is accepted, not here: that is what accepting means. No password
 * is ever accepted or generated; the invitee sets their own.
 */
export const linkEmployeeAccountSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    /** Which system permissions they get. Unrelated to their job title. */
    roleKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).max(10),
  })
  .strict();
export type LinkEmployeeAccountDto = z.infer<typeof linkEmployeeAccountSchema>;
