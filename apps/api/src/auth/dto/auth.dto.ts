import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});
export type LoginDto = z.infer<typeof loginSchema>;

// There is deliberately no refresh DTO. The refresh token arrives in an
// HttpOnly cookie the client can neither read nor write (see
// SessionCookieService), and accepting it in a body as well would reopen
// precisely what the cookie closes: a path where JavaScript holds the
// long-lived credential. The endpoint ignores its request body entirely.

export const switchCompanySchema = z.object({
  companyId: z.string().uuid(),
});
export type SwitchCompanyDto = z.infer<typeof switchCompanySchema>;
