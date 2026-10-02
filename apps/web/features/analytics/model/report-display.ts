import { formatMoney } from '@undarga/shared';
import { currencyFormat } from '@/lib/currency';
import type { ReportStatus } from '@/services/analytics.service';

export const STATUS_LABEL: Record<ReportStatus, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

/** Basis points → `12.5%`. */
export function percent(bps: number): string {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** Money for a report cell: null (not permitted) renders as a dash, never a zero. */
export function moneyOrDash(minor: string | null, currencyCode: string): string {
  if (minor === null) return '—';
  return formatMoney({ amountMinor: minor, currencyCode }, currencyFormat(currencyCode));
}

/** `2025-03-05` → `5 Mar` in the viewer's locale; no timezone games, it is a calendar day. */
export function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** `YYYY-MM-DD` for today minus `days`, in the viewer's calendar. */
export function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoDay(d);
}

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function firstOfMonth(): string {
  const d = new Date();
  return isoDay(new Date(d.getFullYear(), d.getMonth(), 1));
}

export const RANGE_PRESETS = [
  { id: '7', label: 'Last 7 days', from: () => daysAgo(6) },
  { id: '30', label: 'Last 30 days', from: () => daysAgo(29) },
  { id: '90', label: 'Last 90 days', from: () => daysAgo(89) },
  { id: 'month', label: 'This month', from: firstOfMonth },
] as const;
