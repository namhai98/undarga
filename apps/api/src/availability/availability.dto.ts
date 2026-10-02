import { z } from 'zod';

/**
 * The availability query.
 *
 * `branchId`, `serviceId` and `date` answer the one question the endpoint
 * exists for — "what times are free for this service, at this branch, on this
 * day". `employeeId` and `resourceId` narrow it: with neither, the engine
 * searches across every eligible employee and resource; with one, it restricts
 * the search to that person or that concrete resource (still 404-scoped to the
 * company, like every id in this codebase).
 *
 * Not `.strict()` — a query string may pick up unrelated params from a proxy or
 * a link, and zod drops unknown keys rather than rejecting the request.
 */
export const availabilityQuerySchema = z.object({
  branchId: z.string().uuid(),
  serviceId: z.string().uuid(),
  /**
   * `YYYY-MM-DD`, read in the BRANCH timezone. Not an instant: "2026-09-15"
   * means that calendar day as the branch reads it, and the engine resolves it
   * against the branch zone (docs/DATABASE.md §16.4). A bare `new Date()` of
   * this string would be UTC midnight — the evening before, in Ulaanbaatar.
   */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  /** Restrict the search to one employee. Must be eligible for the service anyway. */
  employeeId: z.string().uuid().optional(),
  /** Restrict the search to one concrete resource of a required type. */
  resourceId: z.string().uuid().optional(),
  /**
   * Treat this appointment's own reservations as free — what a reschedule
   * picker needs, so moving a booking fifteen minutes is offered. Still
   * tenant-scoped: another company's id simply excludes nothing.
   */
  excludeAppointmentId: z.string().uuid().optional(),
});

export type AvailabilityQueryDto = z.infer<typeof availabilityQuerySchema>;
