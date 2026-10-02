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
          <h2 className="text-lg font-semibold">Services</h2>
          <p className="text-muted-foreground text-sm">
            {services.isPending ? 'Loading…' : `${total} ${total === 1 ? 'service' : 'services'}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/services/categories"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Categories
          </Link>
          {/* Hidden without the permission — the API refuses it regardless. */}
          {canWrite ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              Add service
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="service-search">Search</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="service-search"
              value={search}
              placeholder="Name or code"
              className="pl-8"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-category">Category</Label>
          <select
            id="service-category"
            value={categoryId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setCategoryId(e.target.value))}
          >
            <option value="">All categories</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.parentId ? '— ' : ''}
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-branch">Branch</Label>
          <select
            id="service-branch"
            value={branchId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setBranchId(e.target.value))}
          >
            <option value="">All branches</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-employee">Employee</Label>
          <select
            id="service-employee"
            value={employeeId}
            className={selectClass}
            onChange={(e) => changeFilter(() => setEmployeeId(e.target.value))}
          >
            <option value="">Anyone</option>
            {(employees.data?.items ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-status">Status</Label>
          <select
            id="service-status"
            value={status}
            className={selectClass}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as CatalogStatus | ''))}
          >
            <option value="">All</option>
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
          <Label htmlFor="service-bookable">Online booking</Label>
          <select
            id="service-bookable"
            value={bookable}
            className={selectClass}
            onChange={(e) =>
              changeFilter(() => setBookable(e.target.value as '' | 'true' | 'false'))
            }
          >
            <option value="">Any</option>
            <option value="true">Listed publicly</option>
            <option value="false">Internal only</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="service-sort">Sort by</Label>
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
          <AlertTitle>Could not load services</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {services.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading services…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!services.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? 'Nothing matches those filters' : 'No services yet'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered ? 'Try widening the search.' : 'Add the things customers can book.'}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        // Wrapped so a narrow screen scrolls the table rather than the page.
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                <th scope="col" className="py-2 pr-3 font-medium">Category</th>
                <th scope="col" className="py-2 pr-3 font-medium">Duration</th>
                <th scope="col" className="py-2 pr-3 font-medium">Price</th>
                <th scope="col" className="py-2 pr-3 font-medium">Offered at</th>
                <th scope="col" className="py-2 pr-3 font-medium">Online</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
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
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || services.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || services.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {services.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
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
        {service.durationMin} min
        {buffers > 0 ? (
          // The window a booking actually occupies, which is what the calendar
          // will block out — not the same number as the duration sold.
          <span className="text-muted-foreground ml-1 text-xs">
            (+{buffers} buffer)
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
          <span className="text-amber-600 dark:text-amber-500">No branches</span>
        ) : (
          `${service.branchCount} ${service.branchCount === 1 ? 'branch' : 'branches'}`
        )}
      </td>
      <td className="py-2 pr-3">
        {service.isOnlineBookable ? (
          <Badge variant="secondary">Listed</Badge>
        ) : (
          <span className="text-muted-foreground">Internal</span>
        )}
      </td>
      <td className="py-2 pr-3">
        <Badge variant={service.status === 'ACTIVE' ? 'default' : 'secondary'}>
          {STATUS_LABEL[service.status]}
        </Badge>
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        <Button variant="ghost" size="sm" onClick={onAssign}>
          {canWrite ? 'Assign' : 'View'}
        </Button>
        {canWrite ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
      </td>
    </tr>
  );
}
