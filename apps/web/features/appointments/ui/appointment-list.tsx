'use client';

import { formatMoney } from '@undarga/shared';
import { Loader2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useEmployees } from '@/features/employees';
import { currencyFormat } from '@/lib/currency';
import type { AppointmentQuery, AppointmentStatus } from '@/services/appointments.service';
import { useAppointments } from '../api/use-appointments';
import { STATUS_LABEL, localDate, localTime, todayIso } from '../model/appointment-display';
import { StatusBadge } from './status-badge';

const PAGE_SIZE = 25;

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * The appointment book: filter, page, open.
 *
 * Every filter is a server query parameter. The default window is the coming
 * week, which is what a front desk looks at; widen it with the dates.
 */
export function AppointmentList() {
  const canBook = useCan('appointment:write');
  const branches = useBranches();
  const employees = useEmployees({ status: 'ACTIVE', limit: 100 });

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AppointmentStatus | ''>('');
  const [branchId, setBranchId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso(7));
  const [offset, setOffset] = useState(0);

  const query: AppointmentQuery = {
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(branchId ? { branchId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const appointments = useAppointments(query);
  const items = appointments.data?.items ?? [];
  const total = appointments.data?.total ?? 0;

  /** Any filter change returns to the first page. */
  const change = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Appointments</h2>
          <p className="text-muted-foreground text-sm">
            {appointments.isPending ? 'Loading…' : `${total} in this view`}
          </p>
        </div>
        {/* Hidden without the permission — the API refuses it regardless. */}
        {canBook ? (
          <Link href="/appointments/new" className={buttonVariants({ size: 'sm' })}>
            <Plus aria-hidden className="size-4" />
            New appointment
          </Link>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="grid gap-1.5 sm:col-span-3 lg:col-span-2">
          <Label htmlFor="appt-search">Search</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="appt-search"
              value={search}
              placeholder="Appointment number"
              className="pl-8"
              onChange={(e) => change(() => setSearch(e.target.value))}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="appt-from">From</Label>
          <input
            id="appt-from"
            type="date"
            className={selectClass}
            value={from}
            onChange={(e) => change(() => setFrom(e.target.value))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="appt-to">To</Label>
          <input
            id="appt-to"
            type="date"
            className={selectClass}
            value={to}
            min={from || undefined}
            onChange={(e) => change(() => setTo(e.target.value))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="appt-status">Status</Label>
          <select
            id="appt-status"
            className={selectClass}
            value={status}
            onChange={(e) => change(() => setStatus(e.target.value as AppointmentStatus | ''))}
          >
            <option value="">All</option>
            {(Object.keys(STATUS_LABEL) as AppointmentStatus[])
              .filter((s) => s !== 'HOLD' && s !== 'EXPIRED')
              .map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="appt-branch">Branch</Label>
          <select
            id="appt-branch"
            className={selectClass}
            value={branchId}
            onChange={(e) => change(() => setBranchId(e.target.value))}
          >
            <option value="">All branches</option>
            {(branches.data?.items ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5 sm:col-span-3 lg:col-span-2">
          <Label htmlFor="appt-employee">Employee</Label>
          <select
            id="appt-employee"
            className={selectClass}
            value={employeeId}
            onChange={(e) => change(() => setEmployeeId(e.target.value))}
          >
            <option value="">Anyone</option>
            {(employees.data?.items ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {appointments.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load appointments</AlertTitle>
          <AlertDescription>Please check the filters and try again.</AlertDescription>
        </Alert>
      ) : null}

      {appointments.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading appointments…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!appointments.isPending && !appointments.error && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No appointments in this view</p>
          <p className="text-muted-foreground mt-1 text-sm">Try widening the dates or filters.</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">When</th>
                <th scope="col" className="py-2 pr-3 font-medium">Customer</th>
                <th scope="col" className="py-2 pr-3 font-medium">Service</th>
                <th scope="col" className="py-2 pr-3 font-medium">With</th>
                <th scope="col" className="py-2 pr-3 font-medium">Branch</th>
                <th scope="col" className="py-2 pr-3 font-medium">Total</th>
                <th scope="col" className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="border-border/40 border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums">
                    <Link href={`/appointments/${a.id}`} className="font-medium hover:underline">
                      {localDate(a.startsAt)} {localTime(a.startsAt)}
                    </Link>
                    <div className="text-muted-foreground font-mono text-xs">
                      {a.appointmentNumber}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{a.customer.name}</td>
                  <td className="py-2 pr-3">{a.service?.name ?? '—'}</td>
                  <td className="text-muted-foreground py-2 pr-3">
                    {[a.employee?.name, ...a.resources.map((r) => r.name)]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3">{a.branch.name}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {formatMoney(
                      { amountMinor: a.totalMinor, currencyCode: a.currencyCode },
                      currencyFormat(a.currencyCode),
                    )}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={a.status} />
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
              disabled={offset === 0 || appointments.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || appointments.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {appointments.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
