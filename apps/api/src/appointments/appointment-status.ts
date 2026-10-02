import type { AppointmentStatus } from '@prisma/client';

/**
 * The appointment lifecycle, as data.
 *
 * Uses the schema's own `AppointmentStatus` enum rather than a parallel one.
 * HOLD and EXPIRED belong to the future public-booking payment flow and nothing
 * here produces them; CHECKED_IN has no endpoint yet but is part of the graph so
 * that a row in that state still has sensible exits.
 *
 *   PENDING ─confirm─► CONFIRMED ─start─► IN_PROGRESS ─complete─► COMPLETED
 *      │                  │  │                 │
 *      │                  │  └──no-show──► NO_SHOW
 *      └──────cancel──────┴────────cancel──────┴──► CANCELLED
 *
 * Terminal states have no exits. A status change is always a compare-and-swap
 * against the allowed FROM set (see AppointmentsService.transition), so two
 * concurrent requests cannot both succeed.
 */
export const TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  HOLD: ['PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  EXPIRED: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Every status from which `to` is reachable in one step. */
export function sourcesOf(to: AppointmentStatus): AppointmentStatus[] {
  return (Object.keys(TRANSITIONS) as AppointmentStatus[]).filter((from) =>
    canTransition(from, to),
  );
}

/** Statuses from which the appointment can still be moved to another time. */
export const RESCHEDULABLE: readonly AppointmentStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];

export function isTerminal(status: AppointmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Mirrors `sync_blocks_calendar()` in 001_hardening.sql.
 *
 * `appointment_item.blocks_calendar` is maintained by that trigger, but
 * `appointment_resource` has no such trigger — its flag must be written by the
 * application. Keeping one definition here, tested against the SQL list, is
 * what stops a cancelled booking from holding a room forever.
 */
export function blocksCalendar(status: AppointmentStatus): boolean {
  return (
    status === 'HOLD' ||
    status === 'PENDING' ||
    status === 'CONFIRMED' ||
    status === 'CHECKED_IN' ||
    status === 'IN_PROGRESS'
  );
}

/** The timestamp column a transition stamps, if any. */
export function timestampFor(
  to: AppointmentStatus,
): 'confirmedAt' | 'checkedInAt' | 'completedAt' | 'noShowAt' | 'cancelledAt' | null {
  switch (to) {
    case 'CONFIRMED':
      return 'confirmedAt';
    case 'CHECKED_IN':
      return 'checkedInAt';
    case 'COMPLETED':
      return 'completedAt';
    case 'NO_SHOW':
      return 'noShowAt';
    case 'CANCELLED':
      return 'cancelledAt';
    default:
      return null;
  }
}
