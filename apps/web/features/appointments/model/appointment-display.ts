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
    case 'SLOT_UNAVAILABLE':
      return 'That time is no longer available. The list has been refreshed — please pick another slot.';
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
