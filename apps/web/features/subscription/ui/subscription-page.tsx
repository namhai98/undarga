'use client';

import { Check, Loader2, Minus } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import type { Plan, SubscriptionOverview } from '@/services/subscription.service';
import { useInvoices, useSubscription, useSubscriptionAction } from '../api/use-subscription';
import {
  FEATURE_LABEL,
  INVOICE_STATUS_LABEL,
  LIMIT_LABEL,
  STATUS_LABEL,
  day,
  limitText,
  money,
  price,
  statusVariant,
  subscriptionErrorMessage,
} from '../model/subscription-display';

const PAGE_SIZE = 10;

/**
 * Subscription: the current plan, what is used of it, the plans on offer, and
 * the invoices.
 *
 * Viewing needs `settings:billing:read`; changing anything needs
 * `settings:billing:write` (the owner, by default). Prices and limits come
 * from the server's plan catalog — nothing here knows what a plan contains.
 * No payment is taken: an invoice is issued and settled outside the app.
 */
export function SubscriptionPage() {
  const canRead = useCan('settings:billing:read');
  const canWrite = useCan('settings:billing:write');
  const overview = useSubscription();

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>You do not have permission to see the subscription.</AlertDescription>
      </Alert>
    );
  }
  if (overview.isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">Loading the subscription…</span>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }
  if (overview.error || !overview.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load the subscription</AlertTitle>
        <AlertDescription>Please try again.</AlertDescription>
      </Alert>
    );
  }

  const data = overview.data;
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Subscription</h1>
        <p className="text-muted-foreground text-sm">
          Your plan, what it allows, and your invoices. Payments are arranged with us directly for
          now — nothing is charged from here.
        </p>
      </header>
      <CurrentPlan data={data} canWrite={canWrite} />
      <Usage data={data} />
      <PlanComparison data={data} canWrite={canWrite} />
      <BillingHistory />
    </div>
  );
}

// -----------------------------------------------------------------------------

