import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/**
 * Appointment statuses a report can be narrowed to. HOLD and EXPIRED are
 * absent on purpose: they are seats briefly held by the public booking page,
 * never real bookings, and no report counts them.
 */
export const REPORT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const dashboardQuerySchema = z
  .object({
    /** Defaults to today in the company's timezone. */
    date: isoDate.optional(),
    branchId: uuid.optional(),
    /**
     * Accepted for older clients and ignored: "today" is the company's today,
     * worked out on the server from its timezone.
     */
    timezoneOffsetMinutes: z.coerce.number().int().min(-840).max(840).optional(),
    /** How far back "popular services", promotion and gift-card activity look. */
    popularWindowDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strict();
export type DashboardQueryDto = z.infer<typeof dashboardQuerySchema>;

/**
 * Every report takes the same filters.
 *
 * One shape, so the UI carries one filter bar across all of them. Dates are
 * calendar days in the COMPANY's timezone, inclusive at both ends. `status` is
 * a comma-separated list; omitted means every real status.
 */
export const reportQuerySchema = z
  .object({
    from: isoDate,
    /** Inclusive — the whole of this day is in the range. */
    to: isoDate,
    branchId: uuid.optional(),
    employeeId: uuid.optional(),
    serviceId: uuid.optional(),
    status: z
      .string()
      .trim()
      .max(200)
      .refine(
        (v) => v.split(',').every((s) => (REPORT_STATUSES as readonly string[]).includes(s.trim())),
        `Use a comma-separated list of: ${REPORT_STATUSES.join(', ')}.`,
      )
      .optional(),
    /** Page size for the breakdown tables (by service, employee, branch, promotion). */
    limit: z.coerce.number().int().min(1).max(100).default(10),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'The range must start before it ends.', path: ['to'] })
  .refine(
    (v) => daysBetween(v.from, v.to) <= 366,
    // A report is not an export. Anything longer is a data extract, which is
    // what `report:export` is for and what nobody has built yet.
    { message: 'Ask for at most a year at a time.', path: ['to'] },
  );
export type ReportQueryDto = z.infer<typeof reportQuerySchema>;

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}
