'use client';

import { Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useBranches } from '@/features/branches';
import { useCan } from '@/features/auth';
import { useEmployees } from '../api/use-employees';
import type { EmployeeQuery, EmployeeStatus } from '@/services/employees.service';

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  INACTIVE: 'Inactive',
  TERMINATED: 'Terminated',
};

/**
 * The staff list: search, filter, paginate.
 *
 * Every filter is a server query parameter, not a client-side `.filter()`. That
 * is the whole reason the list endpoint takes them — a salon with six people
 * would work either way, and a chain with six hundred is exactly the customer
 * worth keeping.
 *
 * Deliberately plain. This is the foundation the next modules build screens on
 * top of, not a finished admin dashboard, and over-designing it now would mean
 * throwing the design away twice.
 */
export function EmployeeList() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<EmployeeStatus | ''>('');
  const [branchId, setBranchId] = useState('');
  const [offset, setOffset] = useState(0);

  const canWrite = useCan('employee:write');
  const branches = useBranches();

  const query: EmployeeQuery = {
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(branchId ? { branchId } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const employees = useEmployees(query);
  const total = employees.data?.total ?? 0;
  const items = employees.data?.items ?? [];

  /** Any filter change returns to the first page — page 4 of a new filter is nonsense. */
  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Staff</h2>
          <p className="text-muted-foreground text-sm">
            {employees.isPending ? 'Loading…' : `${total} ${total === 1 ? 'person' : 'people'}`}
          </p>
        </div>
        {/* Hidden without the permission — the API refuses it regardless. */}
        {canWrite ? <Button size="sm">Add employee</Button> : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="grid gap-1.5">
          <Label htmlFor="employee-search">Search</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="employee-search"
              value={search}
              placeholder="Name or code"
              className="pl-8"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="employee-status">Status</Label>
          <select
            id="employee-status"
            value={status}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as EmployeeStatus | ''))}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3"
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
          <Label htmlFor="employee-branch">Branch</Label>
          <select
            id="employee-branch"
            value={branchId}
            onChange={(e) => changeFilter(() => setBranchId(e.target.value))}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3"
          >
            <option value="">All branches</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {employees.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load staff</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {employees.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading staff…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!employees.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {search || status || branchId ? 'Nobody matches those filters' : 'No staff yet'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {search || status || branchId
              ? 'Try widening the search.'
              : 'Add the people customers can book with.'}
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
                <th scope="col" className="py-2 pr-3 font-medium">Code</th>
                <th scope="col" className="py-2 pr-3 font-medium">Job title</th>
                <th scope="col" className="py-2 pr-3 font-medium">Branches</th>
                <th scope="col" className="py-2 pr-3 font-medium">Login</th>
                <th scope="col" className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((employee) => (
                <tr key={employee.id} className="border-border/40 border-b last:border-0">
                  <td className="py-2 pr-3 font-medium">{employee.displayName}</td>
                  <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">
                    {employee.employeeCode ?? '—'}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3">{employee.jobTitle ?? '—'}</td>
                  <td className="text-muted-foreground py-2 pr-3">
                    {employee.branchIds.length || '—'}
                  </td>
                  <td className="py-2 pr-3">
                    {employee.hasAccount ? (
                      <Badge variant="secondary">
                        {/* Pending until they accept — the account row is not even
                            readable to this company before then. */}
                        {employee.account?.status === 'PENDING_ACCEPTANCE' ? 'Invited' : 'Yes'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge variant={employee.status === 'ACTIVE' ? 'default' : 'secondary'}>
                      {STATUS_LABEL[employee.status]}
                    </Badge>
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
              disabled={offset === 0 || employees.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || employees.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {employees.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
