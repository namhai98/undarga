import { formatMoney } from '@undarga/shared';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type {
  FeatureKey,
  InvoiceStatus,
  LimitKey,
  SubscriptionStatus,
} from '@/services/subscription.service';

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment overdue',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  GRACE: 'Grace period',
  SUSPENDED: 'Suspended',
};

export function statusVariant(status: SubscriptionStatus): 'default' | 'secondary' | 'destructive' {
  if (status === 'ACTIVE' || status === 'TRIAL') return 'default';
  if (status === 'EXPIRED' || status === 'PAST_DUE' || status === 'SUSPENDED') return 'destructive';
  return 'secondary';
}

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  PAID: 'Paid',
  UNCOLLECTIBLE: 'Uncollectible',
  VOID: 'Void',
};

export const FEATURE_LABEL: Record<FeatureKey, string> = {
  ONLINE_BOOKING: 'Online booking page',
  PROMOTIONS: 'Promotions and codes',
  GIFT_CARDS: 'Gift cards',
  MULTI_BRANCH: 'Multiple branches',
};

export const LIMIT_LABEL: Record<LimitKey, string> = {
  MAX_BRANCHES: 'Branches',
  MAX_EMPLOYEES: 'Employees',
  MAX_SERVICES: 'Services',
  MAX_RESOURCES: 'Rooms and equipment',
  MAX_CUSTOMERS: 'Customers',
  MAX_APPOINTMENTS_PER_MONTH: 'Appointments / month',
};

export function money(minor: string, currencyCode: string): string {
  return formatMoney({ amountMinor: minor, currencyCode }, currencyFormat(currencyCode));
}

export function price(minor: string, currencyCode: string, interval: 'MONTH' | 'YEAR'): string {
  if (minor === '0') return 'Free';
  return `${money(minor, currencyCode)} / ${interval === 'YEAR' ? 'year' : 'month'}`;
}

export function limitText(limit: number | null): string {
  return limit === null ? 'Unlimited' : limit.toLocaleString();
}

export function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

/** The server's words where they are meant for people; the plan-limit numbers spelled out. */
export function subscriptionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === 'PLAN_LIMIT_EXCEEDED') {
    const violations = error.details?.['violations'];
    if (Array.isArray(violations) && violations.length > 0) {
      const parts = (violations as Array<{ limit: LimitKey; max: number; current: number }>).map(
        (v) => `${LIMIT_LABEL[v.limit] ?? v.limit}: ${v.current} in use, plan allows ${v.max}`,
      );
      return `Current usage is above that plan’s limits — ${parts.join('; ')}.`;
    }
    return error.message;
  }
  if (error.code === 'CONFLICT' || error.code === 'RESOURCE_NOT_FOUND') return error.message;
  if (error.code === 'PERMISSION_DENIED')
    return 'Only the account owner can change the subscription.';
  return fallback;
}
