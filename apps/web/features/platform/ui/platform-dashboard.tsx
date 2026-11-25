'use client';

import Link from 'next/link';
import { PlatformMfaCard } from './platform-mfa';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePlatformDashboard } from '../api/use-platform';

/**
 * The whole platform in one screen.
 *
 * One request, so every figure is from the same instant — a dashboard
 * assembled from eight calls shows eight slightly different moments, and the
 * first person to notice is whoever adds up the company statuses and finds they
 * do not match the total.
 */
export function PlatformDashboard() {
  const dashboard = usePlatformDashboard();

  if (dashboard.isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">Loading platform statistics…</span>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (dashboard.error || !dashboard.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load the platform statistics</AlertTitle>
        <AlertDescription>Please try again.</AlertDescription>
      </Alert>
    );
  }

  const data = dashboard.data;

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Platform</h1>
        <p className="text-muted-foreground text-sm">
          Every tenant on this installation. Counts only — no tenant business data.
        </p>
      </header>

      <PlatformMfaCard />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Companies"
          value={data.companies.total}
          hint={`${data.companies.newInWindow} new in ${data.windowDays} days`}
        />
        <Stat label="Active" value={data.companies.active} />
        <Stat
          label="Suspended"
          value={data.companies.suspended}
          tone={data.companies.suspended > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Disabled"
          value={data.companies.disabled}
          // `CANCELED` in the schema; the brief and the business call it
          // disabled, and the operator reading this screen is the business.
          hint="Switched off or closed"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Users"
          value={data.users.total}
          hint={`${data.users.activeMemberships} active memberships`}
        />
        <Stat
          label="Appointments"
          value={data.appointments.total}
          hint={`${data.appointments.inWindow} in ${data.windowDays} days`}
        />
        <Stat
          label="Trials"
          value={data.subscriptions.trial}
          hint={`${data.subscriptions.trialsEndingWithin7Days} ending this week`}
          tone={data.subscriptions.trialsEndingWithin7Days > 0 ? 'warn' : undefined}
        />
        <Stat label="Active subscriptions" value={data.subscriptions.active} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Companies by status</CardTitle>
            <CardDescription>
              Pending setup means provisioned, owner has not accepted their invitation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Breakdown
              rows={[
                ['Active', data.companies.active],
                ['Suspended', data.companies.suspended],
                ['Disabled', data.companies.disabled],
                ['Pending setup', data.companies.pendingSetup],
              ]}
              total={data.companies.total}
            />
            <Link
              href="/platform/companies"
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-4`}
            >
              All companies
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Subscriptions</CardTitle>
            <CardDescription>
              {data.subscriptions.total} of {data.companies.total} companies have one.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Breakdown
              rows={[
                ['Trial', data.subscriptions.trial],
                ['Active', data.subscriptions.active],
                ['Past due', data.subscriptions.pastDue],
                ['Grace', data.subscriptions.grace],
                ['Cancelled', data.subscriptions.cancelled],
                ['Expired', data.subscriptions.expired],
              ]}
              total={data.subscriptions.total}
            />

            {data.subscriptions.topPlans.length > 0 ? (
              <div className="border-border/60 border-t pt-3">
                <p className="text-muted-foreground mb-2 text-xs">Most-used plans</p>
                <ul className="grid gap-1 text-sm">
                  {data.subscriptions.topPlans.map((plan) => (
                    <li key={plan.planKey ?? 'unknown'} className="flex justify-between gap-3">
                      <span>{plan.planName ?? plan.planKey ?? 'Unknown'}</span>
                      <span className="text-muted-foreground tabular-nums">{plan.companies}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'warn';
}) {
  return (
    <Card>
      <CardContent className="grid gap-1 pt-6">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p
          className={`text-2xl font-semibold tabular-nums ${
            tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''
          }`}
        >
          {value.toLocaleString()}
        </p>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Breakdown({ rows, total }: { rows: Array<[string, number]>; total: number }) {
  return (
    <ul className="grid gap-2">
      {rows.map(([label, count]) => (
        <li key={label} className="grid gap-1">
          <div className="flex justify-between gap-3 text-sm">
            <span>{label}</span>
            <span className="text-muted-foreground tabular-nums">{count}</span>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full"
              // Guarded: a zero total would make this NaN and the bar vanish.
              style={{ width: total > 0 ? `${Math.round((count / total) * 100)}%` : '0%' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
