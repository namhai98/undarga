import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(512),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

export const switchCompanySchema = z.object({
  companyId: z.string().uuid(),
});
export type SwitchCompanyDto = z.infer<typeof switchCompanySchema>;
