import { apiClient } from './api-client';

/**
 * Why a day resolved to no slots for a structural reason (as opposed to the day
 * simply being full, which is `unavailableReason: null` with `slots: []`).
 */
export type AvailabilityUnavailableReason =
  | 'BRANCH_CLOSED'
  | 'SERVICE_NOT_OFFERED_AT_BRANCH'
  | 'NO_ELIGIBLE_EMPLOYEE'
  | 'NO_ELIGIBLE_RESOURCE'
  | 'DATE_IN_PAST'
  | 'BEYOND_BOOKING_WINDOW';

export interface AvailabilitySlot {
  /** ISO-8601 WITH the branch offset, e.g. `2026-09-15T09:00:00+08:00`. */
  startAt: string;
  endAt: string;
  /** The wider window the booking occupies once buffers count — for display only. */
  reservedFrom: string;
  reservedTo: string;
  available: true;
  /**
   * Every employee who could take this slot — candidates, not an assignment.
   * Empty when the service needs no employee.
   */
  employeeIds: string[];
  /** Every resource that could satisfy the slot. Empty when none is needed. */
  resourceIds: string[];
}

export interface AvailabilityDay {
  date: string;
  /** IANA zone the `date` and every slot instant are expressed in. */
  timezone: string;
  branchId: string;
  serviceId: string;
  slotIntervalMin: number;
  serviceDurationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  unavailableReason: AvailabilityUnavailableReason | null;
  slots: AvailabilitySlot[];
}

export interface AvailabilityQuery {
  branchId: string;
  serviceId: string;
  /** `YYYY-MM-DD`, read in the branch timezone. */
  date: string;
  employeeId?: string;
  resourceId?: string;
  /** Rescheduling: do not count this appointment as busy against itself. */
  excludeAppointmentId?: string;
}

/**
 * Bookable slots for a service at a branch on a date.
 *
 * Read-only and advisory: the server recomputes on every call and a slot can be
 * taken between reading it here and booking it. The frontend never generates
 * slots itself — the backend is authoritative (docs/ARCHITECTURE-RULES.md rule
 * 3).
 */
export const availabilityService = {
  getDay: (companyId: string, query: AvailabilityQuery, signal?: AbortSignal) =>
    apiClient.get<AvailabilityDay>(`/companies/${companyId}/availability`, {
      query: { ...query },
      signal,
    }),
};
