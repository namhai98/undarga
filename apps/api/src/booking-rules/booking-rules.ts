import { BookingRuleViolationError } from '../common/errors';
import type { TenantTx } from '../database/tenant-prisma.service';

/** The schema's defaults, for a company that never saved settings. */
export const DEFAULT_RULES = {
  minimumNoticeMinutes: 60,
  maximumAdvanceDays: 90,
  cancellationDeadlineHours: 24,
} as const;

/**
 * Every booking rule, resolved for one branch and service. The ONE place
 * precedence is decided:
 *
 *     service override  →  branch override  →  company setting  →  default
 *
 * The availability engine, staff booking, public booking, rescheduling,
 * cancellation, the customer portal and recurring series all read rules
 * through here, so a rule cannot mean one thing on one screen and another
 * elsewhere.
 */
export interface BookingRules {
  /** No booking may start sooner than this after now. */
  minimumNoticeMinutes: number;
  /** No booking may start more than this many days ahead (branch calendar days). */
  maximumAdvanceDays: number;
  /** Cancelling later than this before the start is a late cancellation. */
  cancellationDeadlineHours: number;
  /** Whether an appointment may be moved at all. */
  reschedulingAllowed: boolean;
  /** Moving later than this before the start is a late change. */
  rescheduleDeadlineHours: number;
  /** Customers' own self-service (the portal). Staff are not bound by these two. */
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  /** At most this many appointments of the service may overlap at the branch. */
  maxConcurrentBookings: number | null;
}

export interface RuleSources {
  company: Partial<{
    bookingLeadTimeMin: number;
    maxAdvanceBookingDays: number;
    cancellationWindowHours: number;
    reschedulingAllowed: boolean;
    rescheduleDeadlineHours: number | null;
    allowCustomerCancel: boolean;
    allowCustomerReschedule: boolean;
  }> | null;
  branch: Partial<{
    bookingLeadTimeMin: number | null;
    maxAdvanceBookingDays: number | null;
    cancellationWindowHours: number | null;
  }> | null;
  service: Partial<{
    bookingLeadTimeMin: number | null;
    maxAdvanceBookingDays: number | null;
    cancellationWindowHours: number | null;
    maxConcurrentBookings: number | null;
  }> | null;
}

/** Pure: sources in, rules out. */
export function resolveBookingRules(sources: RuleSources): BookingRules {
  const { company, branch, service } = sources;
  const nonNegative = (...values: Array<number | null | undefined>) =>
    values.find((v): v is number => typeof v === 'number' && v >= 0);
  const positive = (...values: Array<number | null | undefined>) =>
    values.find((v): v is number => typeof v === 'number' && v > 0);

  const cancellationDeadlineHours =
    nonNegative(
      service?.cancellationWindowHours,
      branch?.cancellationWindowHours,
      company?.cancellationWindowHours,
    ) ?? DEFAULT_RULES.cancellationDeadlineHours;

  return {
    minimumNoticeMinutes:
      nonNegative(
        service?.bookingLeadTimeMin,
        branch?.bookingLeadTimeMin,
        company?.bookingLeadTimeMin,
      ) ?? DEFAULT_RULES.minimumNoticeMinutes,
    maximumAdvanceDays:
      positive(
        service?.maxAdvanceBookingDays,
        branch?.maxAdvanceBookingDays,
        company?.maxAdvanceBookingDays,
      ) ?? DEFAULT_RULES.maximumAdvanceDays,
    cancellationDeadlineHours,
    reschedulingAllowed: company?.reschedulingAllowed ?? true,
    rescheduleDeadlineHours:
      nonNegative(company?.rescheduleDeadlineHours) ?? cancellationDeadlineHours,
    allowCustomerCancel: company?.allowCustomerCancel ?? true,
    allowCustomerReschedule: company?.allowCustomerReschedule ?? true,
    maxConcurrentBookings: positive(service?.maxConcurrentBookings) ?? null,
  };
}

/** Read the three sources for a branch and (optionally) a service, inside the caller's transaction. */
export async function loadBookingRules(
  tx: TenantTx,
  companyId: string,
  scope: { branchId?: string | null; serviceId?: string | null },
): Promise<BookingRules> {
  const [company, branch, service] = await Promise.all([
    tx.companySettings.findFirst({
      where: { companyId },
      select: {
        bookingLeadTimeMin: true,
        maxAdvanceBookingDays: true,
        cancellationWindowHours: true,
        reschedulingAllowed: true,
        rescheduleDeadlineHours: true,
        allowCustomerCancel: true,
        allowCustomerReschedule: true,
      },
    }),
    scope.branchId
      ? tx.branchSettings.findFirst({
          where: { companyId, branchId: scope.branchId },
          select: {
            bookingLeadTimeMin: true,
            maxAdvanceBookingDays: true,
            cancellationWindowHours: true,
          },
        })
      : Promise.resolve(null),
    scope.serviceId
      ? tx.service.findFirst({
          where: { companyId, id: scope.serviceId },
          select: {
            bookingLeadTimeMin: true,
            maxAdvanceBookingDays: true,
            cancellationWindowHours: true,
            maxConcurrentBookings: true,
          },
        })
      : Promise.resolve(null),
  ]);
  return resolveBookingRules({ company, branch, service });
}

/** The moment after which a change counts as late. */
export function deadlineFor(startsAt: Date, hours: number): Date {
  return new Date(startsAt.getTime() - hours * 3_600_000);
}

/**
 * Staff cancellation. Past the deadline it is refused unless the caller
 * confirms it as late (`late: true`) — the business still decides, but never
 * by accident, and the history says so.
 */
export function assertStaffCanCancel(
  rules: BookingRules,
  startsAt: Date,
  late: boolean,
  now = new Date(),
) {
  const deadline = deadlineFor(startsAt, rules.cancellationDeadlineHours);
  if (now > deadline && !late) {
    throw new BookingRuleViolationError('CANCELLATION_DEADLINE', {
      deadline: deadline.toISOString(),
      cancellationDeadlineHours: rules.cancellationDeadlineHours,
    });
  }
  return { isLate: now > deadline };
}

/** Staff reschedule: never when rescheduling is switched off; late only when confirmed. */
export function assertStaffCanReschedule(
  rules: BookingRules,
  startsAt: Date,
  late: boolean,
  now = new Date(),
) {
  if (!rules.reschedulingAllowed) throw new BookingRuleViolationError('RESCHEDULING_DISABLED');
  const deadline = deadlineFor(startsAt, rules.rescheduleDeadlineHours);
  if (now > deadline && !late) {
    throw new BookingRuleViolationError('RESCHEDULE_DEADLINE', {
      deadline: deadline.toISOString(),
      rescheduleDeadlineHours: rules.rescheduleDeadlineHours,
    });
  }
  return { isLate: now > deadline };
}
