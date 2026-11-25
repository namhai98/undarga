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
import { useCan } from '@/features/auth';
import type { Customer, CustomerQuery, CustomerStatus } from '@/services/customers.service';
import { useCustomers } from '../api/use-customers';
import { CustomerForm } from './customer-form';
import { useT } from '@/lib/i18n';

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<CustomerStatus, string> = {
  ACTIVE: 'Active',
  BLOCKED: 'Blocked',
  ARCHIVED: 'Archived',
};

const SORT_OPTIONS: Array<{ value: NonNullable<CustomerQuery['sortBy']>; label: string }> = [
  { value: 'createdAt', label: 'Newest' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
  { value: 'lastVisitAt', label: 'Last visit' },
  { value: 'totalVisits', label: 'Most visits' },
];

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * The customer list: search, filter, paginate.
 *
 * The search box is one field on purpose. A receptionist has a name, a number
 * or an address in front of them and does not know which column it is — the
 * API matches all four, so splitting this into three inputs would only make
 * somebody choose before they can type.
 *
 * Every filter is a server query parameter, not a client-side `.filter()`.
 */
export function CustomerList() {
  const t = useT();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<CustomerStatus | ''>('');
  const [hasVisited, setHasVisited] = useState<'' | 'true' | 'false'>('');
  const [sortBy, setSortBy] = useState<NonNullable<CustomerQuery['sortBy']>>('createdAt');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);

  const canWrite = useCan('customer:write');

  const query: CustomerQuery = {
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(hasVisited ? { hasVisited } : {}),
    sortBy,
    sortOrder: sortBy === 'firstName' || sortBy === 'lastName' ? 'asc' : 'desc',
    limit: PAGE_SIZE,
    offset,
  };

  const customers = useCustomers(query);
  const total = customers.data?.total ?? 0;
  const items = customers.data?.items ?? [];
  const filtered = Boolean(search || status || hasVisited);

  /** Any filter change returns to the first page — page 4 of a new filter is nonsense. */
  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  if (creating) {
    return (
      <CustomerForm
        customerId={null}
        onDone={() => setCreating(false)}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">{t('Customers')}</h2>
          <p className="text-muted-foreground text-sm">
            {customers.isPending
              ? t('Loading…')
              : `${total} ${total === 1 ? 'customer' : 'customers'}`}
          </p>
        </div>
        {/* Hidden without the permission — the API refuses it regardless. */}
        {canWrite ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            {t('Add customer')}
          </Button>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="customer-search">{t('Search')}</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="customer-search"
              value={search}
              placeholder={t('Name, phone or email')}
              className="pl-8"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="customer-status">{t('Status')}</Label>
          <select
            id="customer-status"
            value={status}
            className={selectClass}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as CustomerStatus | ''))}
          >
            <option value="">{t('All')}</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="customer-visited">{t('Visits')}</Label>
          <select
            id="customer-visited"
            value={hasVisited}
            className={selectClass}
            onChange={(e) =>
              changeFilter(() => setHasVisited(e.target.value as '' | 'true' | 'false'))
            }
          >
            <option value="">{t('Everyone')}</option>
            <option value="true">{t('Has visited')}</option>
            <option value="false">{t('Never visited')}</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="customer-sort">{t('Sort by')}</Label>
          <select
            id="customer-sort"
            value={sortBy}
            className={selectClass}
            onChange={(e) =>
              changeFilter(() => setSortBy(e.target.value as NonNullable<CustomerQuery['sortBy']>))
            }
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {customers.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not load customers')}</AlertTitle>
          <AlertDescription>{t('Please try again.')}</AlertDescription>
        </Alert>
      ) : null}

      {customers.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t('Loading customers…')}</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!customers.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? t('Nobody matches those filters') : t('No customers yet')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered ? t('Try widening the search.') : t('Add the people you book work for.')}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        // Wrapped so a narrow screen scrolls the table rather than the page.
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Name')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Phone')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Email')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Visits')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Last visit')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('Status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((customer) => (
                <CustomerRow key={customer.id} customer={customer} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {t('{from}–{to} of {total}', {
              from: offset + 1,
              to: Math.min(offset + PAGE_SIZE, total),
              total: total,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || customers.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t('Previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || customers.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {customers.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('Next')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CustomerRow({ customer }: { customer: Customer }) {
  const t = useT();
  return (
    <tr className="border-border/40 border-b last:border-0">
      <td className="py-2 pr-3">
        <Link href={`/customers/${customer.id}`} className="font-medium hover:underline">
          {customer.fullName}
        </Link>
        {customer.tags.length > 0 ? (
          <span className="text-muted-foreground ml-2 text-xs">{customer.tags.join(', ')}</span>
        ) : null}
      </td>
      <td className="py-2 pr-3 tabular-nums">{customer.phone ?? '—'}</td>
      <td className="text-muted-foreground py-2 pr-3">{customer.email ?? '—'}</td>
      <td className="py-2 pr-3 tabular-nums">
        {customer.totalVisits}
        {customer.totalNoShows > 0 ? (
          // Worth surfacing: it changes whether reception asks for a deposit.
          <span className="text-muted-foreground ml-1 text-xs">
            {customer.totalNoShows === 1
              ? t('(1 no-show)')
              : t('({count} no-shows)', { count: customer.totalNoShows })}
          </span>
        ) : null}
      </td>
      <td className="text-muted-foreground py-2 pr-3">
        {customer.lastVisitAt ? new Date(customer.lastVisitAt).toLocaleDateString() : t('Never')}
      </td>
      <td className="py-2">
        <Badge variant={customer.status === 'ACTIVE' ? 'default' : 'secondary'}>
          {t(STATUS_LABEL[customer.status])}
        </Badge>
      </td>
    </tr>
  );
}
