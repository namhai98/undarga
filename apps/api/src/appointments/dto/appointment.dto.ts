import { z } from 'zod';
import { promotionCode } from '../../promotions/dto/promotion.dto';

/**
 * An instant, with an explicit offset or `Z`.
 *
 * The client echoes back a `startAt` it received from the availability
 * endpoint (`2026-10-06T09:00:00+08:00`). A bare local string such as
 * `2026-10-06T09:00` is refused: without an offset it names no instant, and
 * guessing the server's zone is exactly the bug this codebase avoids.
 */
const instant = z.string().datetime({ offset: true, message: 'Use an ISO-8601 instant with an offset.' });

const note = z.string().trim().max(2000);

export const bookingSources = ['ONLINE', 'WALK_IN', 'PHONE', 'STAFF', 'API', 'IMPORT'] as const;
export const appointmentStatuses = [
  'HOLD',
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'EXPIRED',
] as const;

/**
 * Create an appointment.
 *
 * No `endsAt`, no price, no status: the server derives all three from the
 * service, the company's policy and the clock. `companyId` is absent because it
 * comes from the resolved tenant.
 */
export const createAppointmentSchema = z
  .object({
    branchId: z.string().uuid(),
    customerId: z.string().uuid(),
    serviceId: z.string().uuid(),
    employeeId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
    startsAt: instant,
    source: z.enum(bookingSources).default('STAFF'),
    customerNote: note.nullable().optional(),
    internalNote: note.nullable().optional(),
    /**
     * A promotion code. Validated, priced and its usage consumed inside the
     * booking transaction; if it cannot be honoured the booking is refused
     * (PROMOTION_NOT_APPLICABLE) rather than taken at another price.
     */
    promotionCode: promotionCode.optional(),
  })
  .strict();
export type CreateAppointmentDto = z.infer<typeof createAppointmentSchema>;

/**
 * Move an appointment. Branch, service and customer carry over — changing any
 * of those is a different booking, not the same one at another time.
 */
export const rescheduleAppointmentSchema = z
  .object({
    startsAt: instant,
    employeeId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
    // Stored as `RESCHEDULED: <reason>` in a 512-character column.
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type RescheduleAppointmentDto = z.infer<typeof rescheduleAppointmentSchema>;

export const cancelAppointmentSchema = z
  .object({
    reason: z.string().trim().min(1, 'A cancellation reason is required.').max(512),
  })
  .strict();
export type CancelAppointmentDto = z.infer<typeof cancelAppointmentSchema>;

/** Optional note on a status change (confirm, start, complete, no-show). */
export const statusChangeSchema = z
  .object({ reason: z.string().trim().max(512).optional() })
  .strict()
  .default({});
export type StatusChangeDto = z.infer<typeof statusChangeSchema>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const appointmentQuerySchema = z
  .object({
    branchId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
    serviceId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    /** Comma-separated, e.g. `PENDING,CONFIRMED`. */
    status: z
      .string()
      .refine(
        (v) =>
          v
            .split(',')
            .every((s) => (appointmentStatuses as readonly string[]).includes(s.trim())),
        { message: `Use one or more of: ${appointmentStatuses.join(', ')}.` },
      )
      .optional(),
    /**
     * Inclusive UTC calendar-date bounds on `startsAt`. A branch-local day is
     * not used here because a list may span branches in different zones.
     */
    from: date.optional(),
    to: date.optional(),
    /** Matches the appointment number. */
    search: z.string().trim().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  });
export type AppointmentQueryDto = z.infer<typeof appointmentQuerySchema>;

export function parseStatuses(value: string | undefined) {
  return value
    ? (value.split(',').map((s) => s.trim()) as Array<(typeof appointmentStatuses)[number]>)
    : undefined;
}
