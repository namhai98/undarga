import { z } from 'zod';

/**
 * Slugs that must never belong to a tenant.
 *
 * The slug is a tenant-resolution key: it is matched by the subdomain resolver
 * (`acme.booking.local` -> `acme`) and appears in URLs. A company that managed
 * to claim `api`, `www` or `admin` would sit on a hostname the platform itself
 * needs, and `platform` would let a tenant page impersonate the operator
 * console. Cheap to refuse up front, expensive to take back afterwards —
 * the slug is immutable once other systems have cached it.
 */
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'cdn',
  'dashboard',
  'docs',
  'ftp',
  'help',
  'internal',
  'login',
  'mail',
  'platform',
  'public',
  'root',
  'static',
  'status',
  'support',
  'system',
  'undarga',
  'www',
]);

/**
 * Lowercase, digits and single inner hyphens.
 *
 * Anchored at both ends and forbidding a leading or trailing hyphen, because
 * this has to be a valid DNS label: it becomes a subdomain the moment
 * TENANT_RESOLVER_SUBDOMAIN is switched on.
 */
const slug = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Slug must be lowercase letters, digits and hyphens, and may not start or end with a hyphen.',
  )
  .refine((value) => !RESERVED_SLUGS.has(value), {
    message: 'That slug is reserved by the platform.',
  });

export const provisionCompanySchema = z.object({
  slug,
  legalName: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(160),

  /**
   * Both are foreign keys to reference tables. Existence is checked in the
   * service rather than here — zod cannot see the database, and letting the
   * FK fail would surface as a 500 instead of naming the bad field.
   */
  defaultTimezoneName: z.string().min(1).max(64),
  currencyCode: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Currency must be an uppercase ISO 4217 code, e.g. MNT.'),

  locale: z.string().min(2).max(12).optional(),
  registrationNumber: z.string().trim().max(64).optional(),
  taxNumber: z.string().trim().max(64).optional(),
  contactEmail: z.string().email().max(320).optional(),
  contactPhone: z.string().trim().max(32).optional(),

  /**
   * The first owner.
   *
   * Required: a company with no owner is unadministrable, and there is no
   * self-serve signup to create one later. Provisioning is the only place
   * `isOwner: true` is ever written.
   */
  owner: z.object({
    email: z.string().email().max(320),
    fullName: z.string().trim().min(1).max(128),
  }),
});

export type ProvisionCompanyDto = z.infer<typeof provisionCompanySchema>;
