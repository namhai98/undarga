'use client';

import { formatMoney } from '@undarga/shared';
import { Loader2, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useEmployees } from '@/features/employees';
import { currencyFormat } from '@/lib/currency';
import type { CatalogStatus, ServiceQuery, ServiceSummary } from '@/services/catalog.service';
import { useServiceCategories, useServices } from '../api/use-catalog';
import { ServiceForm } from './service-form';
import { ServiceAssignments } from './service-assignments';
import { useT } from '@/lib/i18n';

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<CatalogStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

const SORT_OPTIONS: Array<{ value: NonNullable<ServiceQuery['sortBy']>; label: string }> = [
  { value: 'sortOrder', label: 'Custom order' },
  { value: 'name', label: 'Name' },
  { value: 'priceMinor', label: 'Price' },
  { value: 'durationMin', label: 'Duration' },
  { value: 'createdAt', label: 'Newest' },
];

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * The price list: search, filter, sort, paginate.
 *
 * Every filter is a server query parameter, not a client-side `.filter()`. A
 * salon with twelve services would work either way; a chain with six hundred is
 * the customer worth keeping, and the list endpoint takes the parameters
 * precisely so the filtering happens in SQL against the indexes.
 *
 * Deliberately plain, matching the staff screen. This is a foundation, not a
 * finished admin dashboard.
 */
export function ServiceList() {
  const t = useT();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [status, setStatus] = useState<CatalogStatus | ''>('');
  const [bookable, setBookable] = useState<'' | 'true' | 'false'>('');
  const [sortBy, setSortBy] = useState<NonNullable<ServiceQuery['sortBy']>>('sortOrder');
  const [offset, setOffset] = useState(0);

  /** Which service the editor is open on: an id, `'new'`, or nothing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  const canWrite = useCan('service:write');
  const categories = useServiceCategories();
  const branches = useBranches();
  const employees = useEmployees({ limit: 100 });

  const query: ServiceQuery = {
    ...(search ? { search } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(status ? { status } : {}),
    ...(bookable ? { isOnlineBookable: bookable } : {}),
    sortBy,
    limit: PAGE_SIZE,
    offset,
  };

  const services = useServices(query);
  const total = services.data?.total ?? 0;
  const items = services.data?.items ?? [];
  const filtered = Boolean(search || categoryId || branchId || employeeId || status || bookable);

  /** Any filter change returns to the first page — page 4 of a new filter is nonsense. */
  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  if (editing) {
    return (
      <ServiceForm
        serviceId={editing === 'new' ? null : editing}
        onDone={() => setEditing(null)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (assigning) {
    return <ServiceAssignments serviceId={assigning} onBack={() => setAssigning(null)} />;
  }

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">{t('Services')}</h2>
          <p className="text-muted-foreground text-sm">
            {services.isPending
              ? t('Loading…')
              : `${total} ${total === 1 ? 'service' : 'services'}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/services/categories"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('Categories')}
          </Link>
          {/* Hidden without the permission — the API refuses it regardless. */}
          {canWrite ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              {t('Add service')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="service-search">{t('Search')}</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="service-search"
              value={search}
              placeholder={t('Name or code')}
              className="pl-8"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-category">{t('Category')}</Label>
          <select
            id="service-category"
            value={categoryId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setCategoryId(e.target.value))}
          >
            <option value="">{t('All categories')}</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.parentId ? '— ' : ''}
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-branch">{t('Branch')}</Label>
          <select
            id="service-branch"
            value={branchId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setBranchId(e.target.value))}
          >
            <option value="">{t('All branches')}</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-employee">{t('Employee')}</Label>
          <select
            id="service-employee"
            value={employeeId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setEmployeeId(e.target.value))}
          >
            <option value="">{t('Anyone')}</option>
            {(employees.data?.items ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-status">{t('Status')}</Label>
          <select
            id="service-status"
            value={status}
            className={selectClass}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as CatalogStatus | ''))}
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
          {/* Bookable at all is `status`; this is only whether the PUBLIC site
              shows it. An internal-only service is active and not listed. */}
          <Label htmlFor="service-bookable">{t('Online booking')}</Label>
          <select
            id="service-bookable"
            value={bookable}
            className={selectClass}
            onChange={(e) =>
              changeFilter(() => setBookable(e.target.value as '' | 'true' | 'false'))
            }
          >
            <option value="">{t('Any')}</option>
            <option value="true">{t('Listed publicly')}</option>
            <option value="false">{t('Internal only')}</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-sort">{t('Sort by')}</Label>
          <select
            id="service-sort"
            value={sortBy}
            className={selectClass}
            onChange={(e) =>
              changeFilter(() => setSortBy(e.target.value as NonNullable<ServiceQuery['sortBy']>))
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

      {services.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not load services')}</AlertTitle>
          <AlertDescription>{t('Please try again.')}</AlertDescription>
        </Alert>
      ) : null}

      {services.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t('Loading services…')}</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!services.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? t('Nothing matches those filters') : t('No services yet')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered ? t('Try widening the search.') : t('Add the things customers can book.')}
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
                  {t('Category')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Duration')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Price')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Offered at')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Online')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Status')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((service) => (
                <ServiceRow
                  key={service.id}
                  service={service}
                  canWrite={canWrite}
                  onEdit={() => setEditing(service.id)}
                  onAssign={() => setAssigning(service.id)}
                />
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
              disabled={offset === 0 || services.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t('Previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || services.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {services.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('Next')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ServiceRow({
  service,
  canWrite,
  onEdit,
  onAssign,
}: {
  service: ServiceSummary;
  canWrite: boolean;
  onEdit: () => void;
  onAssign: () => void;
}) {
  const t = useT();
  const buffers = service.bufferBeforeMin + service.bufferAfterMin;

  return (
    <tr className="border-border/40 border-b last:border-0">
      <td className="py-2 pr-3">
        <span className="font-medium">{service.name}</span>
        {service.code ? (
          <span className="text-muted-foreground ml-2 font-mono text-xs">{service.code}</span>
        ) : null}
      </td>
      <td className="text-muted-foreground py-2 pr-3">{service.categoryName ?? '—'}</td>
      <td className="py-2 pr-3">
        {t('{minutes} min', { minutes: service.durationMin })}
        {buffers > 0 ? (
          // The window a booking actually occupies, which is what the calendar
          // will block out — not the same number as the duration sold.
          <span className="text-muted-foreground ml-1 text-xs">
            {t('(+{buffers} buffer)', { buffers })}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3 tabular-nums">
        {formatMoney(
          { amountMinor: service.priceMinor, currencyCode: service.currencyCode },
          currencyFormat(service.currencyCode),
        )}
      </td>
      <td className="text-muted-foreground py-2 pr-3">
        {service.branchCount === 0 ? (
          // Not pedantry: a service assigned to no branch cannot be booked
          // anywhere, and nothing else on this screen would say so.
          <span className="text-amber-600 dark:text-amber-500">{t('No branches')}</span>
        ) : (
          `${service.branchCount} ${service.branchCount === 1 ? 'branch' : 'branches'}`
        )}
      </td>
      <td className="py-2 pr-3">
        {service.isOnlineBookable ? (
          <Badge variant="secondary">{t('Listed')}</Badge>
        ) : (
          <span className="text-muted-foreground">{t('Internal')}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        <Badge variant={service.status === 'ACTIVE' ? 'default' : 'secondary'}>
          {t(STATUS_LABEL[service.status])}
        </Badge>
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        <Button variant="ghost" size="sm" onClick={onAssign}>
          {canWrite ? t('Assign') : t('View')}
        </Button>
        {canWrite ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            {t('Edit')}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}
