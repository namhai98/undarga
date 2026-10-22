import { apiClient } from './api-client';

/**
 * Online payments through the configured provider (docs/PAYMENTS.md).
 *
 * Nothing here reports a payment as paid. The browser starts a checkout and
 * then READS the status the server got from the provider — by webhook or by
 * its own status check. There is no call that sets a status.
 */

export type OnlinePaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface OnlineCheckout {
  redirectUrl?: string | null;
  qrText?: string | null;
  /** A `data:` URL. */
  qrImage?: string | null;
  deeplinks?: Array<{ name: string; link: string; logo?: string | null }>;
  /** The local simulator (development only). */
  simulated?: boolean;
}

/** What every caller sees. */
export interface OnlinePaymentBase {
  id: string;
  kind: 'APPOINTMENT' | 'SUBSCRIPTION_INVOICE';
  status: OnlinePaymentStatus;
  purpose: string | null;
  reference: string | null;
  amountMinor: string;
  refundedMinor: string;
  currencyCode: string;
  provider: string;
  /** Only while it can still be paid. */
  checkout: OnlineCheckout | null;
  expiresAt: string | null;
  failureReason: string | null;
  /** A new attempt may be started. */
  retryable: boolean;
  createdAt: string;
  succeededAt: string | null;
}

/** Staff view. */
export interface OnlinePayment extends OnlinePaymentBase {
  feeMinor: string;
  appointmentId: string | null;
  subscriptionInvoiceId: string | null;
  paymentId: string | null;
  providerReference: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
}

/** On a public booking confirmation, when online payment is possible. */
export interface PublicPaymentOffer {
  token: string;
  amountMinor: string;
  currencyCode: string;
  purpose: string;
}

export type SimulatedOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** One key per checkout attempt; a retried request reuses it. */
export function newIdempotencyKey(): string {
  return `ui-${crypto.randomUUID()}`;
}

export const onlinePaymentsService = {
  startForAppointment: (input: { appointmentId: string; amountMinor?: string; idempotencyKey: string }) =>
    apiClient.post<OnlinePayment>('/payments', input),

  payInvoice: (companyId: string, invoiceId: string, idempotencyKey: string) =>
    apiClient.post<OnlinePayment>(`/companies/${companyId}/billing/${invoiceId}/pay`, {
      idempotencyKey,
    }),

  get: (id: string, signal?: AbortSignal) => apiClient.get<OnlinePayment>(`/payments/${id}`, { signal }),

  cancel: (id: string) => apiClient.post<OnlinePayment>(`/payments/${id}/cancel`),

  refund: (id: string, input: { amountMinor?: string; reason: string }) =>
    apiClient.post<OnlinePayment>(`/payments/${id}/refund`, input),

  simulate: (id: string, outcome: SimulatedOutcome) =>
    apiClient.post<OnlinePayment>(`/payments/${id}/simulate`, { outcome }),

  // -- Public: the booker, holding the confirmation's payment token ----------

  startPublic: (slug: string, paymentToken: string, idempotencyKey: string) =>
    apiClient.post<OnlinePaymentBase>(
      `/public/companies/${encodeURIComponent(slug)}/payments`,
      { paymentToken, idempotencyKey },
      { anonymous: true },
    ),

  getPublic: (slug: string, id: string, token: string, signal?: AbortSignal) =>
    apiClient.get<OnlinePaymentBase>(`/public/companies/${encodeURIComponent(slug)}/payments/${id}`, {
      query: { token },
      signal,
      anonymous: true,
    }),

  simulatePublic: (slug: string, id: string, token: string, outcome: SimulatedOutcome) =>
    apiClient.post<OnlinePaymentBase>(
      `/public/companies/${encodeURIComponent(slug)}/payments/${id}/simulate`,
      { token, outcome },
      { anonymous: true },
    ),
};
