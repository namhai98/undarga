import { Injectable } from '@nestjs/common';
import { formatMoney } from '@undarga/shared';
import type { AppointmentStatus, Prisma } from '@prisma/client';
import type { TenantTx } from '../database/tenant-prisma.service';
import { NOTIFICATION_EVENTS, type NotificationEventType } from './notification-event.service';
import type { TemplateVariables } from './notification-templates';

export interface NotificationRecipient {
  /** CUSTOMER: a company customer. COMPANY_USER: a company's owner (billing). */
  readonly type: 'CUSTOMER' | 'COMPANY_USER';
  /** The customer or company-user id; null only for the company contact fallback. */
  readonly id: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** No device registry exists yet, so push has nowhere to go. */
  readonly pushToken: string | null;
  /** The language to write in: the recipient's own, else the company default. */
  readonly locale: string;
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

interface CompanyBase {
  readonly variables: TemplateVariables;
  readonly locale: string;
  readonly timeZone: string;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

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
 * Times are rendered in the BRANCH's timezone (the customer is going to that
 * building) and billing dates in the company's default timezone. The language
 * is the recipient's own when they have one, else the company default.
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
      select: {
        displayName: true,
        defaultTimezoneName: true,
        contactEmail: true,
        contactPhone: true,
        settings: { select: { defaultLocale: true } },
      },
    });
    if (!company) return null;
    const base: CompanyBase = {
      variables: { companyName: company.displayName },
      locale: company.settings?.defaultLocale ?? 'en-US',
      timeZone: company.defaultTimezoneName,
      contactEmail: company.contactEmail?.trim() || null,
      contactPhone: company.contactPhone?.trim() || null,
    };

    switch (type) {
      case NOTIFICATION_EVENTS.APPOINTMENT_CREATED:
      case NOTIFICATION_EVENTS.APPOINTMENT_CONFIRMED:
      case NOTIFICATION_EVENTS.APPOINTMENT_RESCHEDULED:
      case NOTIFICATION_EVENTS.APPOINTMENT_CANCELLED:
      case NOTIFICATION_EVENTS.APPOINTMENT_REMINDER:
      case NOTIFICATION_EVENTS.APPOINTMENT_COMPLETED:
        return this.appointment(tx, companyId, type, id(payload.appointmentId), base);

      case NOTIFICATION_EVENTS.GIFT_CARD_ISSUED:
      case NOTIFICATION_EVENTS.GIFT_CARD_ASSIGNED:
        return this.giftCard(tx, companyId, id(payload.giftCardId), base);

      case NOTIFICATION_EVENTS.PAYMENT_COMPLETED:
        return this.payment(tx, companyId, payload, base, 'paid');

      case NOTIFICATION_EVENTS.PAYMENT_FAILED:
        return this.payment(tx, companyId, payload, base, 'declined or cancelled');

      case NOTIFICATION_EVENTS.SUBSCRIPTION_INVOICE_ISSUED:
      case NOTIFICATION_EVENTS.SUBSCRIPTION_PAYMENT_FAILED:
        return this.invoice(tx, companyId, payload, base);
    }
  }

  private async appointment(
    tx: TenantTx,
    companyId: string,
    type: NotificationEventType,
    appointmentId: string | null,
    base: CompanyBase,
  ): Promise<NotificationContext | null> {
    if (!appointmentId) return null;
    const appointment = await this.appointmentRow(tx, companyId, appointmentId);
    if (!appointment) return null;
    // A reminder for a booking cancelled in the meantime says nothing true.
    if (NEEDS_LIVE_APPOINTMENT.has(type) && !LIVE.includes(appointment.status)) return null;

    const recipient = await this.customer(tx, companyId, appointment.customerId, base.locale);
    if (!recipient) return null;

    return {
      recipient: recipient.contact,
      appointmentId: appointment.id,
      appointmentStatus: appointment.status,
      variables: {
        ...base.variables,
        customerName: recipient.name,
        ...appointmentVariables(appointment, recipient.contact.locale),
      },
    };
  }

  private async giftCard(
    tx: TenantTx,
    companyId: string,
    giftCardId: string | null,
    base: CompanyBase,
  ): Promise<NotificationContext | null> {
    if (!giftCardId) return null;
    const card = await tx.giftCard.findFirst({
      where: { id: giftCardId, companyId },
      select: {
        issuedToCustomerId: true,
        currentBalanceMinor: true,
        currencyCode: true,
        status: true,
        codeLast4: true,
        expiresAt: true,
      },
    });
    if (!card?.issuedToCustomerId || card.status === 'VOID') return null;

    const recipient = await this.customer(tx, companyId, card.issuedToCustomerId, base.locale);
    if (!recipient) return null;
    const locale = recipient.contact.locale;

    return {
      recipient: recipient.contact,
      appointmentId: null,
      appointmentStatus: null,
      variables: {
        ...base.variables,
        customerName: recipient.name,
        giftCardBalance: await this.money(
          tx,
          card.currentBalanceMinor.toString(),
          card.currencyCode,
          locale,
        ),
        // The last four only: the full code is bearer value and stays off the wire.
        giftCardLast4: card.codeLast4,
        ...(card.expiresAt
          ? { giftCardExpiry: `until ${formatDate(card.expiresAt, locale, base.timeZone)}` }
          : {}),
      },
    };
  }

  private async payment(
    tx: TenantTx,
    companyId: string,
    payload: Record<string, unknown>,
    base: CompanyBase,
    paymentStatus: string,
  ): Promise<NotificationContext | null> {
    const customerId = id(payload.customerId);
    if (!customerId) return null;
    const recipient = await this.customer(tx, companyId, customerId, base.locale);
    if (!recipient) return null;
    const locale = recipient.contact.locale;

    const amount = str(payload.amountMinor);
    const currency = str(payload.currencyCode);
    const appointmentId = id(payload.appointmentId);
    const appointment = appointmentId
      ? await this.appointmentRow(tx, companyId, appointmentId)
      : null;

    return {
      recipient: recipient.contact,
      appointmentId: appointment?.id ?? null,
      appointmentStatus: null,
      variables: {
        ...base.variables,
        customerName: recipient.name,
        paymentStatus,
        ...(appointment ? appointmentVariables(appointment, locale) : {}),
        ...(amount && currency && /^\d+$/.test(amount)
          ? { paymentAmount: await this.money(tx, amount, currency, locale) }
          : {}),
      },
    };
  }

  /** Subscription billing, addressed to the company's owner. */
  private async invoice(
    tx: TenantTx,
    companyId: string,
    payload: Record<string, unknown>,
    base: CompanyBase,
  ): Promise<NotificationContext | null> {
    const invoiceId = id(payload.invoiceId);
    if (!invoiceId) return null;
    const invoice = await tx.subscriptionInvoice.findFirst({
      where: { id: invoiceId, companyId },
      select: {
        number: true,
        totalMinor: true,
        currencyCode: true,
        dueAt: true,
        planName: true,
        status: true,
      },
    });
    if (!invoice || invoice.status === 'VOID') return null;

    const owner = await this.owner(tx, companyId, base);
    if (!owner) return null;
    const locale = owner.contact.locale;

    return {
      recipient: owner.contact,
      appointmentId: null,
      appointmentStatus: null,
      variables: {
        ...base.variables,
        customerName: owner.name,
        planName: invoice.planName ?? undefined,
        invoiceNumber: invoice.number,
        invoiceAmount: await this.money(
          tx,
          invoice.totalMinor.toString(),
          invoice.currencyCode,
          locale,
        ),
        ...(invoice.dueAt
          ? { invoiceDueDate: formatDate(invoice.dueAt, locale, base.timeZone) }
          : {}),
        ...(str(payload.paymentStatus) ? { paymentStatus: str(payload.paymentStatus) } : {}),
      },
    };
  }

  private appointmentRow(tx: TenantTx, companyId: string, appointmentId: string) {
    return tx.appointment.findFirst({
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
  }

  private async customer(
    tx: TenantTx,
    companyId: string,
    customerId: string,
    companyLocale: string,
  ) {
    const customer = await tx.companyCustomer.findFirst({
      where: { id: customerId, companyId, deletedAt: null },
      select: { id: true, firstName: true, email: true, phone: true, locale: true },
    });
    if (!customer) return null;
    return {
      name: customer.firstName,
      contact: {
        type: 'CUSTOMER' as const,
        id: customer.id,
        email: customer.email?.trim() || null,
        phone: customer.phone?.trim() || null,
        pushToken: null,
        locale: customer.locale?.trim() || companyLocale,
      },
    };
  }

  /**
   * The company's owner: the earliest active owner membership. Falls back to the
   * company's contact details when no owner has joined yet, so a billing notice
   * still has somewhere to go.
   */
  private async owner(tx: TenantTx, companyId: string, base: CompanyBase) {
    const membership = await tx.companyUser.findFirst({
      where: { companyId, isOwner: true, status: 'ACTIVE', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        displayName: true,
        userAccount: {
          select: { email: true, phone: true, fullName: true, locale: true, deletedAt: true },
        },
      },
    });
    const account = membership?.userAccount;
    if (membership && account && !account.deletedAt) {
      return {
        name: membership.displayName ?? account.fullName,
        contact: {
          type: 'COMPANY_USER' as const,
          id: membership.id,
          email: account.email,
          phone: account.phone?.trim() || null,
          pushToken: null,
          locale: account.locale || base.locale,
        },
      };
    }
    if (!base.contactEmail && !base.contactPhone) return null;
    return {
      name: base.variables.companyName ?? '',
      contact: {
        type: 'COMPANY_USER' as const,
        id: null,
        email: base.contactEmail,
        phone: base.contactPhone,
        pushToken: null,
        locale: base.locale,
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

type AppointmentRow = NonNullable<
  Awaited<ReturnType<NotificationContextService['appointmentRow']>>
>;

function appointmentVariables(appointment: AppointmentRow, locale: string): TemplateVariables {
  const item = appointment.items[0];
  const snapshot = asRecord(item?.snapshot);
  const timeZone = appointment.branch.timezoneName;
  return {
    serviceName: str(snapshot.serviceName) ?? item?.service.name,
    employeeName: str(snapshot.employeeName) ?? item?.employee?.displayName,
    branchName: appointment.branch.name,
    appointmentDate: formatDate(appointment.startsAt, locale, timeZone),
    appointmentTime: formatTime(appointment.startsAt, locale, timeZone),
  };
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

/** `Tue, Oct 6, 2026` in the given calendar. */
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
