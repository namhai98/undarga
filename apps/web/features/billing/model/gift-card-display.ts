import { formatMoney } from '@undarga/shared';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type { GiftCardStatus, GiftCardTransaction } from '@/services/billing.service';

export const GIFT_CARD_STATUS_LABEL: Record<GiftCardStatus, string> = {
  PENDING_ACTIVATION: 'Not activated',
  ACTIVE: 'Active',
  DEPLETED: 'Spent',
  EXPIRED: 'Expired',
  DISABLED: 'Disabled',
  VOID: 'Void',
};

/** The filter a member of staff actually uses; the rarer states are still shown on a card. */
export const GIFT_CARD_FILTER_STATUSES: GiftCardStatus[] = [
  'ACTIVE',
  'DEPLETED',
  'EXPIRED',
  'DISABLED',
  'VOID',
];

export function giftCardStatusVariant(
  status: GiftCardStatus,
): 'default' | 'secondary' | 'destructive' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'DISABLED' || status === 'VOID') return 'destructive';
  return 'secondary';
}

export const TRANSACTION_LABEL: Record<GiftCardTransaction['type'], string> = {
  ISSUE: 'Issued',
  REDEEM: 'Redeemed',
  REFUND: 'Refunded',
  ADJUSTMENT: 'Adjustment',
  EXPIRE: 'Expired',
  VOID: 'Voided',
};

/** Formats a minor-unit string in a card's own currency. Display only. */
export function giftCardMoney(minor: string, currencyCode: string): string {
  return formatMoney({ amountMinor: minor, currencyCode }, currencyFormat(currencyCode));
}

/** `-40000` → `−400.00`, `15000` → `+150.00`. The ledger's signed amounts. */
export function signedMoney(minor: string, currencyCode: string): string {
  const negative = minor.startsWith('-');
  return `${negative ? '−' : '+'}${giftCardMoney(negative ? minor.slice(1) : minor, currencyCode)}`;
}

/**
 * A date input's `YYYY-MM-DD` as the END of that day in the viewer's timezone,
 * so "expires 31 December" is still good on 31 December.
 */
export function endOfDayIso(day: string): string {
  return new Date(`${day}T23:59:59.999`).toISOString();
}

/** Today in the viewer's calendar, for a date input's `min`. */
export function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One sentence for a failed gift-card action. The server's own words where they are meant for people. */
export function giftCardErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'GIFT_CARD_NOT_USABLE':
    case 'CONFLICT':
    case 'RESOURCE_NOT_FOUND':
      return error.message;
    case 'VALIDATION_FAILED':
      return firstIssue(error.details?.['issues']) ?? fallback;
    case 'PERMISSION_DENIED':
      return 'You do not have permission to do that.';
    default:
      return fallback;
  }
}

/**
 * `issues` is either zod's array (`[{ path, message }]`, from request
 * validation) or a field → sentence map (from a service's own check).
 */
function firstIssue(issues: unknown): string | null {
  if (Array.isArray(issues)) {
    const first = issues[0] as { message?: unknown } | undefined;
    return typeof first?.message === 'string' ? first.message : null;
  }
  if (issues && typeof issues === 'object') {
    const first = Object.values(issues)[0];
    return typeof first === 'string' ? first : null;
  }
  return null;
}
