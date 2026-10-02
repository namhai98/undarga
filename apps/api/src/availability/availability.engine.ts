/**
 * The availability calculation, as one pure function.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * IN:  instants and durations, already resolved from the database and already
 *      converted out of wall-clock time by the caller.
 * OUT: the bookable slots, each carrying every employee and resource that could
 *      fulfil it — candidates, never assignments.
 *
 * It creates nothing, reads nothing, and knows no timezone. That is deliberate
 * (docs/ARCHITECTURE-RULES.md rule 1): the same function has to be callable
 * from the HTTP path, from a future public booking endpoint, from a job, and
 * from a test with no server. Everything stateful — the queries, the tenant
 * context, the cache — lives in the service and repository around it.
 *
 * ---------------------------------------------------------------------------
 * THE PIPELINE
 * ---------------------------------------------------------------------------
 *
 *   businessWindows ─┐
 *   serviceWindows  ─┼─► candidate starts on the slot grid
 *   grid + lead time ┘        │
 *                             ▼
 *              appointment interval + buffered interval
 *                             │
 *                 ┌───────────┼───────────┐
 *                 ▼           ▼           ▼
 *            employee     resource    (nothing, if the
 *            feasible?    feasible?    service needs neither)
 *                 └───────────┼───────────┘
 *                             ▼
 *                    slot + eligible candidates
 *
 * Database access is not in this loop — the caller has already loaded every
 * interval it needs (docs/DATABASE.md §24, no query per slot).
 */

import {
  anyContains,
  anyOverlaps,
  merge,
  type Interval,
} from './interval';
import type {
  AvailabilityEngineInput,
  AvailabilitySlot,
  EmployeeAvailabilityInput,
  ResourceRequirementInput,
} from './availability.types';

export function computeAvailability(input: AvailabilityEngineInput): AvailabilitySlot[] {
  const business = merge(input.businessWindows);
  if (business.length === 0) return [];

  // The service's own bookability windows narrow the business hours. `null`
  // means the service inherits them untouched.
  const bookable =
    input.serviceWindows === null ? business : intersectSets(business, merge(input.serviceWindows));
  if (bookable.length === 0) return [];

  const employees = normaliseEmployees(input.employees);
  const requirements = normaliseRequirements(input.resourceRequirements);

  // A service that needs staff with nobody eligible, or needs a resource with a
  // group that has an empty pool, can produce nothing. Bail before generating
  // candidates so the caller can report the specific reason.
  if (input.requiresEmployee && employees.length === 0) return [];
  if (input.requiresResource && requirements.some((r) => r.pool.length === 0)) return [];

  const slots: AvailabilitySlot[] = [];

  for (const start of candidateStarts(bookable, input)) {
    const appointment: Interval = { start, end: start + input.serviceDurationMs };
    const reserved: Interval = {
      start: start - input.bufferBeforeMs,
      end: appointment.end + input.bufferAfterMs,
    };

    // The appointment itself must fit inside a single bookable window. Buffers
    // may spill past opening time — they are set-up and clean-down, not trading
    // hours — but the service being delivered may not.
    if (!anyContains(bookable, appointment)) continue;

    const eligibleEmployees = input.requiresEmployee
      ? feasibleEmployees(employees, appointment, reserved)
      : [];
    if (input.requiresEmployee && eligibleEmployees.length === 0) continue;

    const eligibleResources = input.requiresResource
      ? feasibleResources(requirements, reserved)
      : [];
    if (input.requiresResource && eligibleResources === null) continue;

    slots.push({
      startAt: appointment.start,
      endAt: appointment.end,
      reservedStart: reserved.start,
      reservedEnd: reserved.end,
      employeeIds: eligibleEmployees.map((e) => e.employeeId),
      resourceIds: eligibleResources ?? [],
    });
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

/**
 * Slot starts, in time order, aligned to the grid anchor (local midnight) so
 * the times a company sees are stable `:00` / `:15` / `:30` marks regardless of
 * when its opening hours happen to begin.
 *
 * A single arithmetic walk per bookable window — no nested scan of the day.
 */
function candidateStarts(
  bookable: readonly Interval[],
  input: AvailabilityEngineInput,
): number[] {
  const step = input.slotIntervalMs;
  const out: number[] = [];
  const floor = Math.max(input.earliestStart, -Infinity);

  for (const window of bookable) {
    const from = Math.max(window.start, floor);
    // First grid point at or after `from`.
    const k = Math.ceil((from - input.gridAnchor) / step);
    let start = input.gridAnchor + k * step;
    // The whole service must finish within the window.
    while (start + input.serviceDurationMs <= window.end) {
      if (start >= floor) out.push(start);
      start += step;
    }
  }
  // Windows are disjoint and ascending after `merge`, so `out` is already sorted.
  return out;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

interface NormalisedEmployee {
  readonly employeeId: string;
  readonly workWindows: Interval[];
  readonly busy: Interval[];
}

function normaliseEmployees(
  employees: readonly EmployeeAvailabilityInput[],
): NormalisedEmployee[] {
  return [...employees]
    .map((e) => ({
      employeeId: e.employeeId,
      workWindows: merge(e.workWindows),
      busy: merge(e.busy),
    }))
    .sort((a, b) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0));
}

/**
 * An employee can take the slot when they are rostered for the whole
 * appointment and not already committed anywhere in the buffered window. The
 * buffer is checked against `busy` but not against `workWindows`: cleaning a
 * room after close is normal; seeing a customer then is not.
 */
function feasibleEmployees(
  employees: readonly NormalisedEmployee[],
  appointment: Interval,
  reserved: Interval,
): NormalisedEmployee[] {
  return employees.filter(
    (e) => anyContains(e.workWindows, appointment) && !anyOverlaps(e.busy, reserved),
  );
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

interface NormalisedRequirement {
  readonly resourceTypeId: string;
  readonly quantity: number;
  readonly pool: Array<{ resourceId: string; busy: Interval[] }>;
}

function normaliseRequirements(
  requirements: readonly ResourceRequirementInput[],
): NormalisedRequirement[] {
  return requirements.map((r) => ({
    resourceTypeId: r.resourceTypeId,
    quantity: Math.max(1, r.quantity),
    pool: [...r.pool]
      .map((p) => ({ resourceId: p.resourceId, busy: merge(p.busy) }))
      .sort((a, b) =>
        a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
      ),
  }));
}

/**
 * Every requirement group must be able to field `quantity` free resources for
 * the buffered window. Returns the deduplicated, sorted union of every free
 * candidate across all groups, or `null` if any group falls short.
 *
 * A resource appearing in two groups is only counted once per group here; the
 * concrete non-overlapping assignment across groups is the Appointment Engine's
 * job. For v1 each service needs at most a handful of resource types, so this
 * simple per-group feasibility check is enough and is documented as a known
 * limitation.
 */
function feasibleResources(
  requirements: readonly NormalisedRequirement[],
  reserved: Interval,
): string[] | null {
  const union = new Set<string>();
  for (const requirement of requirements) {
    const free = requirement.pool.filter((r) => !anyOverlaps(r.busy, reserved));
    if (free.length < requirement.quantity) return null;
    for (const r of free) union.add(r.resourceId);
  }
  return [...union].sort();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function intersectSets(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i]!;
    const bj = b[j]!;
    const start = Math.max(ai.start, bj.start);
    const end = Math.min(ai.end, bj.end);
    if (end > start) out.push({ start, end });
    if (ai.end < bj.end) i += 1;
    else j += 1;
  }
  return out;
}
