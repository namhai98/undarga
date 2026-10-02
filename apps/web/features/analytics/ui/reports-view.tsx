'use client';

import { useState, type ReactNode } from 'react';
import { SERIES_COLOURS, StackedBarChart, type ChartSeries } from '@/components/charts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useServices } from '@/features/catalog';
import { useCompany } from '@/features/companies';
import { useEmployees } from '@/features/employees';
import { ApiError } from '@/services/api-error';
import {
  REPORT_STATUSES,
  type AppointmentsReport,
  type BreakdownRow,
  type CustomersReport,
  type GiftCardsReport,
  type Page,
  type PaymentMethodReport,
  type PromotionsReport,
  type ReportQuery,
  type RevenueReport,
  type ServicesReport,
} from '@/services/analytics.service';
import { useReport } from '../api/use-analytics';
import {
  RANGE_PRESETS,
  STATUS_LABEL,
  daysAgo,
  isoDay,
  moneyOrDash,
  percent,
  shortDay,
} from '../model/report-display';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

type Tab = 'appointments' | 'customers' | 'services' | 'promotions' | 'giftCards' | 'revenue';
const TABS: Array<{ id: Tab; label: string; money?: boolean }> = [
  { id: 'appointments', label: 'Appointments' },
  { id: 'customers', label: 'Customers' },
  { id: 'services', label: 'Services' },
  { id: 'promotions', label: 'Promotions' },
  { id: 'giftCards', label: 'Gift cards' },
  { id: 'revenue', label: 'Revenue', money: true },
];

/**
 * Reports: one filter bar over every report.
 *
 * Nothing is computed here — each tab is one request and draws what comes
 * back. Filters are validated and scoped on the server (tenant, branch scope,
 * permissions); the dropdowns only offer what this user can list. Money
 * columns show a dash when the caller may not see amounts.
 */
