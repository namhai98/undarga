import { Injectable } from '@nestjs/common';
import { ResourceNotFoundError } from '../common/errors';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';

/**
 * Every row the availability engine needs for one branch, one service and one
 * local date — loaded in a bounded, fixed number of queries inside a single
 * tenant transaction.
 *
 * ---------------------------------------------------------------------------
 * NO QUERY PER SLOT
 * ---------------------------------------------------------------------------
 *
 * docs/DATABASE.md §24: the engine must not hit the database once per candidate
 * time. So this loads the whole day's worth of schedules, exceptions, time off,
 * closures, bookings and resources up front, and the engine works entirely in
 * memory over the result. The queries here are the ones the hot-path indexes in
 * §11.1 were designed for.
 *
 * Every `where` carries `companyId` at the top level — the Prisma tenant-scope
 * extension refuses anything else, and RLS refuses the rows underneath. The
 * `branchId` / `serviceId` / id filters are only ever ANDed with the resolved
 * company, so another tenant's ids match nothing and surface as 404 or as an
 * empty day.
 */
@Injectable()
export class AvailabilityRepository {
  /**
   * How far either side of the day to scan for bookings and time off. A booked
   * appointment just outside the day can still reach into it once its buffers
   * are counted; a generous fixed margin catches that without arithmetic in
   * SQL. No sane buffer is hours long — if one were, availability would be
   * slightly optimistic and the Appointment Engine's constraint would still
   * catch the clash (the endpoint is advisory).
   */
  private static readonly SCAN_MARGIN_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
  ) {}

  /**
   * Resolve the branch. 404 for unknown, soft-deleted, or another tenant's;
   * `INACTIVE` is also a 404 (it is retired, not merely shut today). A
   * `TEMPORARILY_CLOSED` branch resolves fine and the day comes back closed.
   */
  async loadBranch(branchId: string): Promise<ResolvedBranchRow> {
    return this.db.run(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: branchId, companyId: this.companyId(), deletedAt: null },
        select: { id: true, timezoneName: true, status: true },
      });
      if (!branch || branch.status === 'INACTIVE') {
        throw new ResourceNotFoundError('Branch', branchId);
      }
      return branch;
    }, 'availability.loadBranch');
  }

  /** Resolve the service. 404 for unknown / soft-deleted / cross-tenant. */
  async loadService(serviceId: string): Promise<ResolvedServiceRow> {
    return this.db.run(async (tx) => {
      const service = await tx.service.findFirst({
        where: { id: serviceId, companyId: this.companyId(), deletedAt: null },
        select: {
          id: true,
          status: true,
          durationMin: true,
          bufferBeforeMin: true,
          bufferAfterMin: true,
          requiresEmployee: true,
          requiresResource: true,
          isOnlineBookable: true,
        },
      });
      if (!service) throw new ResourceNotFoundError('Service', serviceId);
      return service;
    }, 'availability.loadService');
  }

  /**
   * Everything else, in one transaction. `weekdays` is the requested weekday
   * plus the day before it, so an overnight shift or overnight opening hours
   * that begin the previous evening are picked up.
   */
  async loadDay(params: LoadDayParams): Promise<ResolvedDay> {
    const { branchId, serviceId, weekdays, dateAsUtcMidnight, windowStart, windowEnd } = params;
    const scanStart = new Date(windowStart.getTime() - AvailabilityRepository.SCAN_MARGIN_MS);
    const scanEnd = new Date(windowEnd.getTime() + AvailabilityRepository.SCAN_MARGIN_MS);

    return this.db.run(async (tx) => {
      const companyId = this.companyId();
      const effectiveDated = {
        effectiveFrom: { lte: dateAsUtcMidnight },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateAsUtcMidnight } }],
      };

      const [
        serviceBranch,
        companySettings,
        branchSettings,
        businessHours,
        closures,
        serviceRules,
        eligibleEmployees,
        requirements,
      ] = await Promise.all([
        tx.serviceBranch.findFirst({
          where: { companyId, serviceId, branchId },
          select: { isAvailable: true, durationOverrideMin: true },
        }),
        tx.companySettings.findFirst({
          where: { companyId },
          select: {
            slotGranularityMin: true,
            bookingLeadTimeMin: true,
            maxAdvanceBookingDays: true,
          },
        }),
        tx.branchSettings.findFirst({
          where: { companyId, branchId },
          select: {
            slotGranularityMin: true,
            bookingLeadTimeMin: true,
            maxAdvanceBookingDays: true,
          },
        }),
        tx.businessHours.findMany({
          where: { companyId, branchId, dayOfWeek: { in: weekdays }, ...effectiveDated },
          orderBy: { effectiveFrom: 'desc' },
        }),
        tx.branchClosure.findMany({
          where: {
            companyId,
            branchId,
            startsAt: { lt: windowEnd },
            endsAt: { gt: windowStart },
          },
          select: { startsAt: true, endsAt: true },
        }),
        // Every rule for the service (branch-scoped or company-wide), NOT just
        // the requested weekday: the caller needs to tell "no rules at all,
        // bookable whenever open" from "rules exist but none cover this day,
        // not bookable today".
        tx.serviceAvailabilityRule.findMany({
          where: { companyId, serviceId, OR: [{ branchId: null }, { branchId }] },
        }),
        tx.employee.findMany({
          where: {
            companyId,
            deletedAt: null,
            status: 'ACTIVE',
            isBookable: true,
            ...(params.employeeId ? { id: params.employeeId } : {}),
            services: { some: { companyId, serviceId } },
            branches: { some: { companyId, branchId } },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
        tx.serviceResourceRequirement.findMany({
          where: { companyId, serviceId },
          select: { resourceTypeId: true, quantity: true },
        }),
      ]);

      const employeeIds = eligibleEmployees.map((e) => e.id);

      const [schedules, exceptions, timeOff, appointmentItems, resources] = await Promise.all([
        employeeIds.length
          ? tx.employeeSchedule.findMany({
              where: {
                companyId,
                branchId,
                employeeId: { in: employeeIds },
                dayOfWeek: { in: weekdays },
                isActive: true,
                ...effectiveDated,
              },
              orderBy: { effectiveFrom: 'desc' },
              include: { breaks: { select: { startsAt: true, endsAt: true } } },
            })
          : Promise.resolve([]),
        employeeIds.length
          ? tx.employeeScheduleException.findMany({
              where: { companyId, employeeId: { in: employeeIds }, date: dateAsUtcMidnight },
              select: {
                employeeId: true,
                isWorking: true,
                startsAt: true,
                endsAt: true,
              },
            })
          : Promise.resolve([]),
        employeeIds.length
          ? tx.employeeTimeOff.findMany({
              where: {
                companyId,
                employeeId: { in: employeeIds },
                status: 'APPROVED',
                startsAt: { lt: scanEnd },
                endsAt: { gt: scanStart },
              },
              select: { employeeId: true, startsAt: true, endsAt: true },
            })
          : Promise.resolve([]),
        // By employee, NOT by branch: a stylist covering two locations is busy
        // here while booked there. The exclusion constraint is per employee
        // across the whole company, and this read must agree with it.
        employeeIds.length
          ? tx.appointmentItem.findMany({
              where: {
                companyId,
                employeeId: { in: employeeIds },
                blocksCalendar: true,
                startsAt: { lt: scanEnd },
                endsAt: { gt: scanStart },
                ...(params.excludeAppointmentId
                  ? { appointmentId: { not: params.excludeAppointmentId } }
                  : {}),
              },
              select: {
                employeeId: true,
                startsAt: true,
                endsAt: true,
                bufferBeforeMin: true,
                bufferAfterMin: true,
              },
            })
          : Promise.resolve([]),
        requirements.length
          ? tx.resource.findMany({
              where: {
                companyId,
                branchId,
                resourceTypeId: { in: requirements.map((r) => r.resourceTypeId) },
                status: 'ACTIVE',
                isBookable: true,
                deletedAt: null,
                ...(params.resourceId ? { id: params.resourceId } : {}),
              },
              select: { id: true, resourceTypeId: true },
              orderBy: { id: 'asc' },
            })
          : Promise.resolve([]),
        ]);

      const resourceReservations = resources.length
        ? await tx.appointmentResource.findMany({
            where: {
              companyId,
              blocksCalendar: true,
              resourceId: { in: resources.map((r) => r.id) },
              startsAt: { lt: scanEnd },
              endsAt: { gt: scanStart },
              ...(params.excludeAppointmentId
                ? { appointmentItem: { appointmentId: { not: params.excludeAppointmentId } } }
                : {}),
            },
            select: { resourceId: true, startsAt: true, endsAt: true },
          })
        : [];

      return {
        serviceBranch,
        companySettings,
        branchSettings,
        businessHours,
        closures,
        serviceRules,
        employeeIds,
        schedules,
        exceptions,
        timeOff,
        appointmentItems,
        requirements,
        resources,
        resourceReservations,
      };
    }, 'availability.loadDay');
  }

  /**
   * The resolved company for this request. `db.run` has already opened a
   * transaction bound to it; this is the same id, merged into every `where` so
   * the tenant-scope extension is satisfied and the filter reads consistently.
   */
  private companyId(): string {
    return this.context.requireCompanyId('availability repository');
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ResolvedBranchRow {
  id: string;
  timezoneName: string;
  status: string;
}

export interface ResolvedServiceRow {
  id: string;
  status: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  requiresEmployee: boolean;
  requiresResource: boolean;
  isOnlineBookable: boolean;
}

export interface LoadDayParams {
  branchId: string;
  serviceId: string;
  employeeId?: string;
  resourceId?: string;
  /**
   * Ignore this appointment's own reservations. Used when rescheduling, so the
   * booking being moved does not count as busy against its new time.
   */
  excludeAppointmentId?: string;
  weekdays: number[];
  /** The requested date as a `Date` at UTC midnight — how `@db.Date` compares. */
  dateAsUtcMidnight: Date;
  /** Instant of local midnight starting the date. */
  windowStart: Date;
  /** Instant of the next local midnight. */
  windowEnd: Date;
}

interface TimeRow {
  startsAt: Date;
  endsAt: Date;
}

export interface ResolvedDay {
  serviceBranch: { isAvailable: boolean; durationOverrideMin: number | null } | null;
  companySettings: {
    slotGranularityMin: number;
    bookingLeadTimeMin: number;
    maxAdvanceBookingDays: number;
  } | null;
  branchSettings: {
    slotGranularityMin: number | null;
    bookingLeadTimeMin: number | null;
    maxAdvanceBookingDays: number | null;
  } | null;
  businessHours: Array<{
    dayOfWeek: number;
    isClosed: boolean;
    opensAt: Date | null;
    closesAt: Date | null;
    crossesMidnight: boolean;
    effectiveFrom: Date;
  }>;
  closures: TimeRow[];
  serviceRules: Array<{
    branchId: string | null;
    dayOfWeek: number;
    startsAt: Date;
    endsAt: Date;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
  }>;
  employeeIds: string[];
  schedules: Array<{
    employeeId: string;
    dayOfWeek: number;
    startsAt: Date;
    endsAt: Date;
    crossesMidnight: boolean;
    effectiveFrom: Date;
    breaks: TimeRow[];
  }>;
  exceptions: Array<{
    employeeId: string;
    isWorking: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
  }>;
  timeOff: Array<{ employeeId: string } & TimeRow>;
  appointmentItems: Array<{
    employeeId: string | null;
    startsAt: Date;
    endsAt: Date;
    bufferBeforeMin: number;
    bufferAfterMin: number;
  }>;
  requirements: Array<{ resourceTypeId: string; quantity: number }>;
  resources: Array<{ id: string; resourceTypeId: string }>;
  resourceReservations: Array<{ resourceId: string } & TimeRow>;
}
