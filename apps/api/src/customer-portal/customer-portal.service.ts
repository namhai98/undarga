import { Injectable } from '@nestjs/common';
import { Prisma, type AppointmentStatus } from '@prisma/client';
import { AppointmentsService } from '../appointments/appointments.service';
import { AvailabilityService } from '../availability/availability.service';
import {
  ConflictError,
  CustomerActionNotAllowedError,
  ResourceNotFoundError,
  UnauthenticatedError,
  type CustomerActionRefusal,
} from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { isCustomerActor, type CustomerActor } from '../tenancy/context/context.types';
import type {
  AppointmentListDto,
  CustomerCancelDto,
  CustomerRescheduleDto,
  PageDto,
  UpdateProfileDto,
} from './dto/customer-portal.dto';

/** What a customer may change themselves, from where. Mirrors the engine. */
const CUSTOMER_MUTABLE: readonly AppointmentStatus[] = ['PENDING', 'CONFIRMED'];
const ACTIVE: AppointmentStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'];

export interface ActionVerdict {
  allowed: boolean;
  reason: CustomerActionRefusal | null;
  message: string | null;
  /** The last moment the action is possible, when a deadline applies. */
  deadline: string | null;
}

/**
 * ===========================================================================
 * THE CUSTOMER PORTAL: ONE CUSTOMER'S VIEW OF ONE COMPANY
 * ===========================================================================
 *
 * Every read is keyed on the customer id from the SIGNED token, inside the
 * token's company (RLS), and re-checks that the customer record is still
 * active and still this person's — so a business blocking or deleting a
 * customer ends their portal access at once, not at token expiry.
 *
 * What is returned is a projection written for the customer. Internal notes,
 * tags, loyalty figures, who on staff took a payment, provider ids and fees,
 * employee ids and private profile fields never leave this file. Employees
 * appear by the display name public booking already shows.
 *
 * The rules for cancelling and rescheduling are evaluated HERE, once
 * (`customerActions`), shown to the UI as `actions`, and enforced again under
 * the appointment row lock by the existing Appointment Engine — whose cancel
 * and reschedule this service calls rather than re-implementing.
 */
