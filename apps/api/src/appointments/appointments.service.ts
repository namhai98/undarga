import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ActorType, type AppointmentStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import {
  BookingRuleViolationError,
  InvalidStatusTransitionError,
  PermissionDeniedError,
  ResourceNotFoundError,
  SeriesConflictError,
  ServiceNotBookableError,
  SlotTakenError,
  SlotUnavailableError,
  ValidationFailedError,
} from '../common/errors';
import { daysBetween, parsePlainDate, todayInZone, toIsoWithOffset } from '../common/time';
import {
  assertStaffCanCancel,
  assertStaffCanReschedule,
  loadBookingRules,
  type BookingRules,
} from '../booking-rules/booking-rules';
import { AvailabilityService } from '../availability/availability.service';
import { enqueueCalendarSync } from '../calendar/calendar-sync.queue';
import { bookingPrice } from '../catalog/service-price';
import { PromotionsService } from '../promotions/promotions.service';
import {
  NOTIFICATION_EVENTS,
  NotificationEventService,
  type NotificationEventType,
} from '../notifications/notification-event.service';
import type { AvailabilitySlotDto } from '../availability/availability.types';
import { overlaps, type Interval } from '../availability/interval';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { actorLabel } from '../tenancy/context/context.types';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { RESCHEDULABLE, blocksCalendar, canTransition, timestampFor } from './appointment-status';
import {
  parseStatuses,
  type AppointmentQueryDto,
  type CancelAppointmentDto,
  type CancelSeriesDto,
  type CreateAppointmentDto,
  type CreateSeriesDto,
  type RescheduleAppointmentDto,
} from './dto/appointment.dto';
import { employeeLockKey, lockKeys, resourceLockKey } from './booking-locks';
import { planOccurrences } from './recurrence';
import { EntitlementsService } from '../subscriptions/entitlements.service';

interface AppointmentRow {
  id: string;
  companyId: string;
  status: AppointmentStatus;
}

@Injectable()
export class AppointmentRepository extends TenantScopedRepository<AppointmentRow> {
  protected readonly modelName = 'Appointment';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<AppointmentRow> {
    return tx.appointment;
  }
}

const MINUTE_MS = 60_000;
/** How far either side of a window to scan for bookings whose buffers reach in. */
const CONFLICT_SCAN_MARGIN_MS = 6 * 60 * MINUTE_MS;

/**
 * The Appointment Engine: create, read, move, cancel and progress bookings.
 *
 * ===========================================================================
 * HOW A DOUBLE BOOKING IS PREVENTED
 * ===========================================================================
 *
 *   1. AVAILABILITY — the requested start must be a slot the Availability
 *      Engine offers right now for that branch, service, employee and resource.
 *      This is the same code the availability endpoint runs, so business hours,
 *      closures, rosters, breaks, overrides, time off, lead time and existing
 *      bookings are checked once, in one place. The client's idea of what is
 *      free is never trusted.
 *
 *   2. LOCK + CONFLICT CHECK — inside the write transaction, a transaction-scoped
 *      Postgres advisory lock is taken per employee and per resource, then their
 *      overlapping buffered reservations are re-read. Two requests for the same
 *      person serialise here, so the second sees the first's committed row and
 *      fails cleanly.
 *
 *   3. EXCLUSION CONSTRAINT — `appointment_item_employee_no_overlap` and
 *      `appointment_resource_no_overlap` (001_hardening.sql) refuse any
 *      overlapping `reserved_range` at the database, whatever path wrote it.
 *      That is the guarantee; 1 and 2 exist to turn a constraint violation into
 *      a helpful message before it happens. A violation that still gets through
 *      (SQLSTATE 23P01) is mapped to 409 SLOT_TAKEN, never a 500.
 *
 * ===========================================================================
 * STATUS
 * ===========================================================================
 *
 * The schema's own AppointmentStatus enum, and a transition graph in
 * appointment-status.ts. Every change locks the row (`FOR UPDATE`), checks the
 * graph, and moves the appointment AND its items together — the items carry
 * the status that drives `blocks_calendar`, so an appointment cancelled without
 * its items would hold its slot forever. `appointment_resource` has no trigger
 * for that flag, so it is written here.
 *
 * ===========================================================================
 * RESCHEDULE IS CANCEL-AND-CREATE
 * ===========================================================================
 *
 * As the schema prescribes: the original is CANCELLED with reason
 * `RESCHEDULED`, a new appointment is created with `rescheduledFromId`
 * pointing back, both in one transaction. History stays intact and the
 * constraint only ever sees ordinary inserts and status changes.
 */
