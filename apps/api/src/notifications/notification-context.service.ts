import { Injectable } from '@nestjs/common';
import { formatMoney } from '@undarga/shared';
import type { AppointmentStatus, Prisma } from '@prisma/client';
import type { TenantTx } from '../database/tenant-prisma.service';
import { NOTIFICATION_EVENTS, type NotificationEventType } from './notification-event.service';
import type { TemplateVariables } from './notification-templates';

export interface NotificationRecipient {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  /** No device registry exists yet, so push has nowhere to go. */
  readonly pushToken: string | null;
}

export interface NotificationContext {
  readonly recipient: NotificationRecipient;
  readonly variables: TemplateVariables;
  readonly appointmentId: string | null;
  /** For appointment events: the appointment's status NOW, not at emit time. */
  readonly appointmentStatus: AppointmentStatus | null;
}

/** Appointment events whose message only makes sense while the booking is live. */
const NEEDS_LIVE_APPOINTMENT = new Set<string>([
  NOTIFICATION_EVENTS.APPOINTMENT_REMINDER,
  NOTIFICATION_EVENTS.APPOINTMENT_CONFIRMED,
]);
const LIVE: AppointmentStatus[] = ['PENDING', 'CONFIRMED'];

/**
 * Turns an event's ids into who is being told and what the `{{variables}}`
 * say.
 *
 * ---------------------------------------------------------------------------
 * READ, NEVER DECIDE
 * ---------------------------------------------------------------------------
 *
 * Everything is re-read from the database inside the event's own company
 * transaction. The payload supplies ids only — names, times and recipients
 * come from the rows as they are now, and a customer id in a payload that no
 * longer belongs to this company resolves to nothing. No appointment rule is
 * re-implemented here: this reads what the appointment module wrote.
 *
 * Times are rendered in the BRANCH's timezone and the company's locale — the
 * customer is going to that building, so its wall clock is the one that
 * matters.
 */
@Injectable()
export class NotificationContextService {
  async resolve(
    tx: TenantTx,
    companyId: string,
    type: NotificationEventType,
    payload: Record<string, unknown>,
  ): Promise<NotificationContext | null> {
    const company = await tx.company.findFirst({
      where: { id: companyId },
      select: { displayName: true, settings: { select: { defaultLocale: true } } },
    });
    if (!company) return null;
    const locale = company.settings?.defaultLocale ?? 'en-US';
    const base: TemplateVariables = { companyName: company.displayName };

    switch (type) {
      case NOTIFICATION_EVENTS.APPOINTMENT_CREATED:
      case NOTIFICATION_EVENTS.APPOINTMENT_CONFIRMED:
      case NOTIFICATION_EVENTS.APPOINTMENT_RESCHEDULED:
      case NOTIFICATION_EVENTS.APPOINTMENT_CANCELLED:
      case NOTIFICATION_EVENTS.APPOINTMENT_REMINDER:
      case NOTIFICATION_EVENTS.APPOINTMENT_COMPLETED:
        return this.appointment(tx, companyId, type, id(payload.appointmentId), base, locale);

      case NOTIFICATION_EVENTS.GIFT_CARD_ISSUED:
      case NOTIFICATION_EVENTS.GIFT_CARD_ASSIGNED:
        return this.giftCard(tx, companyId, id(payload.giftCardId), base, locale);

      case NOTIFICATION_EVENTS.PAYMENT_COMPLETED:
        return this.payment(tx, companyId, payload, base, locale);
    }
  }

