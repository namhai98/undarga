import { z } from 'zod';

export const loginSchema = z.object({
  // Normalised in the schema so every consumer of LoginDto sees one form; the
  // service also calls normalizeEmail, because a DTO is not the only caller.
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(512),
});
export type LoginDto = z.infer<typeof loginSchema>;

/** Platform sign-in adds the second factor once the operator has one. */
export const platformLoginSchema = loginSchema.extend({
  mfaCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.')
    .optional(),
});
export type PlatformLoginDto = z.infer<typeof platformLoginSchema>;

export const mfaCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});
export type MfaCodeDto = z.infer<typeof mfaCodeSchema>;

// There is deliberately no refresh DTO. The refresh token arrives in an
// HttpOnly cookie the client can neither read nor write (see
// SessionCookieService), and accepting it in a body as well would reopen
// precisely what the cookie closes: a path where JavaScript holds the
// long-lived credential. The endpoint ignores its request body entirely.

export const switchCompanySchema = z.object({
  companyId: z.string().uuid(),
});
export type SwitchCompanyDto = z.infer<typeof switchCompanySchema>;