@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly appointments: AppointmentRepository,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
    private readonly context: RequestContextService,
    private readonly promotions: PromotionsService,
    private readonly events: NotificationEventService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ===========================================================================
  // Reads
  // ===========================================================================

  async list(query: AppointmentQueryDto) {
    if (query.from && query.to && query.from > query.to) {
      throw new ValidationFailedError({ from: '`from` must not be after `to`.' });
    }

    return this.appointments.transaction(async (tx, companyId) => {
      const own = await this.ownScope(tx, companyId, COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY);
      if (own === 'none') {
        return { items: [], total: 0, limit: query.limit, offset: query.offset };
      }

      const where = buildWhere(companyId, query, own?.employeeId ?? null);
      const [rows, total] = await Promise.all([
        tx.appointment.findMany({
          where,
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          skip: query.offset,
          take: query.limit,
          include: summaryInclude(companyId),
        }),
        tx.appointment.count({ where }),
      ]);

      return {
        items: rows.map(toSummary),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async findById(appointmentId: string) {
    return this.appointments.transaction(async (tx, companyId) => {
      const own = await this.ownScope(tx, companyId, COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY);
      if (own === 'none') throw new ResourceNotFoundError('Appointment', appointmentId);

      const row = await tx.appointment.findFirst({
        where: {
          id: appointmentId,
          companyId,
          ...(own ? { items: { some: { companyId, employeeId: own.employeeId } } } : {}),
        },
        include: {
          ...summaryInclude(companyId),
          statusHistory: { orderBy: { changedAt: 'asc' } },
          rescheduledTo: { select: { id: true, appointmentNumber: true, startsAt: true } },
          rescheduledFrom: { select: { id: true, appointmentNumber: true, startsAt: true } },
        },
      });
      if (!row) throw new ResourceNotFoundError('Appointment', appointmentId);

      return toDetail(row);
    });
  }

  // ===========================================================================
  // Create
  // ===========================================================================

  /** Staff booking: book, then return the full, permission-scoped detail. */
  async create(input: CreateAppointmentDto) {
    const booked = await this.book(input);
    return this.findById(booked.id);
  }

  /**
   * The booking itself — resolve, availability check, lock + conflict check,
   * insert, audit — returning a plain summary rather than a permission-scoped
   * read. Both the staff endpoint and the public booking page go through here,
   * so there is one definition of a valid booking.
   *
   * `publicOnly` additionally requires the service to be online-bookable, and
   * treats one that is not as not existing at all.
   */
  async book(
    input: Omit<CreateAppointmentDto, 'source'> & { source?: CreateAppointmentDto['source'] },
    options: { publicOnly?: boolean } = {},
  ): Promise<BookedAppointment> {
    const startsAt = new Date(input.startsAt);

    // Every id is resolved against the tenant first, so a foreign id is a 404
    // before anything else is said about it.
    const booking = await this.appointments.transaction((tx, companyId) =>
      this.resolveBooking(tx, companyId, input, options.publicOnly ?? false),
    );

    this.checkTiming(booking, startsAt);
    const slot = await this.offeredSlot(booking, startsAt, undefined, options.publicOnly ?? false);

    const {
      appointment: created,
      assignment,
      promotion,
    } = await this.writeGuarded(async (tx, companyId) => {
      const assignment = await this.assign(tx, companyId, booking, slot);
      await this.lockAndCheck(tx, companyId, assignment, slot, undefined, capOf(booking));
      // The plan's monthly appointment allowance. A reschedule does not count.
      await this.entitlements.assertCanAdd(tx, companyId, 'APPOINTMENT');

      const settings = await tx.companySettings.findFirst({
        where: { companyId },
        select: { autoConfirmBookings: true },
      });
      const status: AppointmentStatus =
        settings?.autoConfirmBookings === false ? 'PENDING' : 'CONFIRMED';

      const appointment = await this.insert(tx, companyId, {
        booking,
        slot,
        assignment,
        status,
        source: input.source ?? 'STAFF',
        customerNote: input.customerNote ?? null,
        internalNote: input.internalNote ?? null,
        rescheduledFromId: null,
        historyReason: input.source === 'ONLINE' ? 'Booked online' : 'Created',
      });

      // The code is evaluated against the booking as it now stands — the real
      // price, the employee actually assigned, the customer actually matched —
      // and its usage consumed, in THIS transaction. If it cannot be honoured
      // (expired, used up by a concurrent booking, wrong branch…) the booking
      // rolls back with it: the customer was shown a discounted price, and
      // taking them at another one silently would be worse than refusing.
      const promotion = input.promotionCode
        ? await this.promotions.applyInTransaction(tx, companyId, {
            appointmentId: appointment.id,
            code: input.promotionCode,
          })
        : null;

      // In the booking's own transaction: the event commits with the booking or
      // not at all. Sending happens later, off the request path.
      await this.events.emitWithin(tx, companyId, NOTIFICATION_EVENTS.APPOINTMENT_CREATED, {
        appointmentId: appointment.id,
      });
      // Same transaction, same reason: the employee's calendar is updated later.
      await enqueueCalendarSync(tx, companyId, [appointment.id]);

      return { appointment, assignment, promotion };
    });

    await this.audit.record({
      action: 'appointment.created',
      resourceType: 'appointment',
      resourceId: created.id,
      after: {
        appointmentNumber: created.appointmentNumber,
        status: created.status,
        branchId: booking.branch.id,
        serviceId: booking.service.id,
        customerId: booking.customer.id,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
        ...(promotion
          ? {
              promotionId: promotion.promotionId,
              promotionCode: promotion.code,
              discountMinor: promotion.discountMinor.toString(),
            }
          : {}),
      },
      metadata: { source: created.source },
    });

    this.logger.log(`Appointment ${created.appointmentNumber} created (${created.status})`);

    const tz = booking.branch.timezoneName;
    return {
      id: created.id,
      appointmentNumber: created.appointmentNumber,
      status: created.status,
      startsAt: toIsoWithOffset(created.startsAt, tz),
      endsAt: toIsoWithOffset(created.endsAt, tz),
      timezone: tz,
      branch: { id: booking.branch.id, name: booking.branch.name },
      service: {
        id: booking.service.id,
        name: booking.service.name,
        durationMin: Math.round(
          (created.endsAt.getTime() - created.startsAt.getTime()) / MINUTE_MS,
        ),
      },
      employee: assignment.employeeId
        ? { id: assignment.employeeId, name: assignment.employeeName ?? '' }
        : null,
      subtotalMinor: created.subtotalMinor.toString(),
      discountMinor: (promotion?.discountMinor ?? 0n).toString(),
      totalMinor: (promotion?.totalMinor ?? created.totalMinor).toString(),
      currencyCode: created.currencyCode,
      promotion: promotion ? { name: promotion.promotionName, code: promotion.code } : null,
    };
  }

  // ===========================================================================
  // Reschedule — cancel-and-create
  // ===========================================================================

  async reschedule(
    appointmentId: string,
    input: RescheduleAppointmentDto,
    options: {
      /**
       * The customer portal: the appointment must be this customer's, the new
       * time must be offered PUBLICLY (online-bookable, lead time, advance
       * window), staff and room stay as they are, and `guard` — the business's
       * rules — runs under the row lock.
       */
      customer?: { customerId: string; guard: (startsAt: Date) => void };
    } = {},
  ) {
    const startsAt = new Date(input.startsAt);
    const customer = options.customer;

    const current = await this.appointments.transaction(async (tx, companyId) => {
      const row = await tx.appointment.findFirst({
        where: { id: appointmentId, companyId },
        include: {
          items: {
            orderBy: { sequence: 'asc' },
            include: { resources: { select: { resourceId: true } } },
          },
        },
      });
      if (!row) throw new ResourceNotFoundError('Appointment', appointmentId);
      if (customer && row.customerId !== customer.customerId) {
        throw new ResourceNotFoundError('Appointment', appointmentId);
      }
      return row;
    });

    if (!RESCHEDULABLE.includes(current.status)) {
      throw new InvalidStatusTransitionError(current.status, 'RESCHEDULED');
    }
    const item = current.items[0];
    if (!item) throw new ResourceNotFoundError('AppointmentItem', appointmentId);

    const booking = await this.appointments.transaction((tx, companyId) =>
      this.resolveBooking(
        tx,
        companyId,
        {
          branchId: current.branchId,
          serviceId: item.serviceId,
          customerId: current.customerId,
          // Same person and room by default; the caller may name others.
          employeeId: (customer ? undefined : input.employeeId) ?? item.employeeId ?? undefined,
          resourceId: (customer ? undefined : input.resourceId) ?? item.resources[0]?.resourceId,
        },
        Boolean(customer),
      ),
    );

    // Rescheduling rules. Customers' own rules (portal) run in `guard`; the
    // business switch and, for staff, the deadline are checked here — and again
    // under the row lock below.
    const late = input.lateChange ?? false;
    if (
      !customer &&
      late &&
      !this.context.hasPermission(COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY)
    ) {
      throw new PermissionDeniedError([COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY]);
    }
    if (customer) {
      if (!booking.rules.reschedulingAllowed)
        throw new BookingRuleViolationError('RESCHEDULING_DISABLED');
    } else {
      assertStaffCanReschedule(booking.rules, current.startsAt, late);
    }
    this.checkTiming(booking, startsAt);

    // The appointment being moved must not count as busy against its own new
    // time — nudging a booking by fifteen minutes is the commonest reschedule.
    const slot = await this.offeredSlot(booking, startsAt, current.id, Boolean(customer));

    const { replacement, before } = await this.writeGuarded(async (tx, companyId) => {
      const locked = await lockAppointment(tx, companyId, appointmentId);
      if (customer && locked.customerId !== customer.customerId) {
        throw new ResourceNotFoundError('Appointment', appointmentId);
      }
      if (!RESCHEDULABLE.includes(locked.status)) {
        throw new InvalidStatusTransitionError(locked.status, 'RESCHEDULED');
      }
      customer?.guard(locked.startsAt);
      const lateChange = customer
        ? false
        : assertStaffCanReschedule(booking.rules, locked.startsAt, late).isLate;

      // Release the old slot first, in the same transaction: the new booking
      // may overlap it, and the constraint must see it gone.
      const reasonText = input.reason ? `RESCHEDULED: ${input.reason}` : 'RESCHEDULED';
      await this.applyStatus(tx, companyId, appointmentId, locked.status, 'CANCELLED', {
        reason: lateChange ? `${reasonText} (late change)` : reasonText,
        cancellation: true,
      });

      const assignment = await this.assign(tx, companyId, booking, slot);
      await this.lockAndCheck(tx, companyId, assignment, slot, appointmentId, capOf(booking));

      const replacement = await this.insert(tx, companyId, {
        booking,
        slot,
        assignment,
        // A checked-in customer at the old time is not checked in at the new.
        status: locked.status === 'PENDING' ? 'PENDING' : 'CONFIRMED',
        source: current.source,
        customerNote: current.customerNote,
        internalNote: current.internalNote,
        rescheduledFromId: current.id,
        historyReason: `Rescheduled from ${current.appointmentNumber}`,
        // An occurrence moved stays in its series.
        seriesId: current.seriesId,
        seriesIndex: current.seriesIndex,
        // The customer was quoted a price; moving the time does not change it
        // — nor does it change the discount they were given.
        priceMinor: item.unitPriceMinor,
        carriedDiscount: {
          discountMinor: current.discountMinor,
          promotions: snapshotPromotions(item.snapshot),
        },
      });

      // The redemption follows the booking. Usage was consumed once, when the
      // code was applied; a reschedule neither refunds nor re-charges it.
      await this.promotions.transferRedemptions(
        tx,
        companyId,
        { appointmentId: current.id },
        { appointmentId: replacement.id, itemId: replacement.itemId },
      );

      // One message about the move, for the NEW booking — not a cancellation
      // for the old one, which is an implementation detail of rescheduling.
      await this.events.emitWithin(tx, companyId, NOTIFICATION_EVENTS.APPOINTMENT_RESCHEDULED, {
        appointmentId: replacement.id,
        previousAppointmentId: current.id,
      });
      // The old booking's event goes, the new one's appears.
      await enqueueCalendarSync(tx, companyId, [current.id, replacement.id]);
      // After the insert, so the replacement counts as the live occurrence.
      if (current.seriesId) await syncSeriesStatus(tx, companyId, current.seriesId, null);

      return { replacement, before: locked };
    });

    await this.audit.record({
      action: 'appointment.rescheduled',
      resourceType: 'appointment',
      resourceId: current.id,
      before: {
        appointmentId: current.id,
        status: before.status,
        startsAt: current.startsAt.toISOString(),
      },
      after: {
        appointmentId: replacement.id,
        appointmentNumber: replacement.appointmentNumber,
        startsAt: replacement.startsAt.toISOString(),
        endsAt: replacement.endsAt.toISOString(),
      },
      metadata: input.reason ? { reason: input.reason } : undefined,
    });

    if (customer) return { id: replacement.id, appointmentNumber: replacement.appointmentNumber };
    return this.findById(replacement.id);
  }

  // ===========================================================================
  // Status changes
  // ===========================================================================

  confirm(appointmentId: string, reason?: string) {
    return this.transition(appointmentId, 'CONFIRMED', 'appointment.confirmed', { reason });
  }

  start(appointmentId: string, reason?: string) {
    return this.transition(appointmentId, 'IN_PROGRESS', 'appointment.started', { reason });
  }

  complete(appointmentId: string, reason?: string) {
    return this.transition(appointmentId, 'COMPLETED', 'appointment.completed', { reason });
  }

  noShow(appointmentId: string, reason?: string) {
    return this.transition(appointmentId, 'NO_SHOW', 'appointment.no_show', {
      reason,
      // Nobody can fail to turn up for something that has not started yet.
      guard: (startsAt) => {
        if (Date.now() < startsAt.getTime()) {
          throw new ValidationFailedError({
            status: 'An appointment can only be marked a no-show once its start time has passed.',
          });
        }
      },
    });
  }

  /** `seriesId`: the appointment must be an occurrence of it, checked under the lock. */
  cancel(appointmentId: string, input: CancelAppointmentDto, seriesId?: string) {
    const late = input.lateCancellation ?? false;
    // Overriding the deadline is for people who may cancel anyone's booking.
    if (late && !this.context.hasPermission(COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY)) {
      throw new PermissionDeniedError([COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY]);
    }
    return this.transition(appointmentId, 'CANCELLED', 'appointment.cancelled', {
      reason: input.reason,
      cancellation: true,
      // `appointment:cancel:own` narrows cancellation to your own bookings.
      ownPermission: COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY,
      seriesId,
      // The cancellation deadline, under the row lock.
      guardTx: async (tx, companyId, locked) => {
        const rules = await this.rulesForAppointment(tx, companyId, appointmentId);
        return assertStaffCanCancel(rules, locked.startsAt, late).isLate
          ? ' (late cancellation)'
          : '';
      },
    });
  }

  /**
   * The customer portal's cancellation: the same transition, owned by the
   * customer instead of scoped by staff permissions. `guard` carries the
   * business's rules (deadline), evaluated under the row lock so a request in
   * the last second before the deadline cannot slip past it.
   */
  async cancelByCustomer(
    appointmentId: string,
    customerId: string,
    input: CancelAppointmentDto,
    guard: (startsAt: Date) => void,
  ): Promise<void> {
    await this.transition(appointmentId, 'CANCELLED', 'appointment.cancelled', {
      reason: input.reason,
      cancellation: true,
      customerId,
      guard,
    });
  }

  private async transition(
    appointmentId: string,
    to: AppointmentStatus,
    action: string,
    options: {
      reason?: string;
      cancellation?: boolean;
      ownPermission?: string;
      guard?: (startsAt: Date) => void;
      /** Like `guard`, with the transaction; returns text appended to the reason. */
      guardTx?: (
        tx: TenantTx,
        companyId: string,
        locked: { startsAt: Date; status: AppointmentStatus },
      ) => Promise<string>;
      /**
       * The customer portal: the appointment must be this customer's, checked
       * under the row lock. Another customer's id is a 404, never a 403.
       */
      customerId?: string;
      /** The appointment must be an occurrence of this series. */
      seriesId?: string;
    },
  ) {
    const from = await this.writeGuarded(async (tx, companyId) => {
      const locked = await lockAppointment(tx, companyId, appointmentId);

      if (options.customerId !== undefined && locked.customerId !== options.customerId) {
        throw new ResourceNotFoundError('Appointment', appointmentId);
      }
      if (options.seriesId !== undefined && locked.seriesId !== options.seriesId) {
        throw new ResourceNotFoundError('Appointment', appointmentId);
      }

      if (options.ownPermission) {
        const own = await this.ownScope(tx, companyId, options.ownPermission);
        if (own === 'none') throw new ResourceNotFoundError('Appointment', appointmentId);
        if (own) {
          const mine = await tx.appointmentItem.count({
            where: { companyId, appointmentId, employeeId: own.employeeId },
          });
          if (mine === 0) throw new ResourceNotFoundError('Appointment', appointmentId);
        }
      }

      if (!canTransition(locked.status, to)) {
        throw new InvalidStatusTransitionError(locked.status, to);
      }
      options.guard?.(locked.startsAt);
      const suffix = options.guardTx ? await options.guardTx(tx, companyId, locked) : '';

      await this.applyStatus(tx, companyId, appointmentId, locked.status, to, {
        reason: options.reason ? `${options.reason}${suffix}` : suffix.trim() || undefined,
        cancellation: options.cancellation,
      });
      // However the occurrence changed (staff, the portal, the series card),
      // the series' own status follows it in the same transaction.
      if (locked.seriesId) {
        await syncSeriesStatus(tx, companyId, locked.seriesId, options.reason ?? null);
      }

      const event = STATUS_EVENTS[to];
      if (event) await this.events.emitWithin(tx, companyId, event, { appointmentId });
      // Every transition: the event's text changes, or it leaves the calendar.
      await enqueueCalendarSync(tx, companyId, [appointmentId]);
      return locked.status;
    });

    await this.audit.record({
      action,
      resourceType: 'appointment',
      resourceId: appointmentId,
      before: { status: from },
      after: { status: to },
      metadata: options.reason ? { reason: options.reason } : undefined,
    });

    // The staff detail (internal notes, history) is not the customer's to see;
    // the portal reads back its own projection.
    if (options.customerId !== undefined) return null;
    return this.findById(appointmentId);
  }

  /**
   * Move an appointment, its items and their resource reservations to `to`,
   * and append the history row. The caller holds the row lock.
   */
  private async applyStatus(
    tx: TenantTx,
    companyId: string,
    appointmentId: string,
    from: AppointmentStatus,
    to: AppointmentStatus,
    options: { reason?: string; cancellation?: boolean },
  ) {
    const now = new Date();
    const actor = this.actor();
    const stamp = timestampFor(to);

    const { count } = await tx.appointment.updateMany({
      // Compare-and-swap on the status we read under the lock.
      where: { id: appointmentId, companyId, status: from },
      data: {
        status: to,
        ...(stamp ? { [stamp]: now } : {}),
        ...(options.cancellation
          ? {
              cancelledByType: actor.type,
              cancelledById: actor.id,
              cancellationReason: options.reason ?? null,
            }
          : {}),
      },
    });
    if (count === 0) throw new InvalidStatusTransitionError(from, to);

    // Items carry the status the blocks_calendar trigger reads.
    await tx.appointmentItem.updateMany({
      where: { companyId, appointmentId },
      data: { status: to },
    });

    const items = await tx.appointmentItem.findMany({
      where: { companyId, appointmentId },
      select: { id: true },
    });
    if (items.length > 0) {
      // No trigger maintains this flag on appointment_resource — see
      // appointment-status.ts.
      await tx.appointmentResource.updateMany({
        where: { companyId, appointmentItemId: { in: items.map((i) => i.id) } },
        data: { blocksCalendar: blocksCalendar(to) },
      });
    }

    await tx.appointmentStatusHistory.create({
      data: {
        companyId,
        appointmentId,
        fromStatus: from,
        toStatus: to,
        actorType: actor.type,
        actorId: actor.id,
        actorLabel: actor.label,
        reason: options.reason ?? null,
        changedAt: now,
      },
    });
  }

  // ===========================================================================
  // Booking resolution
  // ===========================================================================

  /**
   * Resolve and cross-check every id in a booking request.
   *
   * Ids that do not exist in this company are 404 — indistinguishable from ids
   * that belong to another company. Ids that exist but do not fit together (an
   * employee who does not provide the service, a room at another branch) are
   * 400 VALIDATION_FAILED naming the field.
   */
  private async resolveBooking(
    tx: TenantTx,
    companyId: string,
    request: {
      branchId: string;
      serviceId: string;
      customerId: string;
      employeeId?: string;
      resourceId?: string;
    },
    publicOnly = false,
  ): Promise<ResolvedBooking> {
    const [branch, customer, service] = await Promise.all([
      tx.branch.findFirst({
        where: { id: request.branchId, companyId, deletedAt: null },
        select: { id: true, name: true, timezoneName: true, status: true },
      }),
      tx.companyCustomer.findFirst({
        where: { id: request.customerId, companyId, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, status: true },
      }),
      tx.service.findFirst({
        where: { id: request.serviceId, companyId, deletedAt: null },
        select: {
          id: true,
          name: true,
          status: true,
          durationMin: true,
          bufferBeforeMin: true,
          bufferAfterMin: true,
          requiresEmployee: true,
          requiresResource: true,
          isOnlineBookable: true,
          priceMinor: true,
          currencyCode: true,
        },
      }),
    ]);

    if (!branch || branch.status === 'INACTIVE') {
      throw new ResourceNotFoundError('Branch', request.branchId);
    }
    if (!customer) throw new ResourceNotFoundError('CompanyCustomer', request.customerId);
    if (!service) throw new ResourceNotFoundError('Service', request.serviceId);
    // On the public page a draft or internal-only service does not exist.
    if (publicOnly && (service.status !== 'ACTIVE' || !service.isOnlineBookable)) {
      throw new ResourceNotFoundError('Service', request.serviceId);
    }

    if (customer.status === 'BLOCKED') {
      throw new ValidationFailedError({ customerId: 'This customer is blocked from booking.' });
    }
    if (service.status !== 'ACTIVE') throw new ServiceNotBookableError(service.status);

    const serviceBranch = await tx.serviceBranch.findFirst({
      where: { companyId, serviceId: service.id, branchId: branch.id },
      select: { isAvailable: true, priceOverrideMinor: true },
    });
    if (!serviceBranch || !serviceBranch.isAvailable) {
      throw new ValidationFailedError({ serviceId: 'This service is not offered at this branch.' });
    }

    if (request.employeeId) {
      if (!service.requiresEmployee) {
        throw new ValidationFailedError({
          employeeId: 'This service is not performed by a specific employee.',
        });
      }
      const employee = await tx.employee.findFirst({
        where: { id: request.employeeId, companyId, deletedAt: null },
        select: {
          id: true,
          services: { where: { companyId, serviceId: service.id }, select: { serviceId: true } },
          branches: { where: { companyId, branchId: branch.id }, select: { branchId: true } },
        },
      });
      if (!employee) throw new ResourceNotFoundError('Employee', request.employeeId);
      if (employee.services.length === 0) {
        throw new ValidationFailedError({
          employeeId: 'This employee does not provide this service.',
        });
      }
      if (employee.branches.length === 0) {
        throw new ValidationFailedError({
          employeeId: 'This employee does not work at this branch.',
        });
      }
    }

    const requirements = service.requiresResource
      ? await tx.serviceResourceRequirement.findMany({
          where: { companyId, serviceId: service.id },
          select: { resourceTypeId: true, quantity: true },
          orderBy: { resourceTypeId: 'asc' },
        })
      : [];

    if (request.resourceId) {
      if (!service.requiresResource) {
        throw new ValidationFailedError({ resourceId: 'This service does not use a resource.' });
      }
      const resource = await tx.resource.findFirst({
        where: { id: request.resourceId, companyId, deletedAt: null },
        select: { id: true, branchId: true, resourceTypeId: true, status: true, isBookable: true },
      });
      if (!resource) throw new ResourceNotFoundError('Resource', request.resourceId);
      if (resource.branchId !== branch.id) {
        throw new ValidationFailedError({ resourceId: 'This resource belongs to another branch.' });
      }
      if (resource.status !== 'ACTIVE' || !resource.isBookable) {
        throw new ValidationFailedError({ resourceId: 'This resource is not bookable.' });
      }
      if (!requirements.some((r) => r.resourceTypeId === resource.resourceTypeId)) {
        throw new ValidationFailedError({
          resourceId: 'This resource is not a type this service requires.',
        });
      }
    }

    return {
      branch: { id: branch.id, name: branch.name, timezoneName: branch.timezoneName },
      customer: {
        id: customer.id,
        name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
      },
      service,
      rules: await loadBookingRules(tx, companyId, { branchId: branch.id, serviceId: service.id }),
      publicOnly,
      branchPriceMinor: serviceBranch.priceOverrideMinor,
      employeeId: request.employeeId,
      resourceId: request.resourceId,
      requirements,
    };
  }

  /**
   * Step 1: the requested start must be a slot the Availability Engine offers.
   * Runs outside the write transaction — the engine opens its own.
   */
  private async offeredSlot(
    booking: ResolvedBooking,
    startsAt: Date,
    excludeAppointmentId?: string,
    publicOnly = false,
  ): Promise<AvailabilitySlotDto> {
    try {
      return await this.findOfferedSlot(booking, startsAt, excludeAppointmentId, publicOnly);
    } catch (error) {
      if (!(error instanceof SlotUnavailableError)) throw error;
      // Say WHY, where it can be said exactly: time off, an unavailable
      // resource, or the service's concurrency cap.
      throw (await this.explainUnavailable(booking, startsAt, excludeAppointmentId)) ?? error;
    }
  }

  private async findOfferedSlot(
    booking: ResolvedBooking,
    startsAt: Date,
    excludeAppointmentId: string | undefined,
    publicOnly: boolean,
  ): Promise<AvailabilitySlotDto> {
    const date = todayInZone(booking.branch.timezoneName, startsAt);
    const day = await this.availability.getDay(
      { branchId: booking.branch.id, serviceId: booking.service.id, date },
      { excludeAppointmentId, publicOnly },
    );

    const slot = day.slots.find((s) => Date.parse(s.startAt) === startsAt.getTime());
    if (!slot) {
      throw new SlotUnavailableError({
        reason: day.unavailableReason ?? 'NOT_OFFERED',
        startsAt: startsAt.toISOString(),
      });
    }

    if (booking.employeeId && !slot.employeeIds.includes(booking.employeeId)) {
      throw new SlotUnavailableError({
        reason: 'EMPLOYEE_NOT_AVAILABLE',
        startsAt: startsAt.toISOString(),
      });
    }
    if (booking.resourceId && !slot.resourceIds.includes(booking.resourceId)) {
      throw new SlotUnavailableError({
        reason: 'RESOURCE_NOT_AVAILABLE',
        startsAt: startsAt.toISOString(),
      });
    }
    return slot;
  }

  /**
   * Choose the concrete employee and resources for the slot.
   *
   * A named employee or resource is used as given (already proven eligible and
   * free). Otherwise the first candidate by id is taken — deterministic, never
   * random. Allocation strategies (least booked, preferred) can replace this
   * one function later.
   */
  private async assign(
    tx: TenantTx,
    companyId: string,
    booking: ResolvedBooking,
    slot: AvailabilitySlotDto,
  ): Promise<Assignment> {
    const employeeId = booking.service.requiresEmployee
      ? (booking.employeeId ?? [...slot.employeeIds].sort()[0] ?? null)
      : null;
    if (booking.service.requiresEmployee && !employeeId) {
      throw new SlotUnavailableError({ reason: 'NO_ELIGIBLE_EMPLOYEE', startsAt: slot.startAt });
    }

    const resourceIds: string[] = [];
    if (booking.service.requiresResource) {
      const candidates = slot.resourceIds.length
        ? await tx.resource.findMany({
            where: { companyId, id: { in: [...slot.resourceIds] } },
            select: { id: true, resourceTypeId: true },
            orderBy: { id: 'asc' },
          })
        : [];

      for (const requirement of booking.requirements) {
        const ofType = candidates.filter((c) => c.resourceTypeId === requirement.resourceTypeId);
        const chosen: string[] = [];
        if (booking.resourceId && ofType.some((c) => c.id === booking.resourceId)) {
          chosen.push(booking.resourceId);
        }
        for (const c of ofType) {
          if (chosen.length >= requirement.quantity) break;
          if (!chosen.includes(c.id)) chosen.push(c.id);
        }
        if (chosen.length < requirement.quantity) {
          throw new SlotUnavailableError({
            reason: 'NO_ELIGIBLE_RESOURCE',
            startsAt: slot.startAt,
          });
        }
        resourceIds.push(...chosen);
      }
    }

    const [employee, employeeService, resources] = await Promise.all([
      employeeId
        ? tx.employee.findFirst({
            where: { id: employeeId, companyId },
            select: { id: true, displayName: true },
          })
        : Promise.resolve(null),
      employeeId
        ? tx.employeeService.findFirst({
            where: { companyId, employeeId, serviceId: booking.service.id },
            select: { priceOverrideMinor: true },
          })
        : Promise.resolve(null),
      resourceIds.length
        ? tx.resource.findMany({
            where: { companyId, id: { in: resourceIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      employeeId,
      employeeName: employee?.displayName ?? null,
      employeePriceMinor: employeeService?.priceOverrideMinor ?? null,
      resources: resourceIds.map((id) => ({
        id,
        name: resources.find((r) => r.id === id)?.name ?? null,
      })),
    };
  }

  /**
   * Step 2: serialise on the employee and each resource, then re-read their
   * reservations inside the transaction.
   *
   * `pg_advisory_xact_lock` is released at COMMIT/ROLLBACK. Keys are sorted so
   * two requests needing the same pair always lock in the same order and cannot
   * deadlock.
   */
  private async lockAndCheck(
    tx: TenantTx,
    companyId: string,
    assignment: Assignment,
    slot: AvailabilitySlotDto,
    excludeAppointmentId?: string,
    cap: { branchId: string; serviceId: string; limit: number } | null = null,
  ) {
    await lockKeys(tx, [
      ...(assignment.employeeId ? [employeeLockKey(companyId, assignment.employeeId)] : []),
      ...assignment.resources.map((r) => resourceLockKey(companyId, r.id)),
      ...(cap ? [`appt:${companyId}:cap:${cap.branchId}:${cap.serviceId}`] : []),
    ]);

    const reserved: Interval = {
      start: Date.parse(slot.reservedFrom),
      end: Date.parse(slot.reservedTo),
    };
    const scanStart = new Date(reserved.start - CONFLICT_SCAN_MARGIN_MS);
    const scanEnd = new Date(reserved.end + CONFLICT_SCAN_MARGIN_MS);
    const notSelf = excludeAppointmentId ? { appointmentId: { not: excludeAppointmentId } } : {};

    if (assignment.employeeId) {
      const items = await tx.appointmentItem.findMany({
        where: {
          companyId,
          employeeId: assignment.employeeId,
          blocksCalendar: true,
          startsAt: { lt: scanEnd },
          endsAt: { gt: scanStart },
          ...notSelf,
        },
        select: { startsAt: true, endsAt: true, bufferBeforeMin: true, bufferAfterMin: true },
      });
      const clash = items.some((i) =>
        overlaps(reserved, {
          start: i.startsAt.getTime() - i.bufferBeforeMin * MINUTE_MS,
          end: i.endsAt.getTime() + i.bufferAfterMin * MINUTE_MS,
        }),
      );
      if (clash) throw new SlotTakenError('employee');

      // Time off approved after the availability check: it took the same lock
      // (TimeOffService), so it is either visible now or will see this booking.
      const away = await tx.employeeTimeOff.findFirst({
        where: {
          companyId,
          employeeId: assignment.employeeId,
          status: 'APPROVED',
          startsAt: { lt: new Date(reserved.end) },
          endsAt: { gt: new Date(reserved.start) },
        },
        select: { id: true },
      });
      // Generic reason: the public booking page must not learn about absences.
      if (away) {
        throw new SlotUnavailableError({
          reason: 'EMPLOYEE_NOT_AVAILABLE',
          startsAt: slot.startAt,
        });
      }
    }

    if (assignment.resources.length > 0) {
      const reservations = await tx.appointmentResource.findMany({
        where: {
          companyId,
          resourceId: { in: assignment.resources.map((r) => r.id) },
          blocksCalendar: true,
          startsAt: { lt: scanEnd },
          endsAt: { gt: scanStart },
          ...(excludeAppointmentId
            ? { appointmentItem: { appointmentId: { not: excludeAppointmentId } } }
            : {}),
        },
        select: { startsAt: true, endsAt: true },
      });
      const clash = reservations.some((r) =>
        overlaps(reserved, { start: r.startsAt.getTime(), end: r.endsAt.getTime() }),
      );
      if (clash) throw new SlotTakenError('resource');

      // A block added after the availability check (same lock, ResourcesService).
      const blocked = await tx.resourceUnavailability.findFirst({
        where: {
          companyId,
          resourceId: { in: assignment.resources.map((r) => r.id) },
          startsAt: { lt: new Date(reserved.end) },
          endsAt: { gt: new Date(reserved.start) },
        },
        select: { id: true },
      });
      if (blocked) {
        throw new SlotUnavailableError({ reason: 'RESOURCE_UNAVAILABLE', startsAt: slot.startAt });
      }
    }

    // The service's concurrency cap: serialised on (branch, service) above, so
    // two bookings racing for the last place cannot both see room.
    if (cap) {
      const overlapping = await tx.appointmentItem.count({
        where: {
          companyId,
          branchId: cap.branchId,
          serviceId: cap.serviceId,
          blocksCalendar: true,
          startsAt: { lt: new Date(slot.endAt) },
          endsAt: { gt: new Date(slot.startAt) },
          ...notSelf,
        },
      });
      if (overlapping >= cap.limit) {
        throw new SlotUnavailableError({
          reason: 'MAX_CONCURRENT_BOOKINGS',
          startsAt: slot.startAt,
          maxConcurrentBookings: cap.limit,
        });
      }
    }
  }

  /** Step 3: the rows. The exclusion constraint is watching. */
  private async insert(
    tx: TenantTx,
    companyId: string,
    args: {
      booking: ResolvedBooking;
      slot: AvailabilitySlotDto;
      assignment: Assignment;
      status: AppointmentStatus;
      source: CreateAppointmentDto['source'];
      customerNote: string | null;
      internalNote: string | null;
      rescheduledFromId: string | null;
      historyReason: string;
      seriesId?: string | null;
      seriesIndex?: number | null;
      priceMinor?: bigint;
      /**
       * A discount already granted, carried over by a reschedule along with its
       * booking-time snapshot. New discounts are applied through
       * PromotionsService after insert, never passed in here.
       */
      carriedDiscount?: { discountMinor: bigint; promotions: unknown[] };
    },
  ) {
    const { booking, slot, assignment, status } = args;
    const now = new Date();
    const actor = this.actor();
    const startsAt = new Date(slot.startAt);
    const endsAt = new Date(slot.endAt);
    const priceMinor =
      args.priceMinor ??
      bookingPrice({
        servicePriceMinor: booking.service.priceMinor,
        branchOverrideMinor: booking.branchPriceMinor,
        employeeOverrideMinor: assignment.employeePriceMinor,
      });
    const discountMinor =
      args.carriedDiscount && args.carriedDiscount.discountMinor > 0n
        ? args.carriedDiscount.discountMinor > priceMinor
          ? priceMinor
          : args.carriedDiscount.discountMinor
        : 0n;
    const totalMinor = priceMinor - discountMinor;

    const appointment = await tx.appointment.create({
      data: {
        companyId,
        branchId: booking.branch.id,
        customerId: booking.customer.id,
        appointmentNumber: await uniqueAppointmentNumber(tx, companyId),
        status,
        source: args.source,
        startsAt,
        endsAt,
        bookedTimezoneName: booking.branch.timezoneName,
        subtotalMinor: priceMinor,
        discountMinor,
        totalMinor,
        currencyCode: booking.service.currencyCode,
        customerNote: args.customerNote,
        internalNote: args.internalNote,
        createdByType: actor.type,
        createdById: actor.id,
        confirmedAt: status === 'CONFIRMED' ? now : null,
        rescheduledFromId: args.rescheduledFromId,
        seriesId: args.seriesId ?? null,
        seriesIndex: args.seriesIndex ?? null,
      },
    });

    const item = await tx.appointmentItem.create({
      data: {
        companyId,
        appointmentId: appointment.id,
        branchId: booking.branch.id,
        serviceId: booking.service.id,
        employeeId: assignment.employeeId,
        status,
        sequence: 0,
        startsAt,
        endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / MINUTE_MS),
        bufferBeforeMin: booking.service.bufferBeforeMin,
        bufferAfterMin: booking.service.bufferAfterMin,
        unitPriceMinor: priceMinor,
        discountMinor,
        totalMinor,
        // What was booked, as it was. The service may be renamed or repriced
        // later; this appointment keeps saying what the customer agreed to.
        snapshot: {
          serviceName: booking.service.name,
          durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / MINUTE_MS),
          bufferBeforeMin: booking.service.bufferBeforeMin,
          bufferAfterMin: booking.service.bufferAfterMin,
          priceMinor: priceMinor.toString(),
          currencyCode: booking.service.currencyCode,
          branchName: booking.branch.name,
          employeeName: assignment.employeeName,
          resources: assignment.resources,
          ...(args.carriedDiscount?.promotions.length
            ? { promotions: args.carriedDiscount.promotions }
            : {}),
        } as Prisma.InputJsonValue,
        // blocks_calendar and reserved_range are set by triggers.
      },
    });

    if (assignment.resources.length > 0) {
      await tx.appointmentResource.createMany({
        data: assignment.resources.map((r) => ({
          companyId,
          appointmentItemId: item.id,
          resourceId: r.id,
          // The room is occupied for the buffered window, not just the service.
          startsAt: new Date(slot.reservedFrom),
          endsAt: new Date(slot.reservedTo),
          blocksCalendar: blocksCalendar(status),
        })),
      });
    }

    await tx.appointmentStatusHistory.create({
      data: {
        companyId,
        appointmentId: appointment.id,
        fromStatus: null,
        toStatus: status,
        actorType: actor.type,
        actorId: actor.id,
        actorLabel: actor.label,
        reason: args.historyReason,
        changedAt: now,
      },
    });

    return { ...appointment, itemId: item.id };
  }

  // ===========================================================================
  // Booking rules
  // ===========================================================================

  /**
   * Notice and advance window, with a reason a person can act on. The
   * availability engine applies the same two rules (same resolver), so this
   * only turns "not offered" into "too soon" / "too far ahead".
   */
  private checkTiming(booking: ResolvedBooking, startsAt: Date) {
    const now = Date.now();
    const at = startsAt.toISOString();
    if (startsAt.getTime() < now)
      throw new SlotUnavailableError({ reason: 'DATE_IN_PAST', startsAt: at });
    if (startsAt.getTime() < now + booking.rules.minimumNoticeMinutes * MINUTE_MS) {
      throw new SlotUnavailableError({
        reason: 'MINIMUM_NOTICE',
        startsAt: at,
        minimumNoticeMinutes: booking.rules.minimumNoticeMinutes,
      });
    }
    const tz = booking.branch.timezoneName;
    if (
      daysBetween(todayInZone(tz), todayInZone(tz, startsAt)) > booking.rules.maximumAdvanceDays
    ) {
      throw new SlotUnavailableError({
        reason: 'BEYOND_BOOKING_WINDOW',
        startsAt: at,
        maximumAdvanceDays: booking.rules.maximumAdvanceDays,
      });
    }
  }

  private async rulesForAppointment(tx: TenantTx, companyId: string, appointmentId: string) {
    const row = await tx.appointment.findFirst({
      where: { id: appointmentId, companyId },
      select: {
        branchId: true,
        items: { orderBy: { sequence: 'asc' }, take: 1, select: { serviceId: true } },
      },
    });
    return loadBookingRules(tx, companyId, {
      branchId: row?.branchId,
      serviceId: row?.items[0]?.serviceId,
    });
  }

  /**
   * Why a time is not offered, when it can be said exactly. Staff screens
   * only: a public caller is never told that a named employee is away.
   */
  private async explainUnavailable(
    booking: ResolvedBooking,
    startsAt: Date,
    excludeAppointmentId: string | undefined,
  ): Promise<SlotUnavailableError | null> {
    const end = new Date(startsAt.getTime() + booking.service.durationMin * MINUTE_MS);
    const at = startsAt.toISOString();
    const overlapping = { startsAt: { lt: end }, endsAt: { gt: startsAt } };
    return this.appointments.transaction(async (tx, companyId) => {
      if (booking.employeeId && !booking.publicOnly) {
        const away = await tx.employeeTimeOff.findFirst({
          where: { companyId, employeeId: booking.employeeId, status: 'APPROVED', ...overlapping },
          select: { id: true },
        });
        if (away) return new SlotUnavailableError({ reason: 'EMPLOYEE_TIME_OFF', startsAt: at });
      }
      if (booking.resourceId) {
        const blocked = await tx.resourceUnavailability.findFirst({
          where: { companyId, resourceId: booking.resourceId, ...overlapping },
          select: { id: true },
        });
        if (blocked)
          return new SlotUnavailableError({ reason: 'RESOURCE_UNAVAILABLE', startsAt: at });
      } else {
        // Any free resource of each required type will do: unavailable only
        // when too few of a type are left once blocked periods are removed.
        for (const req of booking.requirements) {
          const pool = await tx.resource.findMany({
            where: {
              companyId,
              branchId: booking.branch.id,
              resourceTypeId: req.resourceTypeId,
              status: 'ACTIVE',
              isBookable: true,
              deletedAt: null,
            },
            select: {
              id: true,
              unavailability: { where: overlapping, select: { id: true }, take: 1 },
            },
          });
          const free = pool.filter((r) => r.unavailability.length === 0).length;
          if (pool.length >= req.quantity && free < req.quantity) {
            return new SlotUnavailableError({ reason: 'RESOURCE_UNAVAILABLE', startsAt: at });
          }
        }
      }
      const cap = booking.rules.maxConcurrentBookings;
      if (cap) {
        const count = await tx.appointmentItem.count({
          where: {
            companyId,
            branchId: booking.branch.id,
            serviceId: booking.service.id,
            blocksCalendar: true,
            ...overlapping,
            ...(excludeAppointmentId ? { appointmentId: { not: excludeAppointmentId } } : {}),
          },
        });
        if (count >= cap) {
          return new SlotUnavailableError({
            reason: 'MAX_CONCURRENT_BOOKINGS',
            startsAt: at,
            maxConcurrentBookings: cap,
          });
        }
      }
      return null;
    });
  }

  // ===========================================================================
  // Recurring series
  // ===========================================================================

  /** Every occurrence, checked exactly as a single booking would be. Writes nothing. */
  async previewSeries(input: CreateSeriesDto) {
    return seriesPreview(await this.planSeries(input));
  }

  /**
   * Create a recurring series: every occurrence is an ordinary appointment,
   * validated by the same availability check, rules, locks and exclusion
   * constraint as any other booking — and all of them are written in ONE
   * transaction. If any is taken in the meantime, none are created.
   *
   * `onConflict: 'fail'` (default) refuses the whole series when any date
   * cannot be booked; `'skip'` books the others and reports the rest. A
   * conflicting appointment is never created.
   */
  async createSeries(input: CreateSeriesDto) {
    const planned = await this.planSeries(input);
    const preview = seriesPreview(planned);
    const bookable = planned.checked.filter((c) => c.slot !== null);
    if (
      bookable.length === 0 ||
      (bookable.length < planned.checked.length && input.onConflict === 'fail')
    ) {
      throw new SeriesConflictError(preview.occurrences.filter((o) => !o.bookable));
    }
    const actor = this.actor();
    const total = bookable.length;

    const { series, created } = await this.writeGuarded(async (tx, companyId) => {
      const settings = await tx.companySettings.findFirst({
        where: { companyId },
        select: { autoConfirmBookings: true },
      });
      const status: AppointmentStatus =
        settings?.autoConfirmBookings === false ? 'PENDING' : 'CONFIRMED';
      const series = await tx.appointmentSeries.create({
        data: {
          companyId,
          branchId: planned.booking.branch.id,
          customerId: planned.booking.customer.id,
          serviceId: planned.booking.service.id,
          employeeId: input.employeeId ?? null,
          resourceId: input.resourceId ?? null,
          frequency: input.recurrence.frequency,
          interval: input.recurrence.interval,
          weekdays: input.recurrence.weekdays ?? [],
          startsAt: planned.firstStart,
          localStartTime: planned.localStartTime,
          timezoneName: planned.booking.branch.timezoneName,
          untilDate: input.recurrence.endDate
            ? new Date(`${input.recurrence.endDate}T00:00:00.000Z`)
            : null,
          occurrenceCount: input.recurrence.endDate ? null : (input.recurrence.count ?? null),
          createdByType: actor.type,
          createdById: actor.id,
        },
      });

      const created: Array<{ id: string; appointmentNumber: string; startsAt: Date }> = [];
      for (const occurrence of bookable) {
        const slot = occurrence.slot!;
        // The series' employee where they are free for this date, else the slot's own choice.
        const employeeId =
          planned.employeeId && slot.employeeIds.includes(planned.employeeId)
            ? planned.employeeId
            : planned.booking.employeeId;
        const booking = { ...planned.booking, employeeId };
        const assignment = await this.assign(tx, companyId, booking, slot);
        await this.lockAndCheck(tx, companyId, assignment, slot, undefined, capOf(booking));
        await this.entitlements.assertCanAdd(tx, companyId, 'APPOINTMENT');
        const appointment = await this.insert(tx, companyId, {
          booking,
          slot,
          assignment,
          status,
          source: input.source,
          customerNote: input.customerNote ?? null,
          internalNote: input.internalNote ?? null,
          rescheduledFromId: null,
          historyReason: `Recurring series: ${occurrence.index + 1} of ${planned.checked.length}`,
          seriesId: series.id,
          seriesIndex: occurrence.index,
        });
        created.push(appointment);
      }

      // ONE message about the series (its first visit), not one per date;
      // each occurrence still gets its own reminder when it comes due.
      await this.events.emitWithin(tx, companyId, NOTIFICATION_EVENTS.APPOINTMENT_CREATED, {
        appointmentId: created[0]!.id,
        seriesId: series.id,
        occurrences: created.length,
      });
      await enqueueCalendarSync(
        tx,
        companyId,
        created.map((a) => a.id),
      );
      return { series, created };
    });

    await this.audit.record({
      action: 'appointment_series.created',
      resourceType: 'appointment_series',
      resourceId: series.id,
      after: {
        frequency: series.frequency,
        interval: series.interval,
        weekdays: series.weekdays,
        occurrences: total,
        skipped: planned.checked.length - total,
        appointmentIds: created.map((a) => a.id),
      },
    });
    this.logger.log(`Series ${series.id} created with ${total} occurrences`);

    return {
      ...(await this.findSeries(series.id)),
      skipped: preview.occurrences.filter((o) => !o.bookable),
    };
  }

  async findSeries(seriesId: string) {
    return this.appointments.transaction(async (tx, companyId) => {
      const own = await this.ownScope(tx, companyId, COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY);
      if (own === 'none') throw new ResourceNotFoundError('AppointmentSeries', seriesId);
      const series = await tx.appointmentSeries.findFirst({
        where: { id: seriesId, companyId },
        include: {
          branch: { select: { id: true, name: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
          service: { select: { id: true, name: true } },
        },
      });
      if (!series) throw new ResourceNotFoundError('AppointmentSeries', seriesId);
      const occurrences = await tx.appointment.findMany({
        where: {
          companyId,
          seriesId,
          ...(own ? { items: { some: { companyId, employeeId: own.employeeId } } } : {}),
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        include: summaryInclude(companyId),
      });
      if (own && occurrences.length === 0)
        throw new ResourceNotFoundError('AppointmentSeries', seriesId);
      return toSeries(series, occurrences.map(toSummary));
    });
  }

  /**
   * Cancel one occurrence, or every occurrence from a moment on. Each goes
   * through the same status transition and cancellation deadline as a single
   * cancellation, all in one transaction: if one is past its deadline and not
   * confirmed as late, none are cancelled.
   */
  async cancelSeries(seriesId: string, input: CancelSeriesDto) {
    const late = input.lateCancellation ?? false;
    if (late && !this.context.hasPermission(COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY)) {
      throw new PermissionDeniedError([COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY]);
    }

    if (input.scope === 'occurrence') {
      // One transaction: series membership is checked under the row lock, and
      // the transition syncs the series status itself.
      await this.cancel(
        input.appointmentId!,
        { reason: input.reason, lateCancellation: late },
        seriesId,
      );
      return this.findSeries(seriesId);
    }

    // Many bookings at once: for people who may cancel anyone's.
    if (!this.context.hasPermission(COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY)) {
      throw new PermissionDeniedError([COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY]);
    }
    const from = input.from ? new Date(input.from) : new Date();

    const cancelled = await this.writeGuarded(async (tx, companyId) => {
      const series = await tx.appointmentSeries.findFirst({ where: { id: seriesId, companyId } });
      if (!series) throw new ResourceNotFoundError('AppointmentSeries', seriesId);
      const rules = await loadBookingRules(tx, companyId, {
        branchId: series.branchId,
        serviceId: series.serviceId,
      });
      const targets = await tx.appointment.findMany({
        where: { companyId, seriesId, startsAt: { gte: from } },
        orderBy: { startsAt: 'asc' },
        select: { id: true },
      });

      const ids: string[] = [];
      for (const target of targets) {
        const locked = await lockAppointment(tx, companyId, target.id);
        if (!canTransition(locked.status, 'CANCELLED')) continue;
        const { isLate } = assertStaffCanCancel(rules, locked.startsAt, late);
        await this.applyStatus(tx, companyId, target.id, locked.status, 'CANCELLED', {
          reason: `${input.reason} (series${isLate ? ', late cancellation' : ''})`,
          cancellation: true,
        });
        ids.push(target.id);
      }
      if (ids.length > 0) {
        // One message for the series, not one per date.
        await this.events.emitWithin(tx, companyId, NOTIFICATION_EVENTS.APPOINTMENT_CANCELLED, {
          appointmentId: ids[0],
          seriesId,
          occurrences: ids.length,
        });
        await enqueueCalendarSync(tx, companyId, ids);
      }
      await syncSeriesStatus(tx, companyId, seriesId, input.reason);
      return ids;
    });

    await this.audit.record({
      action: 'appointment_series.cancelled',
      resourceType: 'appointment_series',
      resourceId: seriesId,
      after: { from: from.toISOString(), cancelled: cancelled.length, appointmentIds: cancelled },
      metadata: { reason: input.reason },
    });
    return { ...(await this.findSeries(seriesId)), cancelledCount: cancelled.length };
  }

  /** Resolve, plan and check every occurrence. Shared by preview and create. */
  private async planSeries(input: CreateSeriesDto) {
    const firstStart = new Date(input.startsAt);
    const booking = await this.appointments.transaction((tx, companyId) =>
      this.resolveBooking(tx, companyId, {
        branchId: input.branchId,
        serviceId: input.serviceId,
        customerId: input.customerId,
        employeeId: input.employeeId,
        resourceId: input.resourceId,
      }),
    );
    const tz = booking.branch.timezoneName;
    // The first occurrence's local date and wall-clock time: what recurs.
    const local = toIsoWithOffset(firstStart, tz);
    const startDate = parsePlainDate(local.slice(0, 10));
    const localStartTime = local.slice(11, 16);
    const startMinutes = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
    const untilDate = input.recurrence.endDate
      ? parsePlainDate(input.recurrence.endDate)
      : undefined;
    if (untilDate && untilDate < startDate) {
      throw new ValidationFailedError({
        'recurrence.endDate': 'The end date is before the first appointment.',
      });
    }

    const plan = planOccurrences(
      {
        frequency: input.recurrence.frequency,
        interval: input.recurrence.interval,
        weekdays: input.recurrence.weekdays ?? [],
        startDate,
        startMinutes,
        untilDate,
        count: input.recurrence.count,
      },
      tz,
    );
    if (plan.truncated) {
      throw new ValidationFailedError({
        recurrence: 'A series can have at most 52 appointments. Choose an earlier end date.',
      });
    }
    if (plan.occurrences.length === 0) {
      throw new ValidationFailedError({ recurrence: 'This repeat rule produces no dates.' });
    }

    const checked: Array<{
      index: number;
      date: string;
      startsAt: Date;
      slot: AvailabilitySlotDto | null;
      reason: string | null;
      message: string | null;
    }> = [];
    for (const occurrence of plan.occurrences) {
      try {
        this.checkTiming(booking, occurrence.startsAt);
        const slot = await this.offeredSlot(booking, occurrence.startsAt);
        checked.push({ ...occurrence, slot, reason: null, message: null });
      } catch (error) {
        if (!(error instanceof SlotUnavailableError)) throw error;
        checked.push({
          ...occurrence,
          slot: null,
          reason: typeof error.details?.reason === 'string' ? error.details.reason : 'NOT_OFFERED',
          message: error.message,
        });
      }
    }

    // One person for the whole series when someone is free for every date.
    let employeeId = booking.employeeId ?? null;
    if (booking.service.requiresEmployee && !employeeId) {
      const lists = checked.flatMap((c) => (c.slot ? [c.slot.employeeIds] : []));
      const common = lists.length ? lists.reduce((a, b) => a.filter((id) => b.includes(id))) : [];
      employeeId = [...common].sort()[0] ?? null;
    }

    return { booking, plan, checked, employeeId, firstStart, localStartTime, tz };
  }

  // ===========================================================================
  // Plumbing
  // ===========================================================================

  /**
   * Run a write transaction, turning a double-booking constraint violation
   * into SLOT_TAKEN and retrying once on an appointment-number collision.
   */
  private async writeGuarded<T>(fn: (tx: TenantTx, companyId: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.appointments.transaction(fn);
      } catch (error) {
        const slot = asSlotTaken(error);
        if (slot) throw slot;
        if (attempt < 2 && isNumberCollision(error)) continue;
        throw error;
      }
    }
  }

  /**
   * `null`             — the caller holds the `:any` permission: no narrowing.
   * `{ employeeId }`   — the caller holds only `:own`: narrow to this employee.
   * `'none'`           — only `:own`, but no employee is linked to the caller.
   */
  private async ownScope(
    tx: TenantTx,
    companyId: string,
    anyPermission: string,
  ): Promise<OwnScope> {
    if (this.context.hasPermission(anyPermission)) return null;

    const actor = this.context.actor;
    if (!actor || actor.kind !== 'COMPANY_USER') return 'none';

    const employee = await tx.employee.findFirst({
      where: { companyId, userAccountId: actor.userAccountId, deletedAt: null },
      select: { id: true },
    });
    return employee ? { employeeId: employee.id } : 'none';
  }

  private actor(): { type: ActorType; id: string | null; label: string } {
    const actor = this.context.requireActor();
    const label = actorLabel(actor);
    switch (actor.kind) {
      case 'COMPANY_USER':
        return {
          type: 'COMPANY_USER',
          id: this.context.membership()?.companyUserId ?? null,
          label,
        };
      case 'PLATFORM_USER':
        return { type: 'PLATFORM_USER', id: actor.platformUserId, label };
      case 'CUSTOMER':
        return { type: 'CUSTOMER', id: actor.companyCustomerId, label };
      case 'SYSTEM':
        return { type: 'SYSTEM', id: null, label };
    }
  }
}

// ===========================================================================
// Types
// ===========================================================================

interface ResolvedBooking {
  branch: { id: string; name: string; timezoneName: string };
  customer: { id: string; name: string };
  service: {
    id: string;
    name: string;
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    requiresEmployee: boolean;
    requiresResource: boolean;
    priceMinor: bigint;
    currencyCode: string;
  };
  rules: BookingRules;
  /** Resolved for the public booking page: never explain staff absences. */
  publicOnly?: boolean;
  branchPriceMinor: bigint | null;
  employeeId?: string;
  resourceId?: string;
  requirements: Array<{ resourceTypeId: string; quantity: number }>;
}

type OwnScope = null | { employeeId: string } | 'none';

/** What `book()` returns: enough to confirm a booking, nothing internal. */
export interface BookedAppointment {
  id: string;
  appointmentNumber: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  timezone: string;
  branch: { id: string; name: string };
  service: { id: string; name: string; durationMin: number };
  employee: { id: string; name: string } | null;
  /** Before discount. */
  subtotalMinor: string;
  discountMinor: string;
  /** What the customer pays. Never negative. */
  totalMinor: string;
  currencyCode: string;
  promotion: { name: string; code: string | null } | null;
}

interface Assignment {
  employeeId: string | null;
  employeeName: string | null;
  employeePriceMinor: bigint | null;
  resources: Array<{ id: string; name: string | null }>;
}

// ===========================================================================
// Module helpers
// ===========================================================================

/** The service's concurrency cap at the branch, for lockAndCheck. */
function capOf(booking: ResolvedBooking) {
  return booking.rules.maxConcurrentBookings
    ? {
        branchId: booking.branch.id,
        serviceId: booking.service.id,
        limit: booking.rules.maxConcurrentBookings,
      }
    : null;
}

async function lockAppointment(tx: TenantTx, companyId: string, appointmentId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      status: AppointmentStatus;
      starts_at: Date;
      customer_id: string;
      series_id: string | null;
    }>
  >`
    SELECT id, status, starts_at, customer_id, series_id
      FROM appointment
     WHERE id = ${appointmentId}::uuid AND company_id = ${companyId}::uuid
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new ResourceNotFoundError('Appointment', appointmentId);
  return {
    id: row.id,
    status: row.status,
    startsAt: row.starts_at,
    customerId: row.customer_id,
    seriesId: row.series_id,
  };
}

/**
 * Map an exclusion-constraint violation to SLOT_TAKEN.
 *
 * Prisma surfaces SQLSTATE 23P01 as a PrismaClientUnknownRequestError whose
 * message carries the code and the constraint name, with no structured `code`
 * field — verified against this schema. Matching the constraint names keeps
 * this from swallowing an unrelated exclusion constraint added later.
 */
export function asSlotTaken(error: unknown): SlotTakenError | null {
  if (error instanceof SlotTakenError) return error;
  const message = error instanceof Error ? error.message : '';
  if (!message.includes('23P01')) return null;
  if (message.includes('appointment_item_employee_no_overlap'))
    return new SlotTakenError('employee');
  if (message.includes('appointment_resource_no_overlap')) return new SlotTakenError('resource');
  return null;
}

function isNumberCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta?.target ?? '').includes('appointment_number')
  );
}

/** `APT-20261006-7KQ2MX` — no O/0/I/1 for somebody reading it down a phone. */
function generateAppointmentNumber(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (const byte of randomBytes(6)) suffix += alphabet[byte % alphabet.length];
  return `APT-${day}-${suffix}`;
}

async function uniqueAppointmentNumber(tx: TenantTx, companyId: string): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    const candidate = generateAppointmentNumber();
    const taken = await tx.appointment.count({
      where: { companyId, appointmentNumber: candidate },
    });
    if (taken === 0) return candidate;
  }
  // Astronomically unlikely; the unique index is the backstop and
  // writeGuarded retries the whole transaction on P2002.
  return generateAppointmentNumber();
}

function buildWhere(
  companyId: string,
  query: AppointmentQueryDto,
  ownEmployeeId: string | null,
): Prisma.AppointmentWhereInput {
  const startsAt: Prisma.DateTimeFilter = {};
  if (query.from) startsAt.gte = new Date(`${query.from}T00:00:00.000Z`);
  if (query.to) {
    const end = new Date(`${query.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    startsAt.lt = end;
  }

  const employeeId = ownEmployeeId ?? query.employeeId;
  const itemFilter: Prisma.AppointmentItemWhereInput = {
    ...(employeeId ? { employeeId } : {}),
    ...(query.serviceId ? { serviceId: query.serviceId } : {}),
    ...(query.resourceId
      ? { resources: { some: { companyId, resourceId: query.resourceId } } }
      : {}),
  };
  // An `own` caller filtering by someone else's employee id sees nothing.
  const contradictory = Boolean(
    ownEmployeeId && query.employeeId && query.employeeId !== ownEmployeeId,
  );
  const statuses = parseStatuses(query.status);

  return {
    companyId,
    ...(contradictory ? { id: { in: [] } } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(query.search ? { appointmentNumber: { contains: query.search.toUpperCase() } } : {}),
    ...(query.from || query.to ? { startsAt } : {}),
    ...(Object.keys(itemFilter).length ? { items: { some: { companyId, ...itemFilter } } } : {}),
  };
}

function summaryInclude(companyId: string) {
  return {
    branch: { select: { id: true, name: true } },
    customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
    items: {
      where: { companyId },
      orderBy: { sequence: 'asc' as const },
      include: {
        service: { select: { id: true, name: true } },
        employee: { select: { id: true, displayName: true } },
        resources: {
          where: { companyId },
          include: { resource: { select: { id: true, name: true } } },
        },
      },
    },
  } satisfies Prisma.AppointmentInclude;
}

type SummaryRow = Prisma.AppointmentGetPayload<{ include: ReturnType<typeof summaryInclude> }>;

function toSummary(row: SummaryRow) {
  const tz = row.bookedTimezoneName;
  const item = row.items[0];
  return {
    id: row.id,
    appointmentNumber: row.appointmentNumber,
    status: row.status,
    paymentStatus: row.paymentStatus,
    source: row.source,
    startsAt: toIsoWithOffset(row.startsAt, tz),
    endsAt: toIsoWithOffset(row.endsAt, tz),
    timezone: tz,
    branch: { id: row.branch.id, name: row.branch.name },
    customer: {
      id: row.customer.id,
      name: [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' '),
      phone: row.customer.phone,
      email: row.customer.email,
    },
    service: item
      ? { id: item.service.id, name: snapshotName(item.snapshot) ?? item.service.name }
      : null,
    employee: item?.employee ? { id: item.employee.id, name: item.employee.displayName } : null,
    resources: item?.resources.map((r) => ({ id: r.resource.id, name: r.resource.name })) ?? [],
    totalMinor: row.totalMinor.toString(),
    currencyCode: row.currencyCode,
    /** The recurring series this belongs to, if any, and its place in it. */
    seriesId: row.seriesId,
    seriesIndex: row.seriesIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type DetailRow = SummaryRow & {
  statusHistory: Array<{
    id: string;
    fromStatus: AppointmentStatus | null;
    toStatus: AppointmentStatus;
    actorType: ActorType;
    actorLabel: string | null;
    reason: string | null;
    changedAt: Date;
  }>;
  rescheduledTo: Array<{ id: string; appointmentNumber: string; startsAt: Date }>;
  rescheduledFrom: { id: string; appointmentNumber: string; startsAt: Date } | null;
};

function toDetail(row: DetailRow) {
  const tz = row.bookedTimezoneName;
  const item = row.items[0];
  return {
    ...toSummary(row),
    customerNote: row.customerNote,
    internalNote: row.internalNote,
    reservedFrom: item
      ? toIsoWithOffset(new Date(item.startsAt.getTime() - item.bufferBeforeMin * MINUTE_MS), tz)
      : null,
    reservedTo: item
      ? toIsoWithOffset(new Date(item.endsAt.getTime() + item.bufferAfterMin * MINUTE_MS), tz)
      : null,
    durationMin: item?.durationMin ?? null,
    /** Price before discount, the discount, and (in the summary) the total. */
    subtotalMinor: row.subtotalMinor.toString(),
    discountMinor: row.discountMinor.toString(),
    /** The promotions as they were when applied — later edits do not reach these. */
    promotions: item ? snapshotPromotions(item.snapshot) : [],
    bufferBeforeMin: item?.bufferBeforeMin ?? 0,
    bufferAfterMin: item?.bufferAfterMin ?? 0,
    /** Booking-time copy of the service; renames and reprices do not reach it. */
    snapshot: item?.snapshot ?? null,
    confirmedAt: row.confirmedAt,
    checkedInAt: row.checkedInAt,
    completedAt: row.completedAt,
    noShowAt: row.noShowAt,
    cancellation: row.cancelledAt
      ? {
          cancelledAt: row.cancelledAt,
          reason: row.cancellationReason,
          byType: row.cancelledByType,
          byId: row.cancelledById,
        }
      : null,
    rescheduledFrom: row.rescheduledFrom
      ? {
          id: row.rescheduledFrom.id,
          appointmentNumber: row.rescheduledFrom.appointmentNumber,
          startsAt: toIsoWithOffset(row.rescheduledFrom.startsAt, tz),
        }
      : null,
    rescheduledTo: row.rescheduledTo[0]
      ? {
          id: row.rescheduledTo[0].id,
          appointmentNumber: row.rescheduledTo[0].appointmentNumber,
          startsAt: toIsoWithOffset(row.rescheduledTo[0].startsAt, tz),
        }
      : null,
    history: row.statusHistory.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actorType: h.actorType,
      actorLabel: h.actorLabel,
      reason: h.reason,
      changedAt: h.changedAt,
    })),
    version: row.version,
  };
}

/** The promotions recorded on an item at the time they were applied. */
function snapshotPromotions(snapshot: Prisma.JsonValue): unknown[] {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const promotions = (snapshot as Record<string, unknown>)['promotions'];
    if (Array.isArray(promotions)) return promotions;
  }
  return [];
}

function snapshotName(snapshot: Prisma.JsonValue): string | null {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const name = (snapshot as Record<string, unknown>)['serviceName'];
    return typeof name === 'string' ? name : null;
  }
  return null;
}

// ===========================================================================
// Series helpers
// ===========================================================================

const LIVE_STATUSES: AppointmentStatus[] = [
  'HOLD',
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
];

/**
 * ACTIVE while any occurrence is still live; CANCELLED when every one was
 * cancelled; ENDED otherwise (some happened, none are left to come).
 */
async function syncSeriesStatus(
  tx: TenantTx,
  companyId: string,
  seriesId: string,
  reason: string | null,
) {
  const [live, notCancelled] = await Promise.all([
    tx.appointment.count({ where: { companyId, seriesId, status: { in: LIVE_STATUSES } } }),
    tx.appointment.count({ where: { companyId, seriesId, status: { not: 'CANCELLED' } } }),
  ]);
  const status = live > 0 ? 'ACTIVE' : notCancelled > 0 ? 'ENDED' : 'CANCELLED';
  await tx.appointmentSeries.updateMany({
    where: { id: seriesId, companyId },
    data: {
      status,
      // Only a cancelled series has a cancellation; an ENDED one ran its course.
      ...(status === 'CANCELLED'
        ? { cancelledAt: new Date(), cancellationReason: reason?.slice(0, 512) ?? null }
        : {}),
    },
  });
}

type PlannedSeries = {
  booking: ResolvedBooking;
  plan: { skippedDates: string[] };
  checked: Array<{
    index: number;
    date: string;
    startsAt: Date;
    slot: AvailabilitySlotDto | null;
    reason: string | null;
    message: string | null;
  }>;
  employeeId: string | null;
  tz: string;
};

/** What a person needs to decide: each date, bookable or why not. */
function seriesPreview(planned: PlannedSeries) {
  const occurrences = planned.checked.map((c) => ({
    index: c.index,
    date: c.date,
    startsAt: toIsoWithOffset(c.startsAt, planned.tz),
    endsAt: c.slot ? c.slot.endAt : null,
    bookable: c.slot !== null,
    reason: c.reason,
    message: c.message,
  }));
  return {
    timezone: planned.tz,
    occurrences,
    /** Dates the rule names that do not exist, e.g. the 31st of a 30-day month. */
    skippedDates: planned.plan.skippedDates,
    bookableCount: occurrences.filter((o) => o.bookable).length,
    conflictCount: occurrences.filter((o) => !o.bookable).length,
    /** The one employee who can take every bookable date, if any. */
    employeeId: planned.employeeId,
  };
}

function toSeries(
  series: {
    id: string;
    frequency: string;
    interval: number;
    weekdays: number[];
    startsAt: Date;
    localStartTime: string;
    timezoneName: string;
    untilDate: Date | null;
    occurrenceCount: number | null;
    status: string;
    cancelledAt: Date | null;
    cancellationReason: string | null;
    employeeId: string | null;
    resourceId: string | null;
    createdAt: Date;
    branch: { id: string; name: string };
    customer: { id: string; firstName: string; lastName: string | null };
    service: { id: string; name: string };
  },
  occurrences: Array<ReturnType<typeof toSummary>>,
) {
  // A rescheduled occurrence keeps its seriesIndex: the cancelled original and
  // its replacement are one slot of the series, counted by the newest record.
  const slots = new Map<string, ReturnType<typeof toSummary>>();
  for (const o of occurrences) {
    const key = o.seriesIndex === null ? o.id : String(o.seriesIndex);
    const seen = slots.get(key);
    if (!seen || o.createdAt > seen.createdAt) slots.set(key, o);
  }
  const current = [...slots.values()];
  return {
    id: series.id,
    status: series.status,
    recurrence: {
      frequency: series.frequency,
      interval: series.interval,
      weekdays: series.weekdays,
      localStartTime: series.localStartTime,
      endDate: series.untilDate ? series.untilDate.toISOString().slice(0, 10) : null,
      count: series.occurrenceCount,
    },
    startsAt: toIsoWithOffset(series.startsAt, series.timezoneName),
    timezone: series.timezoneName,
    branch: series.branch,
    customer: {
      id: series.customer.id,
      name: [series.customer.firstName, series.customer.lastName].filter(Boolean).join(' '),
    },
    service: series.service,
    employeeId: series.employeeId,
    resourceId: series.resourceId,
    cancelledAt: series.cancelledAt,
    cancellationReason: series.cancellationReason,
    createdAt: series.createdAt,
    counts: {
      total: current.length,
      upcoming: current.filter((o) => LIVE_STATUSES.includes(o.status)).length,
      cancelled: current.filter((o) => o.status === 'CANCELLED').length,
    },
    occurrences,
  };
}

/**
 * Status changes the customer is told about. Starting, and marking a no-show,
 * are not: nobody needs a text saying their haircut has begun.
 */
const STATUS_EVENTS: Partial<Record<AppointmentStatus, NotificationEventType>> = {
  CONFIRMED: NOTIFICATION_EVENTS.APPOINTMENT_CONFIRMED,
  CANCELLED: NOTIFICATION_EVENTS.APPOINTMENT_CANCELLED,
  COMPLETED: NOTIFICATION_EVENTS.APPOINTMENT_COMPLETED,
};
