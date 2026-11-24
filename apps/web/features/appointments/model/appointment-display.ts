import type { AppointmentStatus, StatusAction } from '@/services/appointments.service';
import { ApiError } from '@/services/api-error';

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  HOLD: 'On hold',
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
  EXPIRED: 'Expired',
};

/**
 * Which buttons to SHOW for a status.
 *
 * A convenience only — it keeps the screen from offering actions that would
 * certainly be refused. The server's transition graph is the authority and
 * answers anything else with INVALID_STATUS_TRANSITION.
 */
export const ACTIONS_BY_STATUS: Record<
  AppointmentStatus,
  { actions: StatusAction[]; cancel: boolean; reschedule: boolean }
> = {
  HOLD: { actions: [], cancel: true, reschedule: false },
  PENDING: { actions: ['confirm', 'no-show'], cancel: true, reschedule: true },
  CONFIRMED: { actions: ['start', 'no-show'], cancel: true, reschedule: true },
  CHECKED_IN: { actions: ['start', 'no-show'], cancel: true, reschedule: true },
  IN_PROGRESS: { actions: ['complete'], cancel: true, reschedule: false },
  COMPLETED: { actions: [], cancel: false, reschedule: false },
  CANCELLED: { actions: [], cancel: false, reschedule: false },
  NO_SHOW: { actions: [], cancel: false, reschedule: false },
  EXPIRED: { actions: [], cancel: false, reschedule: false },
};

export const ACTION_LABEL: Record<StatusAction, string> = {
  confirm: 'Confirm',
  start: 'Start',
  complete: 'Complete',
  'no-show': 'Mark no-show',
};

export function isLive(status: AppointmentStatus): boolean {
  return ['HOLD', 'PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'].includes(status);
}

/** `2026-10-06T09:00:00+08:00` → `2026-10-06`. The branch's own calendar date. */
export function localDate(iso: string): string {
  return iso.slice(0, 10);
}

/** `2026-10-06T09:00:00+08:00` → `09:00`. The branch's own wall-clock time. */
export function localTime(iso: string): string {
  return iso.slice(11, 16);
}

/** Today in the viewer's calendar, as `YYYY-MM-DD` — a sensible default only. */
export function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Human copy for the errors a booking screen should explain, not just show. */
export function bookingErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'SLOT_TAKEN':
      return 'Someone booked that time a moment ago. The list has been refreshed — please pick another slot.';
    case 'SLOT_UNAVAILABLE': {
      // A rule or an absence: the server's sentence says which, in plain words.
      const reason = typeof error.details?.reason === 'string' ? error.details.reason : '';
      return SLOT_REASON_MESSAGE[reason]
        ? SLOT_REASON_MESSAGE[reason](error.details ?? {})
        : 'That time is no longer available. The list has been refreshed — please pick another slot.';
    }
    case 'BOOKING_RULE_VIOLATION':
    case 'TIME_OFF_CONFLICT':
    case 'SERIES_CONFLICT':
      return error.message;
    case 'INVALID_STATUS_TRANSITION':
      return 'This appointment has changed since you opened it. Reload to see its current status.';
    case 'SERVICE_NOT_BOOKABLE':
      return 'This service is not currently bookable.';
    case 'PROMOTION_NOT_APPLICABLE':
      return `The promotion code could not be applied: ${error.message} Nothing was booked.`;
    case 'VALIDATION_FAILED':
    case 'RESOURCE_NOT_FOUND':
      return error.message;
    default:
      return fallback;
  }
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Notice in the largest whole unit: 90 → "90 minutes", 1440 → "1 day". */
export function describeNotice(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes > 0 && minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

/** Why a time cannot be booked — the reasons the server reports in `details.reason`. */
const SLOT_REASON_MESSAGE: Record<string, (d: Record<string, unknown>) => string> = {
  MINIMUM_NOTICE: (d) =>
    typeof d.minimumNoticeMinutes === 'number'
      ? `That time is too soon. Bookings need at least ${describeNotice(d.minimumNoticeMinutes)} notice.`
      : 'That time is too soon: bookings need more notice.',
  BEYOND_BOOKING_WINDOW: (d) =>
    typeof d.maximumAdvanceDays === 'number'
      ? `That date is too far ahead. Bookings open ${plural(d.maximumAdvanceDays, 'day')} in advance.`
      : 'That date is too far ahead to book yet.',
  DATE_IN_PAST: () => 'That time has already passed.',
  EMPLOYEE_TIME_OFF: () => 'The chosen staff member is away (time off) at that time.',
  EMPLOYEE_NOT_AVAILABLE: () => 'The chosen staff member is not available at that time.',
  RESOURCE_UNAVAILABLE: () =>
    'The room or equipment this service needs is unavailable at that time (maintenance or blocked).',
  RESOURCE_NOT_AVAILABLE: () => 'No room or equipment this service needs is free at that time.',
  MAX_CONCURRENT_BOOKINGS: (d) =>
    typeof d.maxConcurrentBookings === 'number'
      ? `This service is fully booked at that time (at most ${d.maxConcurrentBookings} at once).`
      : 'This service is fully booked at that time.',
  BRANCH_CLOSED: () => 'The branch is closed at that time.',
  NO_ELIGIBLE_EMPLOYEE: () => 'Nobody who provides this service is free at that time.',
};

/** The deadline rule a refused cancel / reschedule hit, if any. */
export function ruleViolation(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'BOOKING_RULE_VIOLATION') return null;
  return typeof error.details?.rule === 'string' ? error.details.rule : null;
}

/** Plain words for a series occurrence that cannot be booked. */
export function occurrenceReason(reason: string | null, message: string | null): string {
  if (reason && SLOT_REASON_MESSAGE[reason]) return SLOT_REASON_MESSAGE[reason]({});
  if (reason === 'SLOT_TAKEN') return 'Already booked at that time.';
  return message ?? 'Cannot be booked.';
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function describeRecurrence(r: {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  weekdays: number[];
  endDate: string | null;
  count: number | null;
}): string {
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' }[r.frequency];
  const every = r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
  const days =
    r.frequency === 'WEEKLY' && r.weekdays.length
      ? ` on ${r.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ')}`
      : '';
  const end = r.endDate ? `, until ${r.endDate}` : r.count ? `, ${plural(r.count, 'time')}` : '';
  return `${every}${days}${end}`;
}