  private async appointment(
    tx: TenantTx,
    companyId: string,
    type: NotificationEventType,
    appointmentId: string | null,
    base: TemplateVariables,
    locale: string,
  ): Promise<NotificationContext | null> {
    if (!appointmentId) return null;
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, companyId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        customerId: true,
        branch: { select: { name: true, timezoneName: true } },
        items: {
          orderBy: { sequence: 'asc' },
          take: 1,
          select: {
            snapshot: true,
            service: { select: { name: true } },
            employee: { select: { displayName: true } },
          },
        },
      },
    });
    if (!appointment) return null;
    // A reminder for a booking cancelled in the meantime says nothing true.
    if (NEEDS_LIVE_APPOINTMENT.has(type) && !LIVE.includes(appointment.status)) return null;

    const recipient = await this.customer(tx, companyId, appointment.customerId);
    if (!recipient) return null;

    const item = appointment.items[0];
    const snapshot = asRecord(item?.snapshot);
    const timeZone = appointment.branch.timezoneName;

    return {
      recipient: recipient.contact,
      appointmentId: appointment.id,
      appointmentStatus: appointment.status,
      variables: {
        ...base,
        customerName: recipient.name,
        serviceName: str(snapshot.serviceName) ?? item?.service.name,
        employeeName: str(snapshot.employeeName) ?? item?.employee?.displayName,
        branchName: appointment.branch.name,
        appointmentDate: formatDate(appointment.startsAt, locale, timeZone),
        appointmentTime: formatTime(appointment.startsAt, locale, timeZone),
      },
    };
  }

  private async giftCard(
    tx: TenantTx,
    companyId: string,
    giftCardId: string | null,
    base: TemplateVariables,
    locale: string,
  ): Promise<NotificationContext | null> {
    if (!giftCardId) return null;
    const card = await tx.giftCard.findFirst({
      where: { id: giftCardId, companyId },
      select: {
        issuedToCustomerId: true,
        currentBalanceMinor: true,
        currencyCode: true,
        status: true,
      },
    });
    if (!card?.issuedToCustomerId || card.status === 'VOID') return null;

    const recipient = await this.customer(tx, companyId, card.issuedToCustomerId);
    if (!recipient) return null;

    return {
      recipient: recipient.contact,
      appointmentId: null,
      appointmentStatus: null,
      variables: {
        ...base,
        customerName: recipient.name,
        giftCardBalance: await this.money(
          tx,
          card.currentBalanceMinor.toString(),
          card.currencyCode,
          locale,
        ),
      },
    };
  }

  private async payment(
    tx: TenantTx,
    companyId: string,
    payload: Record<string, unknown>,
    base: TemplateVariables,
    locale: string,
  ): Promise<NotificationContext | null> {
    const customerId = id(payload.customerId);
    if (!customerId) return null;
    const recipient = await this.customer(tx, companyId, customerId);
    if (!recipient) return null;

    const amount = str(payload.amountMinor);
    const currency = str(payload.currencyCode);

    return {
      recipient: recipient.contact,
      appointmentId: id(payload.appointmentId),
      appointmentStatus: null,
      variables: {
        ...base,
        customerName: recipient.name,
        ...(amount && currency && /^\d+$/.test(amount)
          ? { paymentAmount: await this.money(tx, amount, currency, locale) }
          : {}),
      },
    };
  }

  private async customer(tx: TenantTx, companyId: string, customerId: string) {
    const customer = await tx.companyCustomer.findFirst({
      where: { id: customerId, companyId, deletedAt: null },
      select: { id: true, firstName: true, email: true, phone: true },
    });
    if (!customer) return null;
    return {
      name: customer.firstName,
      contact: {
        id: customer.id,
        email: customer.email?.trim() || null,
        phone: customer.phone?.trim() || null,
        pushToken: null,
      },
    };
  }

  private async money(tx: TenantTx, amountMinor: string, currencyCode: string, locale: string) {
    const currency = await tx.currency.findUnique({
      where: { code: currencyCode },
      select: { minorUnit: true, symbol: true },
    });
    return formatMoney(
      { amountMinor, currencyCode },
      { minorUnit: currency?.minorUnit ?? 2, symbol: currency?.symbol ?? undefined },
      locale,
    );
  }
}

function id(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asRecord(value: Prisma.JsonValue | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** `Tue, Oct 6, 2026` in the branch's own calendar. */
export function formatDate(instant: Date, locale: string, timeZone: string): string {
  return safeFormat(instant, locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** `10:00` or `4:00 PM`, per locale, on the branch's wall clock. */
export function formatTime(instant: Date, locale: string, timeZone: string): string {
  return safeFormat(instant, locale, { timeZone, hour: 'numeric', minute: '2-digit' });
}

function safeFormat(instant: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, options).format(instant);
  } catch {
    // An unknown locale or zone must not stop the message.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(instant);
  }
}
