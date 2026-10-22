'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/services/api-error';
import type { CompanyStatus } from '@/services/platform.service';
import {
  useChangeCompanyStatus,
  usePlatformCompany,
  usePlatformCompanyUsers,
  usePlatformSubscription,
} from '../api/use-platform';
import { CompanyUserTable } from './platform-company-users';
import { COMPANY_STATUS_LABEL, statusTone } from './status';

/** The detail screen previews; the users page searches and pages. */
const USER_PREVIEW = 5;

/** Which moves this company can make from where it is. Mirrors the API. */
const TRANSITIONS: Record<CompanyStatus, CompanyStatus[]> = {
  PENDING_SETUP: ['ACTIVE', 'SUSPENDED', 'CANCELED'],
  ACTIVE: ['SUSPENDED', 'CANCELED'],
  SUSPENDED: ['ACTIVE', 'CANCELED'],
  CANCELED: ['ACTIVE'],
};

export function PlatformCompanyDetail({ companyId }: { companyId: string }) {
  const company = usePlatformCompany(companyId);
  const users = usePlatformCompanyUsers(companyId, { limit: USER_PREVIEW });
  const subscription = usePlatformSubscription(companyId);

  if (company.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading the company…</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (company.error || !company.data) {
    return (
      <div className="grid gap-4">
        <BackLink />
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load this company</AlertTitle>
          <AlertDescription>It may have been deleted.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const detail = company.data;

  return (
    <div className="grid gap-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{detail.displayName}</h1>
            <Badge variant={statusTone(detail.status)}>
              {COMPANY_STATUS_LABEL[detail.status]}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {detail.legalName} · <span className="font-mono text-xs">{detail.slug}</span>
            {detail.contactEmail ? ` · ${detail.contactEmail}` : ''}
          </p>
        </div>
      </header>

      <StatusPanel companyId={companyId} status={detail.status} name={detail.displayName} />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Branches" value={detail.counts.branches} />
        <Stat label="Employees" value={detail.counts.employees} />
        <Stat label="Services" value={detail.counts.services} />
        <Stat label="Customers" value={detail.counts.customers} />
        <Stat label="Appointments" value={detail.counts.appointments} />
        <Stat label="Users" value={detail.counts.activeUsers} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Subscription and usage</CardTitle>
            <CardDescription>Plan limits with any negotiated overrides applied.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {subscription.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : subscription.error ? (
              <p role="alert" className="text-destructive text-sm">
                Could not load the subscription.
              </p>
            ) : !subscription.data?.subscription ? (
              <p className="text-muted-foreground text-sm">
                No subscription. This company has never been put on a plan.
              </p>
            ) : (
              <>
                <dl className="grid gap-2 sm:grid-cols-2">
                  <Detail label="Plan" value={subscription.data.subscription.planName} />
                  <Detail
                    label="Status"
                    value={subscription.data.subscription.status.toLowerCase().replace(/_/g, ' ')}
                  />
                  <Detail
                    label="Period ends"
                    value={new Date(
                      subscription.data.subscription.currentPeriodEnd,
                    ).toLocaleDateString()}
                  />
                  <Detail
                    label="Trial ends"
                    value={
                      subscription.data.subscription.trialEndsAt
                        ? new Date(subscription.data.subscription.trialEndsAt).toLocaleDateString()
                        : '—'
                    }
                  />
                </dl>

                {subscription.data.usage.length > 0 ? (
                  <div className="border-border/60 border-t pt-3">
                    <p className="text-muted-foreground mb-2 text-xs">
                      Usage this period ({subscription.data.periodKey})
                    </p>
                    <ul className="grid gap-2">
                      {subscription.data.usage.map((row) => (
                        <li key={row.metric} className="grid gap-1">
                          <div className="flex justify-between gap-3 text-sm">
                            <span>{row.metric.toLowerCase().replace(/_/g, ' ')}</span>
                            <span
                              className={`tabular-nums ${
                                row.overLimit ? 'text-destructive font-medium' : 'text-muted-foreground'
                              }`}
                            >
                              {row.used}
                              {row.limit !== null ? ` / ${row.limit}` : ' / unlimited'}
                            </span>
                          </div>
                          {row.percentUsed !== null ? (
                            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                              <div
                                className={row.overLimit ? 'bg-destructive h-full' : 'bg-primary h-full'}
                                style={{ width: `${Math.min(row.percentUsed, 100)}%` }}
                              />
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No usage recorded this period.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              {/* What changed is the tenant's business; THAT it changed is the
                  operator's. The payloads are deliberately not returned. */}
              What happened and who did it. Never what changed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {detail.recentActivity.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
            ) : (
              <ul className="grid gap-2">
                {detail.recentActivity.map((entry) => (
                  <li key={entry.id} className="grid gap-0.5 text-sm">
                    <span>{entry.action.replace(/[._]/g, ' ')}</span>
                    <span className="text-muted-foreground text-xs">
                      {entry.actorLabel} · {new Date(entry.occurredAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/platform/audit-logs?companyId=${companyId}`}
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-4`}
            >
              Full audit trail
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            The people who can sign in to this company — not its customers.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {users.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : users.error ? (
            <p role="alert" className="text-destructive text-sm">
              Could not load this company’s users.
            </p>
          ) : (users.data?.items.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-sm">Nobody has joined yet.</p>
          ) : (
            <CompanyUserTable users={users.data?.items ?? []} />
          )}
          <Link
            href={`/platform/companies/${companyId}/users`}
            className={`${buttonVariants({ variant: 'outline', size: 'sm' })} w-fit`}
          >
            {users.data && users.data.total > USER_PREVIEW
              ? `All ${users.data.total} users`
              : 'Search users'}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Changing a company's status, behind a reason and a confirmation.
 *
 * Suspending stops every member of its staff working and every customer
 * booking. The reason is required by the API and goes on the hash-chained audit
 * trail; the confirmation states what will happen in words, because that is the
 * step that catches a mis-click on the wrong tenant.
 */
function StatusPanel({
  companyId,
  status,
  name,
}: {
  companyId: string;
  status: CompanyStatus;
  name: string;
}) {
  const [target, setTarget] = useState<CompanyStatus | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useChangeCompanyStatus(companyId);
  const options = TRANSITIONS[status];

  const submit = async () => {
    if (!target) return;
    setError(null);
    try {
      await change.mutateAsync({ status: target, reason: reason.trim() });
      setTarget(null);
      setReason('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the status.');
    }
  };

  const consequence: Record<CompanyStatus, string> = {
    ACTIVE:
      status === 'CANCELED'
        ? 'Their staff can sign in again. This is the only way back from disabled.'
        : 'Their staff can sign in again and customers can book.',
    SUSPENDED: 'Every member of their staff is signed out and no customer can book. Immediately.',
    CANCELED: 'The company is switched off. Only an operator can bring it back.',
    PENDING_SETUP: '',
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          Currently {COMPANY_STATUS_LABEL[status].toLowerCase()}. A reason is required and is
          recorded on the audit trail.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Could not change the status</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {target ? (
          <Alert role="alert">
            <AlertTitle>
              Set {name} to {COMPANY_STATUS_LABEL[target].toLowerCase()}?
            </AlertTitle>
            <AlertDescription className="grid gap-3">
              <p>{consequence[target]}</p>
              <div className="grid gap-1.5">
                <Label htmlFor="status-reason">Reason</Label>
                <Input
                  id="status-reason"
                  value={reason}
                  maxLength={512}
                  placeholder="Non-payment after three reminders"
                  onChange={(e) => setReason(e.target.value)}
                />
                {reason.length > 0 && reason.trim().length < 5 ? (
                  <p role="alert" className="text-destructive text-xs">
                    Say a little more — this is what somebody reads in six months.
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={target === 'ACTIVE' ? 'default' : 'destructive'}
                  disabled={reason.trim().length < 5 || change.isPending}
                  onClick={() => void submit()}
                >
                  {change.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setTarget(null);
                    setReason('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === 'ACTIVE' ? 'default' : 'outline'}
                onClick={() => setTarget(option)}
              >
                {option === 'ACTIVE' ? 'Reactivate' : `Set ${COMPANY_STATUS_LABEL[option].toLowerCase()}`}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Link
      href="/platform/companies"
      className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} -ml-2 w-fit`}
    >
      <ArrowLeft aria-hidden className="size-4" />
      All companies
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border/60 grid gap-1 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value ?? '—'}</dd>
    </div>
  );
}
