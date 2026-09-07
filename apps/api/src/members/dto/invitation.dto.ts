import { z } from 'zod';

/**
 * Roles are named by KEY, not by id.
 *
 * `company_role.key` is unique per company (a partial unique index in
 * 001_hardening.sql), so a key identifies exactly one role within the tenant
 * the request is already scoped to — there is no ambiguity to resolve and no
 * cross-tenant id to smuggle in. It is also the only usable option today: there
 * is no endpoint that lists roles yet, so an id-based API would be
 * undiscoverable. Ids can be accepted alongside keys later without breaking
 * this shape.
 */
const roleKey = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Role keys are uppercase, e.g. ADMIN or BRANCH_MANAGER.');

export const createInvitationSchema = z.object({
  email: z.string().email().max(320),
  /**
   * At least one. An invitation granting nothing would create a member who can
   * see the company exists and do nothing in it, which is never what the
   * inviter meant — and it hides a mistake rather than reporting it.
   */
  roleKeys: z.array(roleKey).min(1).max(10),
  /**
   * Overrides INVITATION_TTL_DAYS for this invitation. Capped at 30 days: a
   * link that outlives the reason it was sent is a credential nobody is
   * tracking any more.
   */
  expiresInDays: z.number().int().min(1).max(30).optional(),
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

export const rotateInvitationSchema = z.object({
  expiresInDays: z.number().int().min(1).max(30).optional(),
});
export type RotateInvitationDto = z.infer<typeof rotateInvitationSchema>;

export const listInvitationsSchema = z.object({
  /** `live` is the default because a revoked invitation is rarely interesting. */
  status: z.enum(['live', 'all']).default('live'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListInvitationsDto = z.infer<typeof listInvitationsSchema>;

/**
 * The token travels in the BODY, never in the path.
 *
 * `POST /invitations/{token}/accept` reads naturally and is what most sketches
 * of this flow show, but a URL is the least private part of an HTTP request:
 * it lands in access logs, proxy logs, browser history and the `Referer`
 * header of every subsequent request from the page. A one-time credential must
 * not be written down in four places on the way in.
 *
 * The user-facing LINK is still `{WEB_APP_URL}/invitations/accept?token=…` —
 * the web app reads it from the query string and posts it here. That URL is
 * only ever handled by the frontend origin, which logs nothing.
 */
const invitationToken = z.string().min(16).max(512);

export const previewInvitationSchema = z.object({ token: invitationToken });
export type PreviewInvitationDto = z.infer<typeof previewInvitationSchema>;

export const acceptInvitationSchema = z.object({
  token: invitationToken,
  /**
   * Required only when the address has no account yet — the service decides,
   * because it is the only side that knows. Validating it here would mean
   * telling an anonymous caller whether an email is registered.
   */
  fullName: z.string().trim().min(1).max(128).optional(),
  /**
   * 12 characters minimum, with no composition rules.
   *
   * Length is the property that actually resists guessing; forced symbol
   * classes mostly produce `Password1!`. NIST 800-63B says the same. The upper
   * bound exists because argon2 hashes whatever it is given and a megabyte-long
   * password is a denial-of-service vector, not a security feature.
   */
  password: z.string().min(12).max(512).optional(),
});
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;
