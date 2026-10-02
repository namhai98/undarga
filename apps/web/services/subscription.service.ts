import { apiClient } from './api-client';

/**
 * The company's SaaS subscription and its invoices.
 *
 * Money is minor units as a string. Limits are numbers, null = unlimited.
 * `status` is the EFFECTIVE status: a trial that ended reads EXPIRED at once.
 */

export type SubscriptionStatus =
  | 'TRIAL'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'GRACE'
  | 'SUSPENDED';
export type LimitKey =
  | 'MAX_BRANCHES'
  | 'MAX_EMPLOYEES'
  | 'MAX_SERVICES'
  | 'MAX_RESOURCES'
  | 'MAX_CUSTOMERS'
  | 'MAX_APPOINTMENTS_PER_MONTH';
export type FeatureKey = 'GIFT_CARDS' | 'PROMOTIONS' | 'ONLINE_BOOKING' | 'MULTI_BRANCH';

export interface Plan {
  key: string;
  name: string;
  description: string | null;
  priceMinor: string;
  currencyCode: string;
  interval: 'MONTH' | 'YEAR';
  trialDays: number;
  current: boolean;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, number | null>;
}

export interface SubscriptionOverview {
  subscription: {
    id: string;
    status: SubscriptionStatus;
    plan: {
      key: string;
      name: string;
      priceMinor: string;
      currencyCode: string;
      interval: 'MONTH' | 'YEAR';
    };
    trial: { endsAt: string; daysLeft: number } | null;
    currentPeriod: { start: string; end: string };
    cancelAtPeriodEnd: boolean;
    canceledAt: string | null;
    graceEndsAt: string | null;
    expiredAt: string | null;
    readOnly: boolean;
  } | null;
  trialAvailable: boolean;
  features: Record<FeatureKey, boolean>;
  usage: Array<{ key: LimitKey; label: string; used: number; limit: number | null }>;
  plans: Plan[];
  openInvoice: {
    id: string;
    number: string;
    totalMinor: string;
    currencyCode: string;
    dueAt: string | null;
  } | null;
}

export type InvoiceStatus = 'DRAFT' | 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID';

export interface Invoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  plan: { id: string | null; name: string | null };
  amountMinor: string;
  taxMinor: string;
  totalMinor: string;
  amountPaidMinor: string;
  currencyCode: string;
  period: { start: string; end: string };
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

const base = (companyId: string) => `/companies/${companyId}`;

export const subscriptionService = {
  get: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<SubscriptionOverview>(`${base(companyId)}/subscription`, { signal }),

  startTrial: (companyId: string, planKey: string) =>
    apiClient.post<SubscriptionOverview>(`${base(companyId)}/subscription/start-trial`, {
      planKey,
    }),

  changePlan: (companyId: string, planKey: string) =>
    apiClient.post<SubscriptionOverview>(`${base(companyId)}/subscription/change-plan`, {
      planKey,
    }),

  cancel: (companyId: string, reason?: string) =>
    apiClient.post<SubscriptionOverview>(
      `${base(companyId)}/subscription/cancel`,
      reason ? { reason } : {},
    ),

  reactivate: (companyId: string) =>
    apiClient.post<SubscriptionOverview>(`${base(companyId)}/subscription/reactivate`, {}),

  invoices: (
    companyId: string,
    query: { status?: InvoiceStatus; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    apiClient.get<{ items: Invoice[]; total: number; limit: number; offset: number }>(
      `${base(companyId)}/billing`,
      {
        query: { ...query },
        signal,
      },
    ),

  invoice: (companyId: string, invoiceId: string, signal?: AbortSignal) =>
    apiClient.get<Invoice>(`${base(companyId)}/billing/${invoiceId}`, { signal }),
};
