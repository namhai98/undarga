import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import { ServiceNotBookableError, ValidationFailedError } from '../common/errors';
import {
  addDays,
  parsePlainDate,
  prismaTimeToMinutes,
  startOfLocalDay,
  endOfLocalDay,
  toIsoWithOffset,
  todayInZone,
  weekdayOf,
  wallToInstant,
  daysBetween,
  type PlainDate,
} from '../common/time';
import { RedisService } from '../redis/redis.service';
import { computeAvailability } from './availability.engine';
import { AvailabilityRepository, type ResolvedDay } from './availability.repository';
import type { AvailabilityQueryDto } from './availability.dto';
import type { Interval } from './interval';
import { merge, subtractAll } from './interval';
import type {
  AvailabilityDayDto,
  AvailabilityEngineInput,
  AvailabilitySlot,
  AvailabilityUnavailableReason,
  EmployeeAvailabilityInput,
  ResourceRequirementInput,
} from './availability.types';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

export interface AvailabilityOptions {
  /** Only services flagged `isOnlineBookable` (the future public booking page). */
  publicOnly?: boolean;
  /** Treat this appointment's own reservations as free (rescheduling). */
  excludeAppointmentId?: string;
}

/** Company defaults for the three booking-policy numbers, per the schema. */
const DEFAULT_SLOT_GRANULARITY_MIN = 15;
const DEFAULT_LEAD_TIME_MIN = 60;
const DEFAULT_MAX_ADVANCE_DAYS = 90;

