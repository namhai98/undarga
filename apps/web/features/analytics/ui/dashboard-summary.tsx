'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RankedBars } from '@/components/charts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useCompany } from '@/features/companies';
import { useDashboard } from '../api/use-analytics';
import { STATUS_LABEL, moneyOrDash } from '../model/report-display';
import type { ReportStatus } from '@/services/analytics.service';
import { useT } from '@/lib/i18n';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * The morning screen.
 *
 * One request, so every figure is from the same instant. Opens to anybody
 * with `report:read`; money shows only with `report:revenue:read`, and when it
 * is withheld the screen says so instead of showing zeros.
 */
export function DashboardSummary() {
  const t = useT();
  const canRead = useCan('report:read');
  const [branchId, setBranchId] = useState('');
  const branches = useBranches();
  const company = useCompany();
  const dashboard = useDashboard({ branchId: branchId || undefined });
  const currencyCode = company.data?.currencyCode ?? 'MNT';
  const money = (minor: string | null) => moneyOrDash(minor, currencyCode);

  if (!canRead) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('Today')}</CardTitle>
          <CardDescription>{t('The dashboard needs the reporting permission.')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const branchOptions = branches.data?.items ?? [];

  return (
    <section className="grid gap-4" aria-labelledby="dashboard-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 id="dashboard-title" className="text-lg font-semibold">
            {t('Today')}
          </h2>
          {dashboard.data ? (
            <p className="text-muted-foreground text-xs">
              {dashboard.data.date} · {dashboard.data.timezone}
            </p>
          ) : null}
        </div>
        {branchOptions.length > 1 ? (
          <div className="grid gap-1">
            <Label htmlFor="dashboard-branch" className="text-xs">
              {t('Branch')}
            </Label>
            <select
              id="dashboard-branch"
              value={branchId}
              className={selectClass}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">{t('All branches')}</option>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {dashboard.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <span className="sr-only">{t('Loading today’s figures…')}</span>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      ) : dashboard.error || !dashboard.data ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not load today’s figures')}</AlertTitle>
          <AlertDescription>{t('Please try again.')}</AlertDescription>
        </Alert>
      ) : (
        <Figures data={dashboard.data} money={money} />
      )}
    </section>
  );
}

function Figures({
  data,
  money,
}: {
  data: NonNullable<ReturnType<typeof useDashboard>['data']>;
  money: (minor: string | null) => string;
}) {
  const t = useT();
  const { appointments } = data;
  const statuses = Object.entries(appointments.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({
      key: status,
      label: STATUS_LABEL[status as ReportStatus] ?? status,
      value: count,
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={t('Appointments today')} value={appointments.today} />
        <Stat
          label={t('Upcoming')}
          value={appointments.upcoming}
          hint={t('next {days} days', { days: appointments.upcomingDays })}
        />
        <Stat label={t('Completed')} value={appointments.completed} hint={t('today')} />
        <Stat label={t('Cancelled')} value={appointments.cancelled} hint={t('today')} />
        <Stat
          label={t('No-show')}
          value={appointments.noShow}
          hint={t('today')}
          warn={appointments.noShow > 0}
        />
        <Stat
          label={t('New customers')}
          value={data.customers.newToday}
          hint={t('{newInWindow} in {windowDays} days', {
            newInWindow: data.customers.newInWindow,
            windowDays: data.windowDays,
          })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('Today by status')}</CardTitle>
          </CardHeader>
          <CardContent>
            {statuses.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('Nothing booked for today.')}</p>
            ) : (
              <RankedBars title={t('Today’s appointments by status')} items={statuses} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Popular services')}</CardTitle>
            <CardDescription>
              {t('Bookings over the last {windowDays} days, cancellations excluded.', {
                windowDays: data.windowDays,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.popularServices.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t('No bookings in that window yet.')}
              </p>
            ) : (
              <RankedBars
                title={t('Popular services')}
                items={data.popularServices.map((s) => ({
                  key: s.serviceId,
                  label: s.name ?? 'Unnamed service',
                  value: s.bookings,
                  ...(s.bookedValueMinor !== null ? { hint: money(s.bookedValueMinor) } : {}),
                }))}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Promotion activity')}</CardTitle>
            <CardDescription>
              {t('Last {windowDays} days.', { windowDays: data.windowDays })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              <Figure label={t('Redemptions')} value={String(data.promotions.redemptions)} />
              <Figure label={t('Discount given')} value={money(data.promotions.discountMinor)} />
              <div className="col-span-2">
                <Figure
                  label={t('Most used')}
                  value={
                    data.promotions.topPromotion
                      ? `${data.promotions.topPromotion.name ?? 'Unnamed'} (${data.promotions.topPromotion.redemptions})`
                      : '—'
                  }
                />
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Gift card activity')}</CardTitle>
            <CardDescription>
              {t('Redemptions over the last {windowDays} days.', { windowDays: data.windowDays })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              <Figure label={t('Redemptions')} value={String(data.giftCards.redemptions)} />
              <Figure label={t('Redeemed')} value={money(data.giftCards.redeemedMinor)} />
              <Figure
                label={t('Active cards')}
                value={
                  data.giftCards.activeCards === null ? '—' : String(data.giftCards.activeCards)
                }
              />
              <Figure
                label={t('Outstanding balance')}
                value={money(data.giftCards.outstandingLiabilityMinor)}
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      {data.revenue && data.outstanding ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardContent className="grid gap-1 pt-6">
              <p className="text-muted-foreground text-xs">{t('Taken today')}</p>
              <p className="text-xl font-semibold tabular-nums">{money(data.revenue.netMinor)}</p>
              <p className="text-muted-foreground text-xs">
                {data.revenue.paymentCount === 1
                  ? t('1 payment')
                  : t('{count} payments', { count: data.revenue.paymentCount })}
                {data.revenue.refundedMinor !== '0'
                  ? t(' · {amount} refunded', { amount: money(data.revenue.refundedMinor) })
                  : ''}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-1 pt-6">
              <p className="text-muted-foreground text-xs">{t('Outstanding')}</p>
              <p className="text-xl font-semibold tabular-nums">
                {money(data.outstanding.amountMinor)}
              </p>
              <p className="text-muted-foreground text-xs">
                {data.outstanding.appointmentCount} {t('unpaid booking')}
                {data.outstanding.appointmentCount === 1 ? '' : 's'}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {data.restricted.length > 0 ? (
        <p className="text-muted-foreground text-xs" role="note">
          {data.restricted.includes('amounts')
            ? t('Money figures are hidden: they need the revenue reporting permission. ')
            : ''}
          {data.restricted.includes('giftCardInventory')
            ? t('Gift card totals are company-wide and hidden for branch-limited accounts.')
            : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Link href="/reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('Reports')}
        </Link>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: number;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <Card>
      <CardContent className="grid gap-0.5 pt-5 pb-4">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p
          className={`text-2xl font-semibold tabular-nums ${warn ? 'text-amber-600 dark:text-amber-500' : ''}`}
        >
          {value}
        </p>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}
