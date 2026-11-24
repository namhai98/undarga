'use client';

import { Loader2, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  CompanyStatus,
  PlatformCompanyQuery,
  SubscriptionStatus,
} from '@/services/platform.service';
import { usePlatformCompanies } from '../api/use-platform';
import { COMPANY_STATUS_LABEL, statusTone } from './status';

const PAGE_SIZE = 25;

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
];

/** Every tenant on the platform, with the filters an operator actually uses. */
export function PlatformCompanyList() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<CompanyStatus | ''>('');
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | ''>('');
  const [offset, setOffset] = useState(0);

  const query: PlatformCompanyQuery = {
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(subscriptionStatus ? { subscriptionStatus } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const companies = usePlatformCompanies(query);
  const total = companies.data?.total ?? 0;
  const items = companies.data?.items ?? [];
  const filtered = Boolean(search || status || subscriptionStatus);

  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Companies</h1>
        <p className="text-muted-foreground text-sm">
          {companies.isPending ? 'Loading…' : `${total} on the platform`}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="company-search">Search</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="company-search"
              value={search}
              placeholder="Name, slug or contact email"
              className="pl-8"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="company-status">Status</Label>
          <select
            id="company-status"
            value={status}
            className={selectClass}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as CompanyStatus | ''))}
          >
            <option value="">All</option>
            {Object.entries(COMPANY_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="company-subscription">Subscription</Label>
          <select
            id="company-subscription"
            value={subscriptionStatus}
            className={selectClass}
            onChange={(e) =>
              changeFilter(() => setSubscriptionStatus(e.target.value as SubscriptionStatus | ''))
            }
          >
            <option value="">All</option>
            {SUBSCRIPTION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>

      {companies.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load companies</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {companies.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading companies…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!companies.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? 'Nothing matches those filters' : 'No companies yet'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered
              ? 'Try widening the search.'
              : 'Companies appear here once an operator provisions one.'}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">Company</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 pr-3 font-medium">Plan</th>
                <th scope="col" className="py-2 pr-3 font-medium">Users</th>
                <th scope="col" className="py-2 pr-3 font-medium">Branches</th>
                <th scope="col" className="py-2 font-medium">Since</th>
              </tr>
            </thead>
            <tbody>
              {items.map((company) => (
                <tr key={company.id} className="border-border/40 border-b last:border-0">
                  <td className="py-2 pr-3">
                    <Link
                      href={`/platform/companies/${company.id}`}
                      className="font-medium hover:underline"
                    >
                      {company.displayName}
                    </Link>
                    <span className="text-muted-foreground ml-2 font-mono text-xs">
                      {company.slug}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge variant={statusTone(company.status)}>
                      {COMPANY_STATUS_LABEL[company.status]}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3">
                    {company.planName ?? <span className="text-muted-foreground">None</span>}
                    {company.subscriptionStatus ? (
                      <span className="text-muted-foreground ml-1 text-xs">
                        ({company.subscriptionStatus.toLowerCase().replace(/_/g, ' ')})
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{company.userCount}</td>
                  <td className="py-2 pr-3 tabular-nums">{company.branchCount}</td>
                  <td className="text-muted-foreground py-2 whitespace-nowrap">
                    {new Date(company.createdAt).toLocaleDateString()}
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
              variant="outline"
              size="sm"
              disabled={offset === 0 || companies.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || companies.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {companies.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