/**
 * The availability use case: resolve the request, convert wall-clock rules into
 * instants for the requested date, hand the flat data to the pure engine, and
 * shape the result.
 *
 * ---------------------------------------------------------------------------
 * REUSABLE BY DESIGN
 * ---------------------------------------------------------------------------
 *
 * This method is the whole engine as far as any caller is concerned. The admin
 * controller is one caller; a public booking controller (docs, §29) will be
 * another, entering through its own tenant resolver — subdomain or custom
 * domain, both already in the resolver chain — and calling this same method
 * with `publicOnly: true`. Nothing here is HTTP-shaped, so a job or a test can
 * call it too (docs/ARCHITECTURE-RULES.md rule 1).
 *
 * ---------------------------------------------------------------------------
 * TIMEZONE
 * ---------------------------------------------------------------------------
 *
 * The requested `date` is read in the BRANCH timezone. Wall-clock rules
 * (business hours, shifts, breaks, service rules) are converted to instants
 * HERE — the one place, alongside the engine, that docs/DATABASE.md §16.4
 * sanctions for conversion. The engine then never sees a timezone, and the
 * response carries every instant as an ISO string WITH its offset plus the
 * zone name, so the client never guesses.
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly repository: AvailabilityRepository,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {}

  async getDay(
    query: AvailabilityQueryDto,
    options: AvailabilityOptions = {},
  ): Promise<AvailabilityDayDto> {
    const date = this.parseDate(query.date);

    // A reschedule's view of the day is specific to one appointment and must be
    // exact, so it never reads or writes the shared advisory cache.
    const cacheKey = options.excludeAppointmentId ? null : this.cacheKey(query, options);
    if (cacheKey) {
      const hit = await this.readCache(cacheKey);
      if (hit) return hit;
    }

    const result = await this.compute(query, date, options);

    if (cacheKey) await this.writeCache(cacheKey, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Computation
  // -------------------------------------------------------------------------

  private async compute(
    query: AvailabilityQueryDto,
    date: PlainDate,
    options: AvailabilityOptions,
  ): Promise<AvailabilityDayDto> {
    const [branch, service] = await Promise.all([
      this.repository.loadBranch(query.branchId),
      this.repository.loadService(query.serviceId),
    ]);

    // A service that is not ACTIVE cannot be booked at all — a hard error, not
    // an empty day (see ServiceNotBookableError).
    if (service.status !== 'ACTIVE') {
      throw new ServiceNotBookableError(service.status);
    }

    const tz = branch.timezoneName;
    const now = new Date();
    const empty = (reason: AvailabilityUnavailableReason | null): AvailabilityDayDto =>
      this.toDayDto(query, date, tz, service, DEFAULT_SLOT_GRANULARITY_MIN, service.durationMin, [], reason);

    // Date bounds, in the branch's own calendar.
    const today = todayInZone(tz, now);
    if (date < today) return empty('DATE_IN_PAST');

    const weekdays = uniqueWeekdays(date);
    const windowStart = startOfLocalDay(date, tz);
    const windowEnd = endOfLocalDay(date, tz);

    const day = await this.repository.loadDay({
      branchId: branch.id,
      serviceId: service.id,
      employeeId: query.employeeId,
      resourceId: query.resourceId,
      excludeAppointmentId: options.excludeAppointmentId,
      weekdays,
      dateAsUtcMidnight: new Date(`${date}T00:00:00.000Z`),
      windowStart,
      windowEnd,
    });

    const slotIntervalMin = firstPositive(
      day.branchSettings?.slotGranularityMin,
      day.companySettings?.slotGranularityMin,
      DEFAULT_SLOT_GRANULARITY_MIN,
    );
    const leadTimeMin = firstNonNegative(
      day.branchSettings?.bookingLeadTimeMin,
      day.companySettings?.bookingLeadTimeMin,
      DEFAULT_LEAD_TIME_MIN,
    );
    const maxAdvanceDays = firstPositive(
      day.branchSettings?.maxAdvanceBookingDays,
      day.companySettings?.maxAdvanceBookingDays,
      DEFAULT_MAX_ADVANCE_DAYS,
    );
    const durationMin = day.serviceBranch?.durationOverrideMin ?? service.durationMin;

    const dto = (
      slots: AvailabilitySlot[],
      reason: AvailabilityUnavailableReason | null,
    ): AvailabilityDayDto =>
      this.toDayDto(query, date, tz, service, slotIntervalMin, durationMin, slots, reason);

    if (daysBetween(today, date) > maxAdvanceDays) return dto([], 'BEYOND_BOOKING_WINDOW');

    // The service must be offered at this branch and switched on.
    if (!day.serviceBranch || !day.serviceBranch.isAvailable) {
      return dto([], 'SERVICE_NOT_OFFERED_AT_BRANCH');
    }
    if (options.publicOnly && !service.isOnlineBookable) {
      return dto([], 'SERVICE_NOT_OFFERED_AT_BRANCH');
    }

    // Branch open windows for the date: business hours (both overnight halves),
    // minus closures. A TEMPORARILY_CLOSED branch has none by definition.
    const branchWindows =
      branch.status === 'TEMPORARILY_CLOSED'
        ? []
        : subtractAll(
            businessWindows(day.businessHours, date, tz),
            day.closures.map(toInterval),
          );
    if (branchWindows.length === 0) return dto([], 'BRANCH_CLOSED');

    const serviceWindows = serviceRuleWindows(day.serviceRules, date, tz);

    const employees = service.requiresEmployee ? buildEmployees(day, date, tz) : [];
    if (service.requiresEmployee && employees.length === 0) return dto([], 'NO_ELIGIBLE_EMPLOYEE');

    const resourceRequirements = service.requiresResource ? buildResourceRequirements(day) : [];
    if (
      service.requiresResource &&
      (resourceRequirements.length === 0 ||
        resourceRequirements.some((r) => r.pool.length === 0))
    ) {
      return dto([], 'NO_ELIGIBLE_RESOURCE');
    }

    const engineInput: AvailabilityEngineInput = {
      businessWindows: branchWindows,
      serviceWindows,
      gridAnchor: windowStart.getTime(),
      slotIntervalMs: slotIntervalMin * MINUTE_MS,
      serviceDurationMs: durationMin * MINUTE_MS,
      bufferBeforeMs: service.bufferBeforeMin * MINUTE_MS,
      bufferAfterMs: service.bufferAfterMin * MINUTE_MS,
      earliestStart: now.getTime() + leadTimeMin * MINUTE_MS,
      requiresEmployee: service.requiresEmployee,
      requiresResource: service.requiresResource,
      employees,
      resourceRequirements,
    };

    const slots = computeAvailability(engineInput);
    return dto(slots, slots.length === 0 ? this.emptyReason(engineInput) : null);
  }

  /** A best-effort label for a day that resolved fine but produced no slots. */
  private emptyReason(input: AvailabilityEngineInput): AvailabilityUnavailableReason | null {
    if (input.requiresEmployee && input.employees.length === 0) return 'NO_ELIGIBLE_EMPLOYEE';
    if (input.requiresResource && input.resourceRequirements.some((r) => r.pool.length === 0)) {
      return 'NO_ELIGIBLE_RESOURCE';
    }
    // Genuinely just full / outside hours for this date — no structural reason.
    return null;
  }

  // -------------------------------------------------------------------------
  // Shaping
  // -------------------------------------------------------------------------

  private toDayDto(
    query: AvailabilityQueryDto,
    date: PlainDate,
    tz: string,
    service: { bufferBeforeMin: number; bufferAfterMin: number },
    slotIntervalMin: number,
    serviceDurationMin: number,
    slots: readonly AvailabilitySlot[],
    unavailableReason: AvailabilityUnavailableReason | null,
  ): AvailabilityDayDto {
    return {
      date,
      timezone: tz,
      branchId: query.branchId,
      serviceId: query.serviceId,
      slotIntervalMin,
      serviceDurationMin,
      bufferBeforeMin: service.bufferBeforeMin,
      bufferAfterMin: service.bufferAfterMin,
      unavailableReason: slots.length === 0 ? unavailableReason : null,
      slots: slots.map((slot) => ({
        startAt: toIsoWithOffset(new Date(slot.startAt), tz),
        endAt: toIsoWithOffset(new Date(slot.endAt), tz),
        reservedFrom: toIsoWithOffset(new Date(slot.reservedStart), tz),
        reservedTo: toIsoWithOffset(new Date(slot.reservedEnd), tz),
        available: true,
        employeeIds: slot.employeeIds,
        resourceIds: slot.resourceIds,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Cache — advisory, short TTL, tenant-safe key, off unless configured
  // -------------------------------------------------------------------------

  private cacheKey(query: AvailabilityQueryDto, options: AvailabilityOptions): string | null {
    if (!this.config.availability.cacheEnabled) return null;
    // Tenant-safe by construction: RedisService.tenantKey prepends the company.
    return this.redis.tenantKey(
      'availability',
      query.branchId,
      query.serviceId,
      query.date,
      query.employeeId ?? '-',
      query.resourceId ?? '-',
      options.publicOnly ? 'pub' : 'adm',
    );
  }

  private async readCache(key: string): Promise<AvailabilityDayDto | null> {
    try {
      return await this.redis.getJson<AvailabilityDayDto>(key);
    } catch (error) {
      this.logger.warn(`Availability cache read failed (${describe(error)}); computing fresh.`);
      return null;
    }
  }

  private async writeCache(key: string, value: AvailabilityDayDto): Promise<void> {
    try {
      await this.redis.setJson(key, value, this.config.availability.cacheTtlSeconds);
    } catch (error) {
      this.logger.warn(`Availability cache write failed (${describe(error)}); ignoring.`);
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private parseDate(value: string): PlainDate {
    try {
      return parsePlainDate(value);
    } catch {
      throw new ValidationFailedError([{ path: 'date', message: 'Not a real calendar date.' }]);
    }
  }
}

// ===========================================================================
// Wall-clock → instant assembly (pure module functions)
// ===========================================================================

function uniqueWeekdays(date: PlainDate): number[] {
  return [...new Set([weekdayOf(addDays(date, -1)), weekdayOf(date)])].sort((a, b) => a - b);
}

function toInterval(row: { startsAt: Date; endsAt: Date }): Interval {
  return { start: row.startsAt.getTime(), end: row.endsAt.getTime() };
}

/**
 * Business hours → instants for the date.
 *
 * The requested weekday contributes `[opens, closes)`; an overnight day
 * (`crossesMidnight`) contributes `[opens, next-midnight)` and the tail lands on
 * the following date, which is a different query. The PREVIOUS weekday's
 * overnight row contributes `[midnight, closes)` at the start of this date.
 * Emitting the two halves separately is what docs/DATABASE.md §6.3 calls for.
 */
function businessWindows(
  rows: ResolvedDay['businessHours'],
  date: PlainDate,
  tz: string,
): Interval[] {
  const today = weekdayOf(date);
  const prev = weekdayOf(addDays(date, -1));
  const latestByDay = latestEffective(rows, (r) => r.dayOfWeek, (r) => r.effectiveFrom);

  const windows: Interval[] = [];
  const sameDay = latestByDay.get(today);
  if (sameDay && !sameDay.isClosed && sameDay.opensAt && sameDay.closesAt) {
    const opens = prismaTimeToMinutes(sameDay.opensAt);
    const closes = prismaTimeToMinutes(sameDay.closesAt);
    const endMin = sameDay.crossesMidnight || closes <= opens ? DAY_MINUTES : closes;
    windows.push(spanOn(date, tz, opens, endMin));
  }

  const prevDay = latestByDay.get(prev);
  if (
    prev !== today &&
    prevDay &&
    !prevDay.isClosed &&
    prevDay.opensAt &&
    prevDay.closesAt &&
    (prevDay.crossesMidnight || prismaTimeToMinutes(prevDay.closesAt) <= prismaTimeToMinutes(prevDay.opensAt))
  ) {
    windows.push(spanOn(date, tz, 0, prismaTimeToMinutes(prevDay.closesAt)));
  }

  return merge(windows);
}

function serviceRuleWindows(
  rows: ResolvedDay['serviceRules'],
  date: PlainDate,
  tz: string,
): Interval[] | null {
  // No rules anywhere for this service → bookable whenever the branch is open.
  if (rows.length === 0) return null;

  const today = weekdayOf(date);
  const prev = weekdayOf(addDays(date, -1));
  const dateMidnight = Date.parse(`${date}T00:00:00.000Z`);

  const applicable = rows.filter((r) => {
    if (r.effectiveFrom && r.effectiveFrom.getTime() > dateMidnight) return false;
    if (r.effectiveTo && r.effectiveTo.getTime() < dateMidnight) return false;
    return r.dayOfWeek === today || r.dayOfWeek === prev;
  });
  // Rules exist but none cover this date → not bookable today (empty windows).
  const windows: Interval[] = [];
  for (const rule of applicable) {
    const opens = prismaTimeToMinutes(rule.startsAt);
    const closes = prismaTimeToMinutes(rule.endsAt);
    if (rule.dayOfWeek === today) {
      windows.push(spanOn(date, tz, opens, closes <= opens ? DAY_MINUTES : closes));
    } else if (closes <= opens) {
      windows.push(spanOn(date, tz, 0, closes));
    }
  }
  return merge(windows);
}

/**
 * One employee's rostered-and-free windows for the date, and everything that
 * makes them unavailable.
 *
 * Precedence (docs §22): a single-date schedule EXCEPTION replaces the recurring
 * pattern outright — `isWorking: false` removes the employee for the day;
 * `isWorking: true` with times uses those times; with no times it falls back to
 * the recurring schedule. Breaks are subtracted from whichever pattern wins.
 * APPROVED time off and buffered bookings become `busy` intervals.
 */
function buildEmployees(
  day: ResolvedDay,
  date: PlainDate,
  tz: string,
): EmployeeAvailabilityInput[] {
  const today = weekdayOf(date);
  const prev = weekdayOf(addDays(date, -1));

  const schedulesByEmployee = groupBy(day.schedules, (s) => s.employeeId);
  const exceptionByEmployee = new Map(day.exceptions.map((e) => [e.employeeId, e]));
  const timeOffByEmployee = groupBy(day.timeOff, (t) => t.employeeId);

  const bookingsByEmployee = groupBy(
    day.appointmentItems.filter((i) => i.employeeId !== null),
    (i) => i.employeeId as string,
  );

  const result: EmployeeAvailabilityInput[] = [];

  for (const employeeId of day.employeeIds) {
    const exception = exceptionByEmployee.get(employeeId);
    if (exception && !exception.isWorking) continue;

    let workWindows: Interval[];
    if (exception && exception.isWorking && exception.startsAt && exception.endsAt) {
      const opens = prismaTimeToMinutes(exception.startsAt);
      const closes = prismaTimeToMinutes(exception.endsAt);
      workWindows = [spanOn(date, tz, opens, closes <= opens ? DAY_MINUTES : closes)];
    } else {
      workWindows = recurringWorkWindows(
        schedulesByEmployee.get(employeeId) ?? [],
        date,
        tz,
        today,
        prev,
      );
    }
    if (workWindows.length === 0) continue;

    const busy: Interval[] = [
      ...(timeOffByEmployee.get(employeeId) ?? []).map(toInterval),
      ...(bookingsByEmployee.get(employeeId) ?? []).map(reservedIntervalOf),
    ];

    result.push({ employeeId, workWindows: merge(workWindows), busy: merge(busy) });
  }

  return result;
}

function recurringWorkWindows(
  schedules: ResolvedDay['schedules'],
  date: PlainDate,
  tz: string,
  today: number,
  prev: number,
): Interval[] {
  const latestByDay = latestEffective(schedules, (s) => s.dayOfWeek, (s) => s.effectiveFrom);
  const windows: Interval[] = [];

  const same = latestByDay.get(today);
  if (same) {
    const opens = prismaTimeToMinutes(same.startsAt);
    const closes = prismaTimeToMinutes(same.endsAt);
    const endMin = same.crossesMidnight || closes <= opens ? DAY_MINUTES : closes;
    let piece: Interval[] = [spanOn(date, tz, opens, endMin)];
    piece = subtractAll(piece, same.breaks.map((b) => breakSpanOn(date, tz, b, opens)));
    windows.push(...piece);
  }

  const prior = prev !== today ? latestByDay.get(prev) : undefined;
  if (prior) {
    const opens = prismaTimeToMinutes(prior.startsAt);
    const closes = prismaTimeToMinutes(prior.endsAt);
    if (prior.crossesMidnight || closes <= opens) {
      let piece: Interval[] = [spanOn(date, tz, 0, closes)];
      piece = subtractAll(piece, prior.breaks.map((b) => breakSpanOn(date, tz, b, 0)));
      windows.push(...piece);
    }
  }

  return windows;
}

function buildResourceRequirements(day: ResolvedDay): ResourceRequirementInput[] {
  const reservationsByResource = groupBy(day.resourceReservations, (r) => r.resourceId);
  const resourcesByType = groupBy(day.resources, (r) => r.resourceTypeId);

  return day.requirements.map((requirement) => ({
    resourceTypeId: requirement.resourceTypeId,
    quantity: requirement.quantity,
    pool: (resourcesByType.get(requirement.resourceTypeId) ?? []).map((resource) => ({
      resourceId: resource.id,
      busy: (reservationsByResource.get(resource.id) ?? []).map(toInterval),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** The instant span of local `[fromMin, toMin)` minutes on `date` in `tz`. */
function spanOn(date: PlainDate, tz: string, fromMin: number, toMin: number): Interval {
  return {
    start: wallToInstant(date, fromMin, tz).getTime(),
    end: wallToInstant(date, toMin, tz).getTime(),
  };
}

/**
 * A recurring break's `[start, end)` on the date. A break past midnight
 * (`end <= start`) belongs to an overnight shift and is placed after midnight;
 * `shiftOpensMin` disambiguates which day the "0" side means.
 */
function breakSpanOn(
  date: PlainDate,
  tz: string,
  brk: { startsAt: Date; endsAt: Date },
  shiftOpensMin: number,
): Interval {
  let startMin = prismaTimeToMinutes(brk.startsAt);
  let endMin = prismaTimeToMinutes(brk.endsAt);
  if (startMin < shiftOpensMin) startMin += DAY_MINUTES;
  if (endMin <= startMin) endMin += DAY_MINUTES;
  return spanOn(date, tz, startMin, endMin);
}

function reservedIntervalOf(item: {
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}): Interval {
  return {
    start: item.startsAt.getTime() - item.bufferBeforeMin * MINUTE_MS,
    end: item.endsAt.getTime() + item.bufferAfterMin * MINUTE_MS,
  };
}

/** Keep only the newest-effective row per key. Input is pre-sorted desc. */
function latestEffective<T>(
  rows: readonly T[],
  key: (row: T) => number,
  effectiveFrom: (row: T) => Date,
): Map<number, T> {
  const out = new Map<number, T>();
  for (const row of [...rows].sort((a, b) => effectiveFrom(b).getTime() - effectiveFrom(a).getTime())) {
    if (!out.has(key(row))) out.set(key(row), row);
  }
  return out;
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function firstPositive(...values: Array<number | null | undefined>): number {
  for (const v of values) if (typeof v === 'number' && v > 0) return v;
  return 0;
}

function firstNonNegative(...values: Array<number | null | undefined>): number {
  for (const v of values) if (typeof v === 'number' && v >= 0) return v;
  return 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
