import { formatMoney } from '@undarga/shared';
import { currencyFormat } from '@/lib/currency';
import type { PortalAppointmentStatus } from '@/services/customer-portal.service';

export function money(amountMinor: string, currencyCode: string): string {
  return formatMoney({ amountMinor, currencyCode }, currencyFormat(currencyCode));
}

/** A date and time as the BUSINESS reads it — the appointment's own timezone. */
export function when(iso: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function time(iso: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function day(iso: string | null, locale?: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export const STATUS_LABEL: Record<PortalAppointmentStatus, string> = {
  PENDING: 'Awaiting confirmation',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Missed',
};

export function statusTone(
  status: PortalAppointmentStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'CONFIRMED' || status === 'COMPLETED') return 'default';
  if (status === 'CANCELLED' || status === 'NO_SHOW') return 'outline';
  return 'secondary';
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  UNPAID: 'Not paid',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
  PARTIALLY_REFUNDED: 'Partly refunded',
  REFUNDED: 'Refunded',
};

export const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  ONLINE: 'Online',
  GIFT_CARD: 'Gift card',
  WALLET: 'Wallet',
  OTHER: 'Other',
};

export const GIFT_TXN_LABEL: Record<string, string> = {
  ISSUE: 'Issued',
  REDEEM: 'Used',
  REFUND: 'Refunded to card',
  ADJUSTMENT: 'Adjusted',
  EXPIRE: 'Expired',
  VOID: 'Voided',
};

/** `YYYY-MM-DD` for "today + n" in a timezone, for the reschedule date picker. */
export function isoDateIn(timeZone: string, addDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + addDays * 86_400_000));
  return parts;
}
