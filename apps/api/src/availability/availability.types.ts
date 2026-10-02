/**
 * The vocabulary of the availability domain.
 *
 * Split into three layers, in dependency order:
 *
 *   1. The ENGINE input/output — plain numbers and ids, no Prisma, no Nest, no
 *      timezone. `availability.engine.ts` is a pure function over these and is
 *      unit-tested with hand-built fixtures.
 *   2. The RESOLVED shape the repository produces from the database.
 *   3. The API RESULT the controller returns.
 */

import type { Interval } from './interval';

// ===========================================================================
// 1 · Engine
// ===========================================================================

/** One employee's working windows and the intervals they are already committed. */
export interface EmployeeAvailabilityInput {
  readonly employeeId: string;
  /** Instants the employee is rostered and not on break — already net of breaks. */
  readonly workWindows: readonly Interval[];
  /** Instants the employee is unavailable: time off, and buffered bookings. */
  readonly busy: readonly Interval[];
}

/** One concrete resource and the intervals it is already committed. */
export interface ResourceAvailabilityInput {
  readonly resourceId: string;
  /** Buffered reservations that block this resource. */
  readonly busy: readonly Interval[];
}

/**
 * A service's need for `quantity` resources of a given type, and the concrete
 * resources in that pool. A slot is resource-feasible only if EVERY group can
 * field `quantity` free members.
 */
export interface ResourceRequirementInput {
  readonly resourceTypeId: string;
  readonly quantity: number;
  readonly pool: readonly ResourceAvailabilityInput[];
}

export interface AvailabilityEngineInput {
  /**
   * The branch's operating windows for the date as instants — business hours
   * minus closures, both overnight halves already flattened. Empty means the
   * branch is closed; the engine returns no slots without inspecting anything
   * else.
   */
  readonly businessWindows: readonly Interval[];
  /**
   * Windows the service itself may be booked in (service_availability_rule).
   * `null` means "whenever the branch is open".
   */
  readonly serviceWindows: readonly Interval[] | null;

  /** Instant that candidate starts are aligned to — local midnight of the date. */
  readonly gridAnchor: number;
  readonly slotIntervalMs: number;
  readonly serviceDurationMs: number;
  readonly bufferBeforeMs: number;
  readonly bufferAfterMs: number;

  /** No slot may start before this instant (now + booking lead time). */
  readonly earliestStart: number;

  readonly requiresEmployee: boolean;
  readonly requiresResource: boolean;

  readonly employees: readonly EmployeeAvailabilityInput[];
  readonly resourceRequirements: readonly ResourceRequirementInput[];
}

export interface AvailabilitySlot {
  /** Instant the appointment would start / end (epoch ms). */
  readonly startAt: number;
  readonly endAt: number;
  /**
   * The wider window the booking actually occupies once buffers are counted —
   * what the exclusion constraint will guard. `reservedStart <= startAt` and
   * `reservedEnd >= endAt`.
   */
  readonly reservedStart: number;
  readonly reservedEnd: number;
  /**
   * Every employee who could take this slot. Not an assignment — the
   * Appointment Engine picks one. Empty iff the service needs no employee.
   * Sorted for determinism.
   */
  readonly employeeIds: readonly string[];
  /**
   * Every resource that could satisfy a requirement for this slot, deduplicated
   * across groups and sorted. Empty iff the service needs no resource.
   */
  readonly resourceIds: readonly string[];
}

// ===========================================================================
// 2 · Resolved (repository → service)
// ===========================================================================

/** Why a query produced no slots for structural rather than date reasons. */
export type AvailabilityUnavailableReason =
  | 'BRANCH_CLOSED'
  | 'SERVICE_NOT_OFFERED_AT_BRANCH'
  | 'NO_ELIGIBLE_EMPLOYEE'
  | 'NO_ELIGIBLE_RESOURCE'
  | 'DATE_IN_PAST'
  | 'BEYOND_BOOKING_WINDOW';

export interface ResolvedBranch {
  readonly id: string;
  readonly timezoneName: string;
  readonly slotIntervalMin: number;
  readonly bookingLeadTimeMin: number;
  readonly maxAdvanceBookingDays: number;
}

export interface ResolvedService {
  readonly id: string;
  readonly durationMin: number;
  readonly bufferBeforeMin: number;
  readonly bufferAfterMin: number;
  readonly requiresEmployee: boolean;
  readonly requiresResource: boolean;
  readonly isOnlineBookable: boolean;
}

// ===========================================================================
// 3 · API result
// ===========================================================================

export interface AvailabilitySlotDto {
  readonly startAt: string;
  readonly endAt: string;
  readonly reservedFrom: string;
  readonly reservedTo: string;
  readonly available: true;
  readonly employeeIds: readonly string[];
  readonly resourceIds: readonly string[];
}

export interface AvailabilityDayDto {
  readonly date: string;
  readonly timezone: string;
  readonly branchId: string;
  readonly serviceId: string;
  readonly slotIntervalMin: number;
  readonly serviceDurationMin: number;
  readonly bufferBeforeMin: number;
  readonly bufferAfterMin: number;
  /** Present only when `slots` is empty and the reason is structural. */
  readonly unavailableReason: AvailabilityUnavailableReason | null;
  readonly slots: readonly AvailabilitySlotDto[];
}
