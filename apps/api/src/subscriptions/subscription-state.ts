import type { SubscriptionStatus } from '@prisma/client';

/** Days between an unpaid invoice's due date and the subscription expiring. */
export const GRACE_DAYS = 7;
/** Days a newly issued invoice has before it is due. */
export const INVOICE_DUE_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

export interface SubscriptionClock {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
  graceEndsAt: Date | null;
}

/**
 * The status as of `now`, from the stored status and its timestamps.
 *
 * The lifecycle sweep writes these transitions down, but access must not wait
 * for it: a trial that ended a minute ago is over now, whether or not the
 * sweep has run. Every access decision uses this, never the raw column.
 *
 *   TRIAL      → EXPIRED once `trial_ends_at` passes
 *   CANCELLED  → EXPIRED once the paid-for period ends
 *   PAST_DUE   → EXPIRED once the grace period ends
 *   ACTIVE     stays ACTIVE; renewal is the sweep's job (it issues the next
 *              invoice, and an unpaid one leads to PAST_DUE)
 */
export function effectiveStatus(sub: SubscriptionClock, now = new Date()): SubscriptionStatus {
  switch (sub.status) {
    case 'TRIAL':
      return sub.trialEndsAt && sub.trialEndsAt <= now ? 'EXPIRED' : 'TRIAL';
    case 'CANCELLED':
      return sub.currentPeriodEnd <= now ? 'EXPIRED' : 'CANCELLED';
    case 'PAST_DUE':
      return sub.graceEndsAt && sub.graceEndsAt <= now ? 'EXPIRED' : 'PAST_DUE';
    default:
      return sub.status;
  }
}

/** Statuses in which the company may still change things. */
export function grantsAccess(status: SubscriptionStatus): boolean {
  return (
    status === 'TRIAL' || status === 'ACTIVE' || status === 'PAST_DUE' || status === 'CANCELLED'
  );
}

export function addInterval(from: Date, interval: 'MONTH' | 'YEAR'): Date {
  const next = new Date(from);
  if (interval === 'YEAR') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Whole days from now until `until`, never negative. */
export function daysUntil(until: Date, now = new Date()): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
}
