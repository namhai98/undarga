import { z } from 'zod';

/**
 * Slugs that must never belong to a tenant.
 *
 * Shared with provisioning: the slug is a tenant-resolution key matched by the
 * subdomain resolver, so a company holding `api` or `admin` would sit on a
 * hostname the platform needs.
 */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'billing', 'cdn', 'dashboard', 'docs',
  'ftp', 'help', 'internal', 'login', 'mail', 'platform', 'public', 'root',
  'static', 'status', 'support', 'system', 'undarga', 'www',
]);

/**
 * Turn a display name into a candidate slug.
 *
 * `My Beauty Studio` -> `my-beauty-studio`. Diacritics are folded rather than
 * dropped, so `Ünder` becomes `under` and not `nder`.
 *
 * This only ever SUGGESTS. Nothing calls it to silently rewrite a slug a caller
 * supplied — the caller either sends a valid slug or gets a 400 naming the
 * problem, because a slug that quietly differs from what was typed is a support
 * ticket six months later when somebody's bookmarks stop working.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * Anchored, and no leading or trailing hyphen, because this has to be a valid
 * DNS label — it becomes a subdomain the moment TENANT_RESOLVER_SUBDOMAIN is
 * switched on.
 */
export const companySlug = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Use lowercase letters, digits and hyphens; it may not start or end with a hyphen.',
  )
  .refine((value) => !RESERVED_SLUGS.has(value), {
    message: 'That slug is reserved by the platform.',
  });

/** IANA identifier. Existence is checked against the `timezone` table. */
const timezoneName = z.string().min(1).max(64);
/** ISO 4217. Existence is checked against the `currency` table. */
const currencyCode = z.string().length(3).regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code.');

/**
 * What a company administrator may change about their own company.
 *
 * `.strict()`, and the omissions are the point:
 *
 *   slug     — a tenant-resolution key, cached by TenantDirectoryService and
 *              baked into links people have saved. Changing it is a migration,
 *              not a settings edit.
 *   status   — lifecycle, moved by the dedicated endpoint so the transition can
 *              be validated and audited as such. A company must not be able to
 *              un-suspend itself with a PATCH.
 *   currency — every stored amount is in it. Changing it after money exists
 *              would silently reinterpret history.
 */
export const updateCompanySchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    legalName: z.string().trim().min(1).max(160).optional(),
    registrationNumber: z.string().trim().max(64).nullable().optional(),
    taxNumber: z.string().trim().max(64).nullable().optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    contactPhone: z.string().trim().max(32).nullable().optional(),
    defaultTimezoneName: timezoneName.optional(),
    locale: z.string().min(2).max(12).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

/**
 * Booking policy defaults for the whole company.
 *
 * Only the shape and the bounds live here — what any of these MEAN is the
 * scheduling engine's problem, and it does not exist yet. The bounds mirror the
 * `settings_bps_range` CHECK constraint so a bad value is a 400 naming the
 * field rather than a 500 from the database.
 */
export const updateCompanySettingsSchema = z
  .object({
    slotGranularityMin: z.number().int().min(5).max(240).optional(),
    bookingLeadTimeMin: z.number().int().min(0).max(10_080).optional(),
    maxAdvanceBookingDays: z.number().int().min(1).max(730).optional(),
    cancellationWindowHours: z.number().int().min(0).max(720).optional(),
    holdTtlSeconds: z.number().int().min(60).max(3_600).optional(),
    autoConfirmBookings: z.boolean().optional(),
    allowOnlineBooking: z.boolean().optional(),
    allowCustomerCancel: z.boolean().optional(),
    allowCustomerReschedule: z.boolean().optional(),
    requireDeposit: z.boolean().optional(),
    // Basis points: 10000 = 100%. Integers, never floats — see the money note
    // in docs/DATABASE.md.
    depositPercentBps: z.number().int().min(0).max(10_000).optional(),
    noShowFeePercentBps: z.number().int().min(0).max(10_000).optional(),
    lateCancelFeePercentBps: z.number().int().min(0).max(10_000).optional(),
    reminderOffsetsMinutes: z.array(z.number().int().min(0).max(20_160)).max(5).optional(),
    defaultLocale: z.string().min(2).max(12).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateCompanySettingsDto = z.infer<typeof updateCompanySettingsSchema>;

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. The column is VarChar(9). */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Use a hex colour, e.g. #0F6B63.');

/**
 * Booking-page appearance.
 *
 * File ids are absent on purpose: uploading a logo needs the file module, which
 * is not built. When it is, `logoFileId` joins this schema and the composite
 * foreign key on `(company_id, file_id)` already makes pointing at another
 * tenant's file unrepresentable.
 *
 * `customCss` is also absent, and that one is a security decision rather than
 * sequencing — arbitrary CSS on a page that renders customer data is a
 * data-exfiltration primitive (attribute selectors plus `background-image` read
 * input values out). It stays unreachable until there is a sanitiser and a
 * reason.
 */
export const updateCompanyBrandingSchema = z
  .object({
    primaryColor: hexColor.optional(),
    accentColor: hexColor.optional(),
    backgroundColor: hexColor.optional(),
    fontFamily: z.string().trim().max(96).nullable().optional(),
    bookingPageHeadline: z.string().trim().max(160).nullable().optional(),
    bookingPageBlurb: z.string().trim().max(1000).nullable().optional(),
    emailFromName: z.string().trim().max(96).nullable().optional(),
    emailReplyTo: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateCompanyBrandingDto = z.infer<typeof updateCompanyBrandingSchema>;

/**
 * Deactivation is the ONLY lifecycle move a company can make about itself, and
 * it is one-way.
 *
 * `SUSPENDED` is a platform decision — usually non-payment — so a company able
 * to set or clear it would make it meaningless. `PENDING_SETUP` is where
 * provisioning starts, not somewhere to return to.
 *
 * `ACTIVE` is absent for a harder reason than policy: it is unreachable.
 * `MembershipService` treats a CANCELED company as not found, so the moment a
 * company cancels, every one of its members is locked out — including the owner
 * who would have to ask for it back. Offering "reactivate" on a tenant-scoped
 * route would advertise a state no caller can ever be in. Reactivation is
 * therefore a platform operation, and it is not built yet.
 */
export const deactivateCompanySchema = z
  .object({
    reason: z.string().trim().max(256).optional(),
  })
  .strict();
export type DeactivateCompanyDto = z.infer<typeof deactivateCompanySchema>;

export { currencyCode, timezoneName };