function CurrentPlan({ data, canWrite }: { data: SubscriptionOverview; canWrite: boolean }) {
  const action = useSubscriptionAction();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sub = data.subscription;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setCancelling(false);
    } catch (caught) {
      setError(subscriptionErrorMessage(caught, 'Could not update the subscription.'));
    }
  };

  if (!sub) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No plan yet</CardTitle>
          <CardDescription>
            {data.trialAvailable
              ? 'This company has no subscription. Start a free trial of a plan below.'
              : 'This company has no subscription.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {sub.plan.name}
            <Badge variant={statusVariant(sub.status)}>{STATUS_LABEL[sub.status]}</Badge>
          </CardTitle>
          <CardDescription>
            {price(sub.plan.priceMinor, sub.plan.currencyCode, sub.plan.interval)}
          </CardDescription>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {sub.status === 'CANCELLED' || sub.status === 'EXPIRED' ? (
              <Button
                size="sm"
                disabled={action.isPending}
                onClick={() => void run(() => action.mutateAsync({ kind: 'reactivate' }))}
              >
                {action.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {sub.status === 'EXPIRED' ? 'Renew' : 'Keep my subscription'}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setCancelling(true)}>
                Cancel subscription
              </Button>
            )}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        <dl className="grid gap-3 sm:grid-cols-3">
          {sub.trial ? (
            <Fact
              label="Trial"
              value={`${sub.trial.daysLeft} day${sub.trial.daysLeft === 1 ? '' : 's'} left · ends ${day(sub.trial.endsAt)}`}
            />
          ) : null}
          <Fact
            label="Billing period"
            value={`${day(sub.currentPeriod.start)} – ${day(sub.currentPeriod.end)}`}
          />
          {data.openInvoice ? (
            <Fact
              label="Invoice due"
              value={`${money(data.openInvoice.totalMinor, data.openInvoice.currencyCode)} by ${day(data.openInvoice.dueAt)}`}
            />
          ) : null}
        </dl>

        {sub.status === 'CANCELLED' ? (
          <Alert role="status">
            <AlertDescription>
              Cancelled. Everything keeps working until {day(sub.currentPeriod.end)}; after that the
              company becomes read-only. No data is deleted.
            </AlertDescription>
          </Alert>
        ) : null}
        {sub.status === 'PAST_DUE' ? (
          <Alert role="status">
            <AlertDescription>
              Payment is overdue. Everything keeps working until {day(sub.graceEndsAt)}; settle the
              open invoice to avoid becoming read-only.
            </AlertDescription>
          </Alert>
        ) : null}
        {sub.readOnly ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>The subscription has expired</AlertTitle>
            <AlertDescription>
              The company is read-only: everything can be viewed, nothing can be changed. All data
              is kept. Renew or choose a plan to continue.
            </AlertDescription>
          </Alert>
        ) : null}

        {cancelling ? (
          <section
            aria-label="Cancel subscription"
            className="border-border/60 grid gap-3 rounded-lg border p-4"
          >
            <p className="text-sm">
              The subscription ends on {day(sub.trial?.endsAt ?? sub.currentPeriod.end)}. Until then
              nothing changes; afterwards the company is read-only until it renews. No data is
              deleted.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="cancel-reason">Reason (optional)</Label>
              <Input
                id="cancel-reason"
                value={reason}
                maxLength={512}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={action.isPending}
                onClick={() =>
                  void run(() =>
                    action.mutateAsync({
                      kind: 'cancel',
                      ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}),
                    }),
                  )
                }
              >
                Cancel subscription
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCancelling(false)}>
                Keep it
              </Button>
            </div>
          </section>
        ) : null}

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Usage({ data }: { data: SubscriptionOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>Against your plan’s limits. Updated within a minute.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Usage">
          {data.usage.map((u) => {
            const ratio =
              u.limit === null || u.limit === 0
                ? u.limit === 0 && u.used > 0
                  ? 1
                  : 0
                : u.used / u.limit;
            const full = u.limit !== null && u.used >= u.limit;
            return (
              <li key={u.key} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{LIMIT_LABEL[u.key] ?? u.label}</span>
                  <span
                    className={`tabular-nums ${full ? 'text-destructive font-medium' : 'text-muted-foreground'}`}
                  >
                    {u.used.toLocaleString()} / {limitText(u.limit)}
                  </span>
                </div>
                <div
                  className="bg-muted h-1.5 overflow-hidden rounded-full"
                  role="progressbar"
                  aria-label={LIMIT_LABEL[u.key] ?? u.label}
                  aria-valuemin={0}
                  aria-valuemax={u.limit ?? undefined}
                  aria-valuenow={u.used}
                >
                  <div
                    className={`h-full rounded-full ${full ? 'bg-destructive' : ratio > 0.8 ? 'bg-amber-500' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function PlanComparison({ data, canWrite }: { data: SubscriptionOverview; canWrite: boolean }) {
  const action = useSubscriptionAction();
  const [choosing, setChoosing] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sub = data.subscription;
  const currentPrice = BigInt(sub?.plan.priceMinor ?? '0');

  const verb = (plan: Plan): string => {
    if (!sub)
      return plan.trialDays > 0 ? `Start ${plan.trialDays}-day trial` : `Choose ${plan.name}`;
    if (plan.current && sub.status === 'TRIAL') return `Subscribe to ${plan.name}`;
    if (plan.current && sub.status === 'EXPIRED') return `Renew ${plan.name}`;
    return BigInt(plan.priceMinor) > currentPrice
      ? `Upgrade to ${plan.name}`
      : `Downgrade to ${plan.name}`;
  };
  const isCurrent = (plan: Plan) =>
    plan.current && sub !== null && sub.status !== 'TRIAL' && sub.status !== 'EXPIRED';

  const confirm = async (plan: Plan) => {
    setError(null);
    try {
      if (!sub && plan.trialDays > 0)
        await action.mutateAsync({ kind: 'startTrial', planKey: plan.key });
      else await action.mutateAsync({ kind: 'changePlan', planKey: plan.key });
      setChoosing(null);
    } catch (caught) {
      setError(subscriptionErrorMessage(caught, 'Could not change the plan.'));
    }
  };

  const features = Object.keys(FEATURE_LABEL) as Array<keyof typeof FEATURE_LABEL>;
  const limits = Object.keys(LIMIT_LABEL) as Array<keyof typeof LIMIT_LABEL>;

  return (
    <section className="grid gap-3" aria-labelledby="plans-title">
      <h2 id="plans-title" className="text-lg font-semibold">
        Plans
      </h2>

      {choosing ? (
        <Alert role="alertdialog" aria-label={`Confirm ${choosing.name}`}>
          <AlertTitle>{verb(choosing)}?</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              {!sub && choosing.trialDays > 0
                ? `A free ${choosing.trialDays}-day trial of ${choosing.name}. No invoice until you subscribe.`
                : choosing.priceMinor === '0'
                  ? `${choosing.name} is free. It takes effect now.`
                  : `${price(choosing.priceMinor, choosing.currencyCode, choosing.interval)}, starting today. An invoice is issued now; any unpaid invoice for your current plan is cancelled.`}
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={action.isPending} onClick={() => void confirm(choosing)}>
                {action.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Confirm
              </Button>
              <Button size="sm" variant="outline" onClick={() => setChoosing(null)}>
                Back
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Plan not changed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((plan) => (
          <Card
            key={plan.key}
            className={plan.current ? 'ring-primary ring-2' : ''}
            aria-label={`${plan.name} plan`}
          >
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                {plan.name}
                {plan.current ? <Badge>Current</Badge> : null}
              </CardTitle>
              <CardDescription>{plan.description}</CardDescription>
              <p className="text-lg font-semibold tabular-nums">
                {price(plan.priceMinor, plan.currencyCode, plan.interval)}
              </p>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ul className="grid gap-1 text-sm">
                {features.map((f) => (
                  <li
                    key={f}
                    className={`flex items-center gap-2 ${plan.features[f] ? '' : 'text-muted-foreground'}`}
                  >
                    {plan.features[f] ? (
                      <Check aria-label="Included" className="text-primary size-4" />
                    ) : (
                      <Minus aria-label="Not included" className="size-4" />
                    )}
                    {FEATURE_LABEL[f]}
                  </li>
                ))}
              </ul>
              <dl className="grid gap-0.5 text-xs">
                {limits.map((l) => (
                  <div key={l} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{LIMIT_LABEL[l]}</dt>
                    <dd className="tabular-nums">{limitText(plan.limits[l])}</dd>
                  </div>
                ))}
              </dl>
              {canWrite ? (
                isCurrent(plan) ? (
                  <Button size="sm" variant="outline" disabled>
                    Current plan
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={plan.current ? 'default' : 'outline'}
                    disabled={
                      sub?.status === 'CANCELLED' ||
                      (!sub && !data.trialAvailable && plan.trialDays > 0)
                    }
                    onClick={() => {
                      setError(null);
                      setChoosing(plan);
                    }}
                  >
                    {verb(plan)}
                  </Button>
                )
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
      {!canWrite ? (
        <p className="text-muted-foreground text-xs">Only the account owner can change the plan.</p>
      ) : sub?.status === 'CANCELLED' ? (
        <p className="text-muted-foreground text-xs">
          Keep your subscription first to change plans.
        </p>
      ) : null}
    </section>
  );
}

function BillingHistory() {
  const [offset, setOffset] = useState(0);
  const invoices = useInvoices({ limit: PAGE_SIZE, offset });
  const items = invoices.data?.items ?? [];
  const total = invoices.data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing history</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {invoices.isPending ? <Skeleton className="h-24 w-full" /> : null}
        {invoices.error ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load invoices.
          </p>
        ) : null}
        {!invoices.isPending && !invoices.error && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No invoices yet.</p>
        ) : null}
        {items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Invoice
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Plan
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Currency
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Due
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => (
                  <tr key={invoice.id} className="border-border/40 border-b last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-mono text-xs font-normal">
                      {invoice.number}
                    </th>
                    <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                      {day(invoice.issuedAt ?? invoice.createdAt)}
                    </td>
                    <td className="py-2 pr-3">{invoice.plan.name ?? '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {money(invoice.totalMinor, invoice.currencyCode)}
                    </td>
                    <td className="py-2 pr-3">{invoice.currencyCode}</td>
                    <td className="py-2 pr-3">
                      <Badge
                        variant={
                          invoice.status === 'PAID'
                            ? 'default'
                            : invoice.status === 'OPEN'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {INVOICE_STATUS_LABEL[invoice.status]}
                      </Badge>
                    </td>
                    <td className="text-muted-foreground py-2 whitespace-nowrap">
                      {invoice.status === 'PAID'
                        ? `Paid ${day(invoice.paidAt)}`
                        : day(invoice.dueAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
