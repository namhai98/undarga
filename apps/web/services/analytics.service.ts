import { apiClient } from './api-client';

/**
 * Numbers about the business.
 *
 * Money is minor units as a string throughout, and NULL when the caller lacks
 * `report:revenue:read` (`amountsVisible: false`) — never a fake zero. Counts
 * are plain numbers; rates are BASIS POINTS (12.5% is 1250). Days are calendar
 * days in the company's timezone.
 */

export interface DashboardSummary {
  date: string;
  timezone: string;
  branchId: string | null;
  windowDays: number;
  /** What was withheld: 'revenue', 'amounts', 'giftCardInventory'. */
  restricted: string[];
  amountsVisible: boolean;
  appointments: {
    today: number;
    byStatus: Record<string, number>;
    completed: number;
    cancelled: number;
    noShow: number;
    upcoming: number;
    upcomingDays: number;
  };
  customers: { newToday: number; newInWindow: number };
  popularServices: Array<{
    serviceId: string;
    name: string | null;
    bookings: number;
    bookedValueMinor: string | null;
  }>;
  promotions: {
    redemptions: number;
    discountMinor: string | null;
    topPromotion: { promotionId: string; name: string | null; redemptions: number } | null;
  };
  giftCards: {
    activeCards: number | null;
    issuedInWindow: number | null;
    redemptions: number;
    redeemedMinor: string | null;
    outstandingLiabilityMinor: string | null;
  };
  /** Money TAKEN, not money booked. Null without `report:revenue:read`. */
  revenue: {
    collectedMinor: string;
    refundedMinor: string;
    netMinor: string;
    paymentCount: number;
  } | null;
  outstanding: { amountMinor: string; appointmentCount: number } | null;
}

export const REPORT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportQuery {
  from: string;
  /** Inclusive — the whole of this day is in the range. */
  to: string;
  branchId?: string;
  employeeId?: string;
  serviceId?: string;
  /** Comma-separated statuses. */
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ReportHeader {
  range: { from: string; to: string; timezone: string };
  filters: {
    branchIds: string[] | null;
    employeeId: string | null;
    serviceId: string | null;
    statuses: ReportStatus[];
  };
  amountsVisible: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface BreakdownRow {
  id: string;
  name: string | null;
  bookings: number;
  completed: number;
  cancelled: number;
  noShow: number;
  bookedValueMinor: string | null;
}

export interface AppointmentsReport extends ReportHeader {
  totals: {
    total: number;
    pending: number;
    confirmed: number;
    checkedIn: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    noShow: number;
    completionRateBps: number;
    cancellationRateBps: number;
    noShowRateBps: number;
    bookedValueMinor: string | null;
  };
  byDay: Array<{
    date: string;
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    other: number;
  }>;
  byService: Page<BreakdownRow>;
  byEmployee: Page<BreakdownRow>;
  byBranch: Page<BreakdownRow>;
}

export interface CustomersReport extends ReportHeader {
  filtered: boolean;
  totals: {
    newCustomers: number;
    activeCustomers: number;
    returningCustomers: number;
    totalCustomers: number | null;
    startingTotal: number | null;
  };
  byDay: Array<{ date: string; newCustomers: number; totalCustomers: number | null }>;
}

export interface ServicesReport extends ReportHeader {
  totals: { bookings: number; services: number };
  items: Page<BreakdownRow & { shareBps: number }>;
  trend: {
    services: Array<{ serviceId: string; name: string | null }>;
    days: Array<{ date: string; counts: Record<string, number> }>;
  };
}

export interface PromotionsReport extends ReportHeader {
  totals: {
    redemptions: number;
    customers: number;
    promotionsUsed: number;
    discountMinor: string | null;
  };
  byPromotion: Page<{
    promotionId: string;
    name: string | null;
    discountType: string | null;
    status: string | null;
    redemptions: number;
    customers: number;
    discountMinor: string | null;
    usage: { redeemed: number; limit: number | null };
  }>;
  byDay: Array<{ date: string; redemptions: number; discountMinor: string | null }>;
}

export interface GiftCardsReport extends ReportHeader {
  appliedFilters: Record<'dateRange' | 'branch' | 'employee' | 'service' | 'status', boolean>;
  inventoryVisible: boolean;
  issued: { count: number; initialValueMinor: string | null } | null;
  cards: {
    active: number;
    expired: number;
    depleted: number;
    disabled: number;
    void: number;
    outstandingBalanceMinor: string | null;
    expiredBalanceMinor: string | null;
  } | null;
  redemptions: {
    totals: {
      redemptions: number;
      redeemedMinor: string | null;
      refunds: number;
      refundedMinor: string | null;
    };
    byDay: Array<{
      date: string;
      redemptions: number;
      redeemedMinor: string | null;
      refunds: number;
      refundedMinor: string | null;
    }>;
  };
}

export interface RevenueReport {
  from: string;
  to: string;
  timezone: string;
  items: Array<{
    date: string;
    collectedMinor: string;
    refundedMinor: string;
    netMinor: string;
    paymentCount: number;
  }>;
  totals: { collectedMinor: string; refundedMinor: string; netMinor: string };
}

export interface PaymentMethodReport {
  from: string;
  to: string;
  items: Array<{
    method: string;
    count: number;
    collectedMinor: string;
    refundedMinor: string;
    feesMinor: string;
    netMinor: string;
  }>;
  totals: { collectedMinor: string; refundedMinor: string; feesMinor: string };
}

const base = (companyId: string) => `/companies/${companyId}`;
const report =
  <T>(name: string) =>
  (companyId: string, query: ReportQuery, signal?: AbortSignal) =>
    apiClient.get<T>(`${base(companyId)}/reports/${name}`, { query: { ...query }, signal });

export const analyticsService = {
  dashboard: (
    companyId: string,
    query: { date?: string; branchId?: string } = {},
    signal?: AbortSignal,
  ) =>
    apiClient.get<DashboardSummary>(`${base(companyId)}/dashboard`, {
      query: { ...query },
      signal,
    }),

  appointments: report<AppointmentsReport>('appointments'),
  customers: report<CustomersReport>('customers'),
  services: report<ServicesReport>('services'),
  promotions: report<PromotionsReport>('promotions'),
  giftCards: report<GiftCardsReport>('gift-cards'),
  revenue: report<RevenueReport>('revenue'),
  paymentMethods: report<PaymentMethodReport>('payment-methods'),
};

export type ReportName = Exclude<keyof typeof analyticsService, 'dashboard'>;