export function ReportsView() {
  const canRead = useCan('report:read');
  const canSeeMoney = useCan('report:revenue:read');
  const [tab, setTab] = useState<Tab>('appointments');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(isoDay(new Date()));
  const [branchId, setBranchId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [status, setStatus] = useState('');

  const branches = useBranches();
  const employees = useEmployees({ limit: 100 });
  const services = useServices({ limit: 100 });
  const company = useCompany();
  const currencyCode = company.data?.currencyCode ?? 'MNT';

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>You do not have permission to see reports.</AlertDescription>
      </Alert>
    );
  }

  const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  // Checked here so a half-typed date never becomes a request the server refuses.
  const rangeError =
    !isDay(from) || !isDay(to)
      ? 'Choose a start and an end date.'
      : from > to
        ? 'The range must start before it ends.'
        : null;
  const query: ReportQuery = {
    from,
    to,
    ...(branchId ? { branchId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(status ? { status } : {}),
  };
  const tabs = TABS.filter((t) => !t.money || canSeeMoney);

  return (
    <section className="grid gap-4" aria-labelledby="reports-title">
      <header className="grid gap-1">
        <h1 id="reports-title" className="text-xl font-semibold">
          Reports
        </h1>
        <p className="text-muted-foreground text-sm">
          Days are counted in the company’s timezone. Figures are aggregated on the server; no
          customer is named.
        </p>
      </header>

      <Card>
        <CardContent className="grid gap-3 pt-6">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Date presets">
            {RANGE_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                size="sm"
                variant="outline"
                onClick={() => {
                  setFrom(preset.from());
                  setTo(isoDay(new Date()));
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Field id="report-from" label="From">
              <Input
                id="report-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field id="report-to" label="To">
              <Input
                id="report-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field id="report-branch" label="Branch">
              <select
                id="report-branch"
                className={selectClass}
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
              >
                <option value="">All branches</option>
                {(branches.data?.items ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="report-employee" label="Employee">
              <select
                id="report-employee"
                className={selectClass}
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              >
                <option value="">All employees</option>
                {(employees.data?.items ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="report-service" label="Service">
              <select
                id="report-service"
                className={selectClass}
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
              >
                <option value="">All services</option>
                {(services.data?.items ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="report-status" label="Status">
              <select
                id="report-status"
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All statuses</option>
                {REPORT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
                <option value="CANCELLED,NO_SHOW">Cancelled or no-show</option>
              </select>
            </Field>
          </div>
          {rangeError ? (
            <p role="alert" className="text-destructive text-sm">
              {rangeError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div
        role="tablist"
        aria-label="Report"
        className="border-border/60 flex gap-1 overflow-x-auto border-b"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`report-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="report-panel"
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? 'border-primary font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="report-panel" aria-labelledby={`report-tab-${tab}`}>
        {rangeError ? null : (
          // Remounting on a filter change resets each report's own paging.
          <ReportTab
            key={`${tab}:${JSON.stringify(query)}`}
            tab={tab}
            query={query}
            currencyCode={currencyCode}
          />
        )}
      </div>
    </section>
  );
}

function ReportTab({
  tab,
  query,
  currencyCode,
}: {
  tab: Tab;
  query: ReportQuery;
  currencyCode: string;
}) {
  switch (tab) {
    case 'appointments':
      return <AppointmentsTab query={query} currencyCode={currencyCode} />;
    case 'customers':
      return <CustomersTab query={query} />;
    case 'services':
      return <ServicesTab query={query} currencyCode={currencyCode} />;
    case 'promotions':
      return <PromotionsTab query={query} currencyCode={currencyCode} />;
    case 'giftCards':
      return <GiftCardsTab query={query} currencyCode={currencyCode} />;
    case 'revenue':
      return <RevenueTab query={query} currencyCode={currencyCode} />;
  }
}

// =============================================================================
// Tabs
// =============================================================================

function AppointmentsTab({ query, currencyCode }: { query: ReportQuery; currencyCode: string }) {
  const [limit, setLimit] = useState(10);
  const report = useReport<AppointmentsReport>('appointments', { ...query, limit });

  return (
    <Loaded report={report} name="appointments">
      {(data) =>
        data.totals.total === 0 ? (
          <Empty what="appointments" />
        ) : (
          <div className="grid gap-4">
            <Stats
              items={[
                ['Total', String(data.totals.total)],
                [
                  'Completed',
                  `${data.totals.completed} · ${percent(data.totals.completionRateBps)}`,
                ],
                [
                  'Cancelled',
                  `${data.totals.cancelled} · ${percent(data.totals.cancellationRateBps)}`,
                ],
                ['No-show', `${data.totals.noShow} · ${percent(data.totals.noShowRateBps)}`],
                [
                  'Upcoming (pending/confirmed)',
                  String(data.totals.pending + data.totals.confirmed),
                ],
                ['Booked value', moneyOrDash(data.totals.bookedValueMinor, currencyCode)],
              ]}
            />
            <ChartCard title="Appointments by day">
              <StackedBarChart
                title="Appointments by day"
                series={statusSeries}
                formatLabel={shortDay}
                data={data.byDay.map((d) => ({
                  label: d.date,
                  values: {
                    completed: d.completed,
                    other: d.other,
                    cancelled: d.cancelled,
                    noShow: d.noShow,
                  },
                }))}
              />
            </ChartCard>
            <div className="flex items-center justify-end gap-2">
              <Label htmlFor="breakdown-rows" className="text-xs">
                Rows per table
              </Label>
              <select
                id="breakdown-rows"
                className={`${selectClass} w-20`}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-4 xl:grid-cols-3">
              <BreakdownTable
                title="By service"
                label="Service"
                page={data.byService}
                currencyCode={currencyCode}
              />
              <BreakdownTable
                title="By employee"
                label="Employee"
                page={data.byEmployee}
                currencyCode={currencyCode}
              />
              <BreakdownTable
                title="By branch"
                label="Branch"
                page={data.byBranch}
                currencyCode={currencyCode}
              />
            </div>
          </div>
        )
      }
    </Loaded>
  );
}

function CustomersTab({ query }: { query: ReportQuery }) {
  const report = useReport<CustomersReport>('customers', query);
  return (
    <Loaded report={report} name="customers">
      {(data) => (
        <div className="grid gap-4">
          <Stats
            items={[
              ['New customers', String(data.totals.newCustomers)],
              ['Active customers', String(data.totals.activeCustomers)],
              ['Returning', String(data.totals.returningCustomers)],
              [
                'All customers',
                data.totals.totalCustomers === null ? '—' : String(data.totals.totalCustomers),
              ],
            ]}
          />
          {data.filtered ? (
            <p className="text-muted-foreground text-xs" role="note">
              With filters, “new” means customers created in the range who also booked in it
              matching the filters; the company-wide total is not shown.
            </p>
          ) : null}
          {data.totals.newCustomers === 0 && data.totals.activeCustomers === 0 ? (
            <Empty what="customer activity" />
          ) : (
            <>
              <ChartCard title="New customers by day">
                <StackedBarChart
                  title="New customers by day"
                  series={[{ key: 'new', label: 'New customers', ...SERIES_COLOURS[0] }]}
                  formatLabel={shortDay}
                  data={data.byDay.map((d) => ({ label: d.date, values: { new: d.newCustomers } }))}
                />
              </ChartCard>
              <TableCard
                title="Customer growth"
                head={['Day', 'New', 'Total customers']}
                rows={data.byDay.map((d) => [
                  shortDay(d.date),
                  String(d.newCustomers),
                  d.totalCustomers === null ? '—' : String(d.totalCustomers),
                ])}
              />
            </>
          )}
        </div>
      )}
    </Loaded>
  );
}

function ServicesTab({ query, currencyCode }: { query: ReportQuery; currencyCode: string }) {
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const report = useReport<ServicesReport>('services', { ...query, limit, offset });
  return (
    <Loaded report={report} name="services">
      {(data) =>
        data.totals.bookings === 0 ? (
          <Empty what="bookings" />
        ) : (
          <div className="grid gap-4">
            <Stats
              items={[
                ['Bookings', String(data.totals.bookings)],
                ['Services booked', String(data.totals.services)],
              ]}
            />
            <ChartCard
              title="Booking trends"
              description="The five most-booked services of the range."
            >
              <StackedBarChart
                title="Booking trends"
                formatLabel={shortDay}
                series={data.trend.services.map((s, i) => ({
                  key: s.serviceId,
                  label: s.name ?? 'Unnamed service',
                  ...SERIES_COLOURS[i % SERIES_COLOURS.length]!,
                }))}
                data={data.trend.days.map((d) => ({ label: d.date, values: d.counts }))}
              />
            </ChartCard>
            <TableCard
              title="Most booked services"
              head={[
                'Service',
                'Bookings',
                'Share',
                'Completed',
                'Cancelled',
                'No-show',
                'Booked value',
              ]}
              rows={data.items.items.map((r) => [
                r.name ?? 'Unnamed',
                String(r.bookings),
                percent(r.shareBps),
                String(r.completed),
                String(r.cancelled),
                String(r.noShow),
                moneyOrDash(r.bookedValueMinor, currencyCode),
              ])}
              footer={<Pager page={data.items} onOffset={setOffset} />}
            />
          </div>
        )
      }
    </Loaded>
  );
}

function PromotionsTab({ query, currencyCode }: { query: ReportQuery; currencyCode: string }) {
  const [offset, setOffset] = useState(0);
  const report = useReport<PromotionsReport>('promotions', { ...query, limit: 25, offset });
  return (
    <Loaded report={report} name="promotions">
      {(data) =>
        data.totals.redemptions === 0 ? (
          <Empty what="promotion use" />
        ) : (
          <div className="grid gap-4">
            <Stats
              items={[
                ['Redemptions', String(data.totals.redemptions)],
                ['Customers', String(data.totals.customers)],
                ['Promotions used', String(data.totals.promotionsUsed)],
                ['Discount given', moneyOrDash(data.totals.discountMinor, currencyCode)],
              ]}
            />
            <ChartCard title="Redemptions by day">
              <StackedBarChart
                title="Redemptions by day"
                series={[{ key: 'r', label: 'Redemptions', ...SERIES_COLOURS[0] }]}
                formatLabel={shortDay}
                data={data.byDay.map((d) => ({ label: d.date, values: { r: d.redemptions } }))}
              />
            </ChartCard>
            <TableCard
              title="Usage by promotion"
              head={['Promotion', 'Redemptions', 'Customers', 'Discount', 'All-time use']}
              rows={data.byPromotion.items.map((p) => [
                p.name ?? 'Unnamed',
                String(p.redemptions),
                String(p.customers),
                moneyOrDash(p.discountMinor, currencyCode),
                p.usage.limit ? `${p.usage.redeemed} / ${p.usage.limit}` : String(p.usage.redeemed),
              ])}
              footer={<Pager page={data.byPromotion} onOffset={setOffset} />}
            />
          </div>
        )
      }
    </Loaded>
  );
}

function GiftCardsTab({ query, currencyCode }: { query: ReportQuery; currencyCode: string }) {
  const report = useReport<GiftCardsReport>('giftCards', query);
  return (
    <Loaded report={report} name="gift cards">
      {(data) => (
        <div className="grid gap-4">
          {query.employeeId || query.serviceId || query.status ? (
            <p className="text-muted-foreground text-xs" role="note">
              Employee, service and status filters do not apply to gift cards.
            </p>
          ) : null}
          {data.inventoryVisible && data.issued && data.cards ? (
            <Stats
              items={[
                ['Issued in range', String(data.issued.count)],
                ['Active', String(data.cards.active)],
                ['Expired', String(data.cards.expired)],
                ['Disabled / void', String(data.cards.disabled + data.cards.void)],
                [
                  'Outstanding balance',
                  moneyOrDash(data.cards.outstandingBalanceMinor, currencyCode),
                ],
                ['Expired balance', moneyOrDash(data.cards.expiredBalanceMinor, currencyCode)],
              ]}
            />
          ) : (
            <p className="text-muted-foreground text-sm" role="note">
              Card totals are company-wide and are not shown to branch-limited accounts.
            </p>
          )}
          <Stats
            items={[
              ['Redemptions', String(data.redemptions.totals.redemptions)],
              ['Redeemed', moneyOrDash(data.redemptions.totals.redeemedMinor, currencyCode)],
              ['Refunds to cards', String(data.redemptions.totals.refunds)],
              ['Refunded', moneyOrDash(data.redemptions.totals.refundedMinor, currencyCode)],
            ]}
          />
          {data.redemptions.totals.redemptions + data.redemptions.totals.refunds === 0 ? (
            <Empty what="gift card redemptions" />
          ) : (
            <ChartCard title="Redemption activity by day">
              <StackedBarChart
                title="Redemption activity by day"
                formatLabel={shortDay}
                series={[
                  { key: 'redemptions', label: 'Redemptions', ...SERIES_COLOURS[0] },
                  { key: 'refunds', label: 'Refunds', ...SERIES_COLOURS[2] },
                ]}
                data={data.redemptions.byDay.map((d) => ({
                  label: d.date,
                  values: { redemptions: d.redemptions, refunds: d.refunds },
                }))}
              />
            </ChartCard>
          )}
        </div>
      )}
    </Loaded>
  );
}

function RevenueTab({ query, currencyCode }: { query: ReportQuery; currencyCode: string }) {
  const revenue = useReport<RevenueReport>('revenue', query);
  const methods = useReport<PaymentMethodReport>('paymentMethods', query);
  const money = (minor: string) => moneyOrDash(minor, currencyCode);
  return (
    <div className="grid gap-4">
      <Loaded report={revenue} name="revenue">
        {(data) =>
          data.items.length === 0 ? (
            <Empty what="payments" />
          ) : (
            <>
              <Stats
                items={[
                  ['Collected', money(data.totals.collectedMinor)],
                  ['Refunded', money(data.totals.refundedMinor)],
                  ['Net', money(data.totals.netMinor)],
                ]}
              />
              <TableCard
                title="Revenue by day (settled payments)"
                head={['Day', 'Payments', 'Collected', 'Refunded', 'Net']}
                rows={data.items.map((d) => [
                  shortDay(d.date),
                  String(d.paymentCount),
                  money(d.collectedMinor),
                  money(d.refundedMinor),
                  money(d.netMinor),
                ])}
              />
            </>
          )
        }
      </Loaded>
      <Loaded report={methods} name="payment methods">
        {(data) =>
          data.items.length === 0 ? null : (
            <TableCard
              title="By payment method"
              head={['Method', 'Payments', 'Collected', 'Fees', 'Net']}
              rows={data.items.map((m) => [
                m.method.toLowerCase().replace(/_/g, ' '),
                String(m.count),
                money(m.collectedMinor),
                money(m.feesMinor),
                money(m.netMinor),
              ])}
            />
          )
        }
      </Loaded>
    </div>
  );
}

// =============================================================================
// Pieces
// =============================================================================

const statusSeries: ChartSeries[] = [
  { key: 'completed', label: 'Completed', ...SERIES_COLOURS[0] },
  { key: 'other', label: 'Upcoming / in progress', ...SERIES_COLOURS[1] },
  { key: 'cancelled', label: 'Cancelled', ...SERIES_COLOURS[5] },
  { key: 'noShow', label: 'No-show', ...SERIES_COLOURS[2] },
];

function Loaded<T>({
  report,
  name,
  children,
}: {
  report: { data: T | undefined; isPending: boolean; error: unknown };
  name: string;
  children: (data: T) => ReactNode;
}) {
  if (report.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading the {name} report…</span>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (report.error || report.data === undefined) {
    const status = report.error instanceof ApiError ? report.error.status : null;
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load the {name} report</AlertTitle>
        <AlertDescription>
          {status === 404
            ? 'One of the filters is not available to you.'
            : status === 403
              ? 'You do not have permission to see this report.'
              : status === 400
                ? 'Check the filters — the range may be too long (at most a year).'
                : 'Please try again.'}
        </AlertDescription>
      </Alert>
    );
  }
  return <>{children(report.data)}</>;
}

function Empty({ what }: { what: string }) {
  return (
    <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
      <p className="text-sm font-medium">No {what} in this range</p>
      <p className="text-muted-foreground mt-1 text-sm">Try a longer range or fewer filters.</p>
    </div>
  );
}

function Stats({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="border-border/60 grid gap-0.5 rounded-lg border p-3">
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function BreakdownTable({
  title,
  label,
  page,
  currencyCode,
}: {
  title: string;
  label: string;
  page: Page<BreakdownRow>;
  currencyCode: string;
}) {
  return (
    <TableCard
      title={title}
      head={[label, 'Bookings', 'Done', 'Cancel', 'No-show', 'Value']}
      rows={page.items.map((r) => [
        r.name ?? 'Unnamed',
        String(r.bookings),
        String(r.completed),
        String(r.cancelled),
        String(r.noShow),
        moneyOrDash(r.bookedValueMinor, currencyCode),
      ])}
      footer={
        page.total > page.items.length ? (
          <p className="text-muted-foreground text-xs">
            Showing {page.items.length} of {page.total}.
          </p>
        ) : null
      }
    />
  );
}

function TableCard({
  title,
  head,
  rows,
  footer,
}: {
  title: string;
  head: string[];
  rows: string[][];
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing to show.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
                <tr>
                  {head.map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={`py-2 pr-3 font-medium ${i > 0 ? 'text-right' : ''}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r} className="border-border/40 border-b last:border-0">
                    {row.map((cell, i) =>
                      i === 0 ? (
                        <th
                          key={i}
                          scope="row"
                          className="max-w-48 truncate py-2 pr-3 text-left font-normal"
                        >
                          {cell}
                        </th>
                      ) : (
                        <td key={i} className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {footer}
      </CardContent>
    </Card>
  );
}

function Pager({ page, onOffset }: { page: Page<unknown>; onOffset: (offset: number) => void }) {
  if (page.total <= page.limit) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-muted-foreground text-xs">
        {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {page.total}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page.offset === 0}
          onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page.offset + page.limit >= page.total}
          onClick={() => onOffset(page.offset + page.limit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

