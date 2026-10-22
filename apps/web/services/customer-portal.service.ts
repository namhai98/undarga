import { customerApiClient } from './customer-api-client';

/**
 * The customer portal API (docs/CUSTOMER-PORTAL.md). Every call is the signed-
 * in customer's own: nothing here sends a customer or company id.
 */

export type PortalAppointmentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export type PortalAppointmentScope = 'upcoming' | 'past' | 'cancelled';

export interface PortalPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PortalProfile {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  locale: string | null;
  memberSince: string;
  company: { slug: string; name: string; timezone: string; currencyCode: string };
}

export interface PortalAppointment {
  id: string;
  appointmentNumber: string;
  status: PortalAppointmentStatus;
  startsAt: string;
  endsAt: string;
  timezone: string;
  service: string | null;
  employee: string | null;
  branch: string;
  totalMinor: string;
  currencyCode: string;
  paymentStatus: string;
}

export type PortalActionRefusal =
  | 'NOT_ALLOWED_BY_BUSINESS'
  | 'PAST_DEADLINE'
  | 'STATUS'
  | 'PAYMENT_IN_PROGRESS'
  | 'ALREADY_PAID';

export interface PortalActionVerdict {
  allowed: boolean;
  reason: PortalActionRefusal | null;
  message: string | null;
  deadline: string | null;
}

export interface PortalPayment {
  id: string;
  reference: string;
  method: string;
  purpose: string;
  status: string;
  amountMinor: string;
  refundedMinor: string;
  currencyCode: string;
  paidAt: string;
  appointmentId: string | null;
  appointmentNumber: string | null;
}

export interface PortalAppointmentDetail extends Omit<PortalAppointment, 'branch'> {
  branch: { name: string; address: string | null; phone: string | null };
  durationMin: number | null;
  customerNote: string | null;
  cancelledAt: string | null;
  rescheduledFrom: string | null;
  price: { subtotalMinor: string; discountMinor: string; totalMinor: string; currencyCode: string };
  promotions: Array<{ name: string; code: string | null; discountMinor: string }>;
  payment: {
    status: string;
    paidMinor: string;
    refundedMinor: string;
    outstandingMinor: string;
    inProgress: boolean;
    payments: PortalPayment[];
  };
  actions: { cancel: PortalActionVerdict; reschedule: PortalActionVerdict };
}

export interface RescheduleOptions {
  date: string;
  timezone: string;
  unavailableReason: string | null;
  slots: Array<{ startAt: string; endAt: string }>;
}

export interface PortalGiftCard {
  id: string;
  codeLast4: string;
  status: string;
  relation: 'HOLDER' | 'PURCHASER';
  currencyCode: string;
  initialBalanceMinor: string;
  /** null for a card bought for someone else: their balance is theirs. */
  balanceMinor: string | null;
  recipientName: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
}

export interface GiftCardHistory extends PortalPage<{
  id: string;
  type: string;
  amountMinor: string;
  balanceAfterMinor: string;
  currencyCode: string;
  occurredAt: string;
  appointmentNumber: string | null;
}> {
  giftCard: {
    id: string;
    codeLast4: string;
    status: string;
    currencyCode: string;
    balanceMinor: string;
    expiresAt: string | null;
  };
}

export interface PortalProfileInput {
  firstName?: string;
  lastName?: string | null;
  phone?: string | null;
}

export const customerPortalService = {
  me: (signal?: AbortSignal) => customerApiClient.get<PortalProfile>('/customer/me', { signal }),
  updateMe: (input: PortalProfileInput) => customerApiClient.patch<PortalProfile>('/customer/me', input),

  appointments: (scope: PortalAppointmentScope, page: { limit: number; offset: number }, signal?: AbortSignal) =>
    customerApiClient.get<PortalPage<PortalAppointment>>('/customer/appointments', {
      query: { scope, ...page },
      signal,
    }),
  appointment: (id: string, signal?: AbortSignal) =>
    customerApiClient.get<PortalAppointmentDetail>(`/customer/appointments/${id}`, { signal }),
  cancel: (id: string, reason?: string) =>
    customerApiClient.post<PortalAppointmentDetail>(`/customer/appointments/${id}/cancel`, reason ? { reason } : {}),
  rescheduleOptions: (id: string, date: string, signal?: AbortSignal) =>
    customerApiClient.get<RescheduleOptions>(`/customer/appointments/${id}/reschedule-options`, {
      query: { date },
      signal,
    }),
  reschedule: (id: string, startsAt: string) =>
    customerApiClient.post<PortalAppointmentDetail>(`/customer/appointments/${id}/reschedule`, { startsAt }),

  payments: (page: { limit: number; offset: number }, signal?: AbortSignal) =>
    customerApiClient.get<PortalPage<PortalPayment> & { summary: { paidMinor: string; refundedMinor: string } }>(
      '/customer/payments',
      { query: page, signal },
    ),

  giftCards: (signal?: AbortSignal) =>
    customerApiClient.get<{ items: PortalGiftCard[] }>('/customer/gift-cards', { signal }),
  giftCardHistory: (id: string, page: { limit: number; offset: number }, signal?: AbortSignal) =>
    customerApiClient.get<GiftCardHistory>(`/customer/gift-cards/${id}/transactions`, { query: page, signal }),
};