@Injectable()
export class CustomerPortalService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
  ) {}

  // ===========================================================================
  // Profile
  // ===========================================================================

  async profile() {
    return this.inCompany(async (tx, actor) => {
      const customer = await this.me(tx, actor);
      const company = await tx.company.findFirstOrThrow({
        where: { id: actor.companyId },
        select: { slug: true, displayName: true, defaultTimezoneName: true, currencyCode: true },
      });
      return {
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        locale: customer.locale,
        memberSince: customer.createdAt,
        company: {
          slug: company.slug,
          name: company.displayName,
          timezone: company.defaultTimezoneName,
          currencyCode: company.currencyCode,
        },
      };
    });
  }

  async updateProfile(input: UpdateProfileDto) {
    try {
      await this.inCompany(async (tx, actor) => {
        await this.me(tx, actor);
        await tx.companyCustomer.updateMany({
          where: { id: actor.companyCustomerId, companyId: actor.companyId },
          data: {
            ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.locale !== undefined ? { locale: input.locale } : {}),
          },
        });
      });
    } catch (error) {
      // The business already has another customer with that number.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('That phone number is already in use here. Contact the business.', {
          field: 'phone',
        });
      }
      throw error;
    }
    return this.profile();
  }

  // ===========================================================================
  // Appointments
  // ===========================================================================

  async listAppointments(query: AppointmentListDto) {
    return this.inCompany(async (tx, actor) => {
      await this.me(tx, actor);
      const now = new Date();
      const scope: Prisma.AppointmentWhereInput =
        query.scope === 'upcoming'
          ? { status: { in: ACTIVE }, endsAt: { gte: now } }
          : query.scope === 'past'
            ? {
                OR: [
                  { status: { in: ['COMPLETED', 'NO_SHOW'] } },
                  { status: { in: ACTIVE }, endsAt: { lt: now } },
                ],
              }
            : // A reschedule cancels the old booking as a mechanism; the
              // customer sees the moved booking, not a "cancellation".
              { status: 'CANCELLED', rescheduledTo: { none: {} } };

      const where: Prisma.AppointmentWhereInput = {
        companyId: actor.companyId,
        customerId: actor.companyCustomerId,
        ...scope,
      };
      const [rows, total] = await Promise.all([
        tx.appointment.findMany({
          where,
          orderBy: { startsAt: query.scope === 'upcoming' ? 'asc' : 'desc' },
          skip: query.offset,
          take: query.limit,
          select: appointmentSelect(actor.companyId),
        }),
        tx.appointment.count({ where }),
      ]);
      return {
        items: rows.map(toAppointmentSummary),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async appointment(appointmentId: string) {
    return this.inCompany(async (tx, actor) => {
      await this.me(tx, actor);
      const row = await this.ownAppointment(tx, actor, appointmentId);

      const [payments, redemptions, rules, openOnline] = await Promise.all([
        tx.payment.findMany({
          where: { companyId: actor.companyId, appointmentId },
          orderBy: { createdAt: 'asc' },
          select: paymentSelect,
        }),
        tx.promotionRedemption.findMany({
          where: { companyId: actor.companyId, appointmentId },
          select: {
            discountMinor: true,
            promotion: { select: { name: true } },
            coupon: { select: { code: true } },
          },
        }),
        this.rules(tx, actor.companyId, row.branchId),
        this.hasOpenOnlinePayment(tx, actor.companyId, appointmentId),
      ]);

      const actions = customerActions(row, rules, {
        paidMinor: row.paidMinor - row.refundedMinor,
        openOnline,
      });

      return {
        ...toAppointmentSummary(row),
        branch: {
          name: row.branch.name,
          address:
            [row.branch.addressLine1, row.branch.addressLine2, row.branch.city]
              .filter(Boolean)
              .join(', ') || null,
          phone: row.branch.phone,
        },
        durationMin: row.items[0]?.durationMin ?? null,
        customerNote: row.customerNote,
        cancelledAt: row.cancelledAt,
        rescheduledFrom: row.rescheduledFrom?.appointmentNumber ?? null,
        price: {
          subtotalMinor: row.subtotalMinor.toString(),
          discountMinor: row.discountMinor.toString(),
          totalMinor: row.totalMinor.toString(),
          currencyCode: row.currencyCode,
        },
        promotions: redemptions.map((r) => ({
          name: r.promotion.name,
          code: r.coupon?.code ?? null,
          discountMinor: r.discountMinor.toString(),
        })),
        payment: {
          status: row.paymentStatus,
          paidMinor: row.paidMinor.toString(),
          refundedMinor: row.refundedMinor.toString(),
          outstandingMinor: maxZero(
            row.totalMinor - (row.paidMinor - row.refundedMinor),
          ).toString(),
          inProgress: openOnline,
          payments: payments.map(toPaymentSummary),
        },
        actions,
      };
    });
  }

  async cancel(appointmentId: string, input: CustomerCancelDto) {
    const { actor, rules } = await this.verdictFor(appointmentId, 'cancel');
    await this.appointments.cancelByCustomer(
      appointmentId,
      actor.companyCustomerId,
      { reason: input.reason ? `Customer: ${input.reason}` : 'Cancelled by the customer' },
      // Re-checked under the row lock: the deadline is a moment in time.
      (startsAt) => assertBeforeDeadline('cancel', startsAt, rules.cancellationWindowHours),
    );
    return this.appointment(appointmentId);
  }

  async reschedule(appointmentId: string, input: CustomerRescheduleDto) {
    const { actor, rules } = await this.verdictFor(appointmentId, 'reschedule');
    const moved = await this.appointments.reschedule(
      appointmentId,
      { startsAt: input.startsAt, reason: 'By the customer' },
      {
        customer: {
          customerId: actor.companyCustomerId,
          guard: (startsAt) =>
            assertBeforeDeadline('reschedule', startsAt, rules.cancellationWindowHours),
        },
      },
    );
    const id = moved && 'id' in moved ? moved.id : appointmentId;
    return this.appointment(id);
  }

  /** Times this appointment could move to, on one day, as public booking offers them. */
  async rescheduleOptions(appointmentId: string, date: string) {
    const { row } = await this.verdictFor(appointmentId, 'reschedule');
    const item = row.items[0];
    if (!item) throw new ResourceNotFoundError('Appointment', appointmentId);

    const day = await this.availability.getDay(
      {
        branchId: row.branchId,
        serviceId: item.serviceId,
        date,
        ...(item.employeeId ? { employeeId: item.employeeId } : {}),
      },
      { publicOnly: true, excludeAppointmentId: appointmentId },
    );
    // Times only — never the employee or resource ids the engine works with.
    return {
      date: day.date,
      timezone: day.timezone,
      unavailableReason: day.unavailableReason,
      slots: day.slots.map((slot) => ({ startAt: slot.startAt, endAt: slot.endAt })),
    };
  }

  // ===========================================================================
  // Payments and gift cards
  // ===========================================================================

  /**
   * The customer's payments: amount, method, status, refunds, which booking.
   * Not provider references, fees, ledger ids or who took the money.
   */
  async payments(query: PageDto) {
    return this.inCompany(async (tx, actor) => {
      await this.me(tx, actor);
      const where: Prisma.PaymentWhereInput = {
        companyId: actor.companyId,
        OR: [
          { customerId: actor.companyCustomerId },
          { appointment: { companyId: actor.companyId, customerId: actor.companyCustomerId } },
        ],
      };
      const [rows, total, totals] = await Promise.all([
        tx.payment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.offset,
          take: query.limit,
          select: paymentSelect,
        }),
        tx.payment.count({ where }),
        tx.payment.aggregate({
          where: { ...where, status: 'SUCCEEDED' },
          _sum: { amountMinor: true, refundedMinor: true },
        }),
      ]);
      return {
        items: rows.map(toPaymentSummary),
        total,
        limit: query.limit,
        offset: query.offset,
        summary: {
          paidMinor: (totals._sum.amountMinor ?? 0n).toString(),
          refundedMinor: (totals._sum.refundedMinor ?? 0n).toString(),
        },
      };
    });
  }

  /**
   * Gift cards the customer holds, and ones they bought for someone else.
   *
   * The HOLDER sees the balance and history. A card bought for someone else
   * shows that it was bought and for whom — not what the recipient has spent.
   */
  async giftCards() {
    return this.inCompany(async (tx, actor) => {
      await this.me(tx, actor);
      const cards = await tx.giftCard.findMany({
        where: {
          companyId: actor.companyId,
          OR: [
            { issuedToCustomerId: actor.companyCustomerId },
            { purchasedByCustomerId: actor.companyCustomerId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: giftCardSelect,
      });
      return {
        items: cards.map((card) => {
          const holder = isHolder(card, actor.companyCustomerId);
          return {
            id: card.id,
            codeLast4: card.codeLast4,
            status: card.status,
            relation: holder ? ('HOLDER' as const) : ('PURCHASER' as const),
            currencyCode: card.currencyCode,
            initialBalanceMinor: card.initialBalanceMinor.toString(),
            balanceMinor: holder ? card.currentBalanceMinor.toString() : null,
            recipientName: holder ? null : card.recipientName,
            issuedAt: card.issuedAt,
            expiresAt: card.expiresAt,
          };
        }),
      };
    });
  }

  async giftCardTransactions(giftCardId: string, query: PageDto) {
    return this.inCompany(async (tx, actor) => {
      await this.me(tx, actor);
      const card = await tx.giftCard.findFirst({
        where: { id: giftCardId, companyId: actor.companyId },
        select: giftCardSelect,
      });
      // Not theirs, or theirs only as the buyer: the history is the holder's.
      if (!card || !isHolder(card, actor.companyCustomerId)) {
        throw new ResourceNotFoundError('GiftCard', giftCardId);
      }
      const where = { companyId: actor.companyId, giftCardId };
      const [rows, total] = await Promise.all([
        tx.giftCardTransaction.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip: query.offset,
          take: query.limit,
          select: {
            id: true,
            type: true,
            amountMinor: true,
            balanceAfterMinor: true,
            currencyCode: true,
            occurredAt: true,
            appointment: { select: { appointmentNumber: true } },
          },
        }),
        tx.giftCardTransaction.count({ where }),
      ]);
      return {
        giftCard: {
          id: card.id,
          codeLast4: card.codeLast4,
          status: card.status,
          currencyCode: card.currencyCode,
          balanceMinor: card.currentBalanceMinor.toString(),
          expiresAt: card.expiresAt,
        },
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          amountMinor: row.amountMinor.toString(),
          balanceAfterMinor: row.balanceAfterMinor.toString(),
          currencyCode: row.currencyCode,
          occurredAt: row.occurredAt,
          appointmentNumber: row.appointment?.appointmentNumber ?? null,
        })),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  // ===========================================================================

  private async verdictFor(appointmentId: string, action: 'cancel' | 'reschedule') {
    return this.inCompany(async (tx, actor) => {
      await this.me(tx, actor);
      const row = await this.ownAppointment(tx, actor, appointmentId);
      const [rules, openOnline] = await Promise.all([
        this.rules(tx, actor.companyId, row.branchId),
        this.hasOpenOnlinePayment(tx, actor.companyId, appointmentId),
      ]);
      const verdict = customerActions(row, rules, {
        paidMinor: row.paidMinor - row.refundedMinor,
        openOnline,
      })[action];
      if (!verdict.allowed) {
        throw new CustomerActionNotAllowedError(
          action,
          verdict.reason!,
          verdict.message!,
          verdict.deadline ? new Date(verdict.deadline) : null,
        );
      }
      return { actor, row, rules };
    });
  }

  private async inCompany<T>(fn: (tx: TenantTx, actor: CustomerActor) => Promise<T>): Promise<T> {
    const actor = this.context.requireActor();
    if (!isCustomerActor(actor)) throw new UnauthenticatedError();
    return this.db.runInCompany(actor.companyId, (tx) => fn(tx, actor));
  }

  /**
   * The customer record behind the token, still active and still this
   * person's. Anything else ends the session: a 401 the portal answers by
   * asking them to sign in again.
   */
  private async me(tx: TenantTx, actor: CustomerActor) {
    const customer = await tx.companyCustomer.findFirst({
      where: {
        id: actor.companyCustomerId,
        companyId: actor.companyId,
        customerIdentityId: actor.customerIdentityId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        locale: true,
        createdAt: true,
      },
    });
    if (!customer) throw new UnauthenticatedError('Your session has ended. Sign in again.');
    return customer;
  }

  private async ownAppointment(tx: TenantTx, actor: CustomerActor, appointmentId: string) {
    const row = await tx.appointment.findFirst({
      where: {
        id: appointmentId,
        companyId: actor.companyId,
        customerId: actor.companyCustomerId,
        status: { notIn: ['HOLD', 'EXPIRED'] },
      },
      select: appointmentSelect(actor.companyId),
    });
    if (!row) throw new ResourceNotFoundError('Appointment', appointmentId);
    return row;
  }

  /** The business's rules, branch overrides first — as the engine reads them. */
  private async rules(tx: TenantTx, companyId: string, branchId: string): Promise<Rules> {
    const [company, branch] = await Promise.all([
      tx.companySettings.findFirst({
        where: { companyId },
        select: {
          allowCustomerCancel: true,
          allowCustomerReschedule: true,
          cancellationWindowHours: true,
        },
      }),
      tx.branchSettings.findFirst({
        where: { companyId, branchId },
        select: { cancellationWindowHours: true },
      }),
    ]);
    return {
      allowCancel: company?.allowCustomerCancel ?? true,
      allowReschedule: company?.allowCustomerReschedule ?? true,
      cancellationWindowHours:
        branch?.cancellationWindowHours ?? company?.cancellationWindowHours ?? 24,
    };
  }

  private async hasOpenOnlinePayment(tx: TenantTx, companyId: string, appointmentId: string) {
    const open = await tx.paymentTransaction.count({
      where: { companyId, appointmentId, status: { in: ['PENDING', 'PROCESSING'] } },
    });
    return open > 0;
  }
}

// =============================================================================
// Rules
// =============================================================================

interface Rules {
  allowCancel: boolean;
  allowReschedule: boolean;
  cancellationWindowHours: number;
}

/**
 * What the customer may do with one appointment, and why not.
 *
 *   status        only a PENDING or CONFIRMED booking that has not started
 *   business      company_settings.allow_customer_cancel / _reschedule
 *   payment       never while an online payment is in flight; a paid booking
 *                 is not rescheduled online (its payment stays with the
 *                 original booking — the business moves it)
 *   deadline      cancellation_window_hours before the start (branch override
 *                 first), for both cancelling and rescheduling
 */
export function customerActions(
  row: { status: AppointmentStatus; startsAt: Date },
  rules: Rules,
  money: { paidMinor: bigint; openOnline: boolean },
  now = new Date(),
): { cancel: ActionVerdict; reschedule: ActionVerdict } {
  const deadline = new Date(row.startsAt.getTime() - rules.cancellationWindowHours * 3_600_000);
  const verdict = (action: 'cancel' | 'reschedule'): ActionVerdict => {
    const no = (
      reason: CustomerActionRefusal,
      message: string,
      withDeadline = false,
    ): ActionVerdict => ({
      allowed: false,
      reason,
      message,
      deadline: withDeadline ? deadline.toISOString() : null,
    });
    const verb = action === 'cancel' ? 'cancelled' : 'rescheduled';

    if (!CUSTOMER_MUTABLE.includes(row.status) || row.startsAt <= now) {
      return no('STATUS', `This appointment can no longer be ${verb} online.`);
    }
    if (action === 'cancel' ? !rules.allowCancel : !rules.allowReschedule) {
      return no(
        'NOT_ALLOWED_BY_BUSINESS',
        `This business does not allow appointments to be ${verb} online. Please contact them.`,
      );
    }
    if (money.openOnline) {
      return no(
        'PAYMENT_IN_PROGRESS',
        'A payment for this appointment is in progress. Try again once it has finished.',
      );
    }
    if (action === 'reschedule' && money.paidMinor > 0n) {
      return no(
        'ALREADY_PAID',
        'This appointment has been paid for. Please contact the business to move it.',
      );
    }
    if (now > deadline) {
      return no(
        'PAST_DEADLINE',
        `Appointments can be ${verb} online until ${rules.cancellationWindowHours} hours before they start. Please contact the business.`,
        true,
      );
    }
    return { allowed: true, reason: null, message: null, deadline: deadline.toISOString() };
  };
  return { cancel: verdict('cancel'), reschedule: verdict('reschedule') };
}

function assertBeforeDeadline(
  action: 'cancel' | 'reschedule',
  startsAt: Date,
  windowHours: number,
) {
  const deadline = new Date(startsAt.getTime() - windowHours * 3_600_000);
  if (Date.now() > deadline.getTime()) {
    throw new CustomerActionNotAllowedError(
      action,
      'PAST_DEADLINE',
      `The deadline to ${action} this appointment online has passed. Please contact the business.`,
      deadline,
    );
  }
}

// =============================================================================
// Projections
// =============================================================================

function appointmentSelect(companyId: string) {
  return {
    id: true,
    appointmentNumber: true,
    status: true,
    startsAt: true,
    endsAt: true,
    bookedTimezoneName: true,
    branchId: true,
    subtotalMinor: true,
    discountMinor: true,
    totalMinor: true,
    paidMinor: true,
    refundedMinor: true,
    currencyCode: true,
    paymentStatus: true,
    customerNote: true,
    cancelledAt: true,
    branch: {
      select: { name: true, addressLine1: true, addressLine2: true, city: true, phone: true },
    },
    items: {
      where: { companyId },
      orderBy: { sequence: 'asc' as const },
      select: {
        serviceId: true,
        employeeId: true,
        durationMin: true,
        service: { select: { name: true } },
        employee: { select: { displayName: true } },
      },
    },
    rescheduledFrom: { select: { appointmentNumber: true } },
  } satisfies Prisma.AppointmentSelect;
}

type AppointmentRow = Prisma.AppointmentGetPayload<{
  select: ReturnType<typeof appointmentSelect>;
}>;

function toAppointmentSummary(row: AppointmentRow) {
  const item = row.items[0];
  return {
    id: row.id,
    appointmentNumber: row.appointmentNumber,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.bookedTimezoneName,
    service: item?.service?.name ?? null,
    employee: item?.employee?.displayName ?? null,
    branch: row.branch.name,
    totalMinor: row.totalMinor.toString(),
    currencyCode: row.currencyCode,
    paymentStatus: row.paymentStatus,
  };
}

const paymentSelect = {
  id: true,
  paymentNumber: true,
  method: true,
  purpose: true,
  status: true,
  amountMinor: true,
  refundedMinor: true,
  currencyCode: true,
  createdAt: true,
  capturedAt: true,
  appointment: { select: { id: true, appointmentNumber: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

function toPaymentSummary(row: PaymentRow) {
  return {
    id: row.id,
    reference: row.paymentNumber,
    method: row.method,
    purpose: row.purpose,
    status: row.status,
    amountMinor: row.amountMinor.toString(),
    refundedMinor: row.refundedMinor.toString(),
    currencyCode: row.currencyCode,
    paidAt: row.capturedAt ?? row.createdAt,
    appointmentId: row.appointment?.id ?? null,
    appointmentNumber: row.appointment?.appointmentNumber ?? null,
  };
}

const giftCardSelect = {
  id: true,
  codeLast4: true,
  status: true,
  initialBalanceMinor: true,
  currentBalanceMinor: true,
  currencyCode: true,
  issuedToCustomerId: true,
  purchasedByCustomerId: true,
  recipientName: true,
  issuedAt: true,
  expiresAt: true,
} satisfies Prisma.GiftCardSelect;

/** The holder is the recipient, or the buyer of a card issued to nobody else. */
function isHolder(
  card: { issuedToCustomerId: string | null; purchasedByCustomerId: string | null },
  customerId: string,
): boolean {
  return (
    card.issuedToCustomerId === customerId ||
    (card.issuedToCustomerId === null && card.purchasedByCustomerId === customerId)
  );
}

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}
