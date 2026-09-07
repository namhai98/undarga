import { z } from 'zod';

/**
 * Passwords: a floor on length, a ceiling for safety, and nothing else.
 *
 * No composition rules. Length is what resists guessing; requiring a symbol and
 * a digit mostly produces `Password1!` and pushes people towards reuse, which
 * is the actual risk. NIST 800-63B reaches the same conclusion.
 *
 * The 512 ceiling is not a policy, it is a denial-of-service guard: argon2
 * hashes whatever it is given, and a megabyte-long password is CPU somebody
 * else pays for.
 *
 * The minimum here is the CONFIGURED floor's lower bound; the service applies
 * `PASSWORD_MIN_LENGTH`, which may be higher. Validating the floor in the
 * schema too means an obviously-too-short password is refused without the
 * request reaching a service, and without an argon2 hash being computed.
 */
const password = z.string().min(12, 'Use at least 12 characters.').max(512);

/** Trimmed and lowercased so `User@Example.COM` cannot become a second account. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(320);

/** Opaque, high-entropy, and always carried in a body — never a URL path. */
const linkToken = z.string().min(16).max(512);

export const requestEmailVerificationSchema = z.object({ email });
export type RequestEmailVerificationDto = z.infer<typeof requestEmailVerificationSchema>;

export const verifyEmailSchema = z.object({ token: linkToken });
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;

export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: linkToken,
  newPassword: password,
});
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  // No minimum on the CURRENT password: it is checked against the stored hash,
  // and applying today's policy to it would lock out anyone whose password
  // predates a policy change.
  currentPassword: z.string().min(1, 'Enter your current password.').max(512),
  newPassword: password,
});
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

/**
 * What a user may change about themselves.
 *
 * An explicit allow-list, and that is the point: `status`, `emailVerifiedAt`
 * and `passwordHash` all live on the same table, and a schema that accepted
 * unknown keys would let a PATCH set them. `.strict()` rejects anything not
 * listed rather than silently dropping it, so an attempt is a 400 the client
 * can see rather than a no-op the attacker can retry differently.
 *
 * Email is absent deliberately: changing the address you sign in with must
 * re-verify the new one, which is a flow of its own and not a profile edit.
 */
export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(1).max(128).optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    locale: z.string().min(2).max(12).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
