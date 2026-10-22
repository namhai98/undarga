import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * The four states a company can be in.
 *
 * ---------------------------------------------------------------------------
 * THE BRIEF'S "DISABLED" IS THIS SCHEMA'S `CANCELED`
 * ---------------------------------------------------------------------------
 *
 * `company_status` is `PENDING_SETUP | ACTIVE | SUSPENDED | CANCELED` and has
 * been since the first migration. `CANCELED` is the terminal "switched off"
 * state the brief calls DISABLED; the enum is not renamed because
 * `MembershipService`, `operationalStatus`, the seeds and the isolation suite
 * all key on the existing value, and a rename buys nothing but churn.
 *
 * `PENDING_SETUP` is a real fourth state, not noise: a company exists from the
 * moment it is provisioned, and its owner has not accepted their invitation
 * yet. An operator console that hid it would show a shorter list than the
 * database has and look broken the first time somebody counted.
 */
export const COMPANY_STATUSES = ['PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'CANCELED'] as const;
export type CompanyStatusValue = (typeof COMPANY_STATUSES)[number];

/**
 * Note the spelling: `SubscriptionStatus` is CANCELLED with two Ls while
 * `CompanyStatus` is CANCELED with one. Both spellings are pre-existing and
 * each is matched exactly here; unifying them is a migration this module has no
 * business making.
 */
export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
] as const;

export const companyListQuerySchema = z
  .object({
    /** Matches display name, legal name, slug and contact email. */
    search: z.string().trim().min(1).max(160).optional(),
    status: z.enum(COMPANY_STATUSES).optional(),
    subscriptionStatus: z.enum(SUBSCRIPTION_STATUSES).optional(),
    planKey: z.string().trim().min(1).max(32).optional(),
    /** Companies created on or after this date, as YYYY-MM-DD. */
    createdFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    createdTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    sortBy: z.enum(['createdAt', 'displayName', 'status']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type CompanyListQueryDto = z.infer<typeof companyListQuerySchema>;

/**
 * Changing a company's status.
 *
 * ---------------------------------------------------------------------------
 * A REASON IS MANDATORY
 * ---------------------------------------------------------------------------
 *
 * Suspending a company stops every member of its staff working and every
 * customer booking. Six months later somebody will ask why, and "an operator
 * clicked it" is not an answer. The reason goes into the audit row, which is
 * append-only and hash-chained.
 *
 * `PENDING_SETUP` is deliberately not a target. It means "provisioned, owner
 * has not accepted", which is a fact about history rather than a state anybody
 * can put a company back into.
 */
export const changeCompanyStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELED']),
    reason: z.string().trim().min(5, 'Say why — this goes on the audit trail.').max(512),
  })
  .strict();
export type ChangeCompanyStatusDto = z.infer<typeof changeCompanyStatusSchema>;

export const companyUsersQuerySchema = z
  .object({
    /** The shared UserStatus enum, which user_account uses too. */
    status: z.enum(['INVITED', 'ACTIVE', 'DISABLED', 'LOCKED']).optional(),
    search: z.string().trim().min(1).max(160).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type CompanyUsersQueryDto = z.infer<typeof companyUsersQuerySchema>;

export const auditLogQuerySchema = z
  .object({
    /** Narrow to one tenant. Omit to see platform-wide activity. */
    companyId: uuid.optional(),
    /** Exact dotted verb, e.g. `platform.company.suspended`. */
    action: z.string().trim().min(1).max(96).optional(),
    actorType: z
      .enum(['PLATFORM_USER', 'COMPANY_USER', 'CUSTOMER', 'SYSTEM', 'API_KEY'])
      .optional(),
    actorId: uuid.optional(),
    resourceType: z.string().trim().min(1).max(48).optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type AuditLogQueryDto = z.infer<typeof auditLogQuerySchema>;

export const platformDashboardQuerySchema = z
  .object({
    /** How far back "recent" reaches for the activity counts. */
    windowDays: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();
export type PlatformDashboardQueryDto = z.infer<typeof platformDashboardQuerySchema>;
