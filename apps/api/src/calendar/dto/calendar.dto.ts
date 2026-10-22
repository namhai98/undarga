import { z } from 'zod';

export const startOAuthSchema = z
  .object({
    provider: z.enum(['google', 'microsoft']),
    employeeId: z.string().uuid(),
  })
  .strict();
export type StartOAuthDto = z.infer<typeof startOAuthSchema>;

/** What the web app's /calendar/callback page posts back: the provider's `code` and our `state`. */
export const completeOAuthSchema = z
  .object({
    state: z.string().min(20).max(200),
    code: z.string().min(1).max(4096),
  })
  .strict();
export type CompleteOAuthDto = z.infer<typeof completeOAuthSchema>;

export const updateConnectionSchema = z
  .object({
    /** One of the ids from GET …/calendars. */
    calendarId: z.string().min(1).max(512).optional(),
    syncCompleted: z.boolean().optional(),
    useForAvailability: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change.');
export type UpdateConnectionDto = z.infer<typeof updateConnectionSchema>;
