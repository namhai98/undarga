'use client';

import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useEmployees } from '@/features/employees';
import type { AvailabilityUnavailableReason } from '@/services/availability.service';
import { useAvailability, useBookableServices } from '../api/use-availability';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/** Structural "no slots" reasons get their own copy; a full day is generic. */
const REASON_COPY: Record<AvailabilityUnavailableReason, string> = {
  BRANCH_CLOSED: 'This branch is closed on this date.',
  SERVICE_NOT_OFFERED_AT_BRANCH: 'This service is not available at this branch.',
  NO_ELIGIBLE_EMPLOYEE: 'No eligible staff member is scheduled for this service on this date.',
  NO_ELIGIBLE_RESOURCE: 'No required resource is available for this service on this date.',
  DATE_IN_PAST: 'That date has already passed.',
  BEYOND_BOOKING_WINDOW: 'That date is further ahead than this branch takes bookings.',
};

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** `2026-09-15T09:00:00+08:00` → `09:00`. */
function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * An internal tool for checking what the availability engine returns.
 *
 * Pick a branch, a service and a date; optionally narrow to one employee. The
 * times shown come straight from the server — the browser never computes a
 * slot (docs/ARCHITECTURE-RULES.md rule 3). This is a validation surface, not
 * the customer booking page.
 */
export function AvailabilityExplorer() {
  const canRead = useCan('availability:read');

  const branches = useBranches();
  const services = useBookableServices();
  const employees = useEmployees({ status: 'ACTIVE', limit: 100 });

  const [branchId, setBranchId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [employeeId, setEmployeeId] = useState('');

  const query = useMemo(
    () => ({
      branchId: branchId || undefined,
      serviceId: serviceId || undefined,
      date: date || undefined,
      employeeId: employeeId || undefined,
    }),
    [branchId, serviceId, date, employeeId],
  );

  const availability = useAvailability(query);
  const day = availability.data;

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>
          You do not have the <code>availability:read</code> permission in this company.
        </AlertDescription>
      </Alert>
    );
  }

  const ready = Boolean(branchId && serviceId && date);

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">Availability</h2>
        <p className="text-muted-foreground text-sm">
          What the engine says is bookable. Read-only — nothing here creates an appointment.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="availability-branch">Branch</Label>
          <select
            id="availability-branch"
            className={selectClass}
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">Select…</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="availability-service">Service</Label>
          <select
            id="availability-service"
            className={selectClass}
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          >
            <option value="">Select…</option>
            {(services.data?.items ?? []).map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} · {service.durationMin}m
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="availability-date">Date</Label>
          <input
            id="availability-date"
            type="date"
            className={selectClass}
            value={date}
            min={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="availability-employee">Employee (optional)</Label>
          <select
            id="availability-employee"
            className={selectClass}
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">Any</option>
            {(employees.data?.items ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!ready ? (
        <p className="text-muted-foreground text-sm">Choose a branch, a service and a date.</p>
      ) : availability.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Calculating availability…</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : availability.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not calculate availability</AlertTitle>
          <AlertDescription>Please check the selection and try again.</AlertDescription>
        </Alert>
      ) : day && day.slots.length > 0 ? (
        <div className="grid gap-3">
          <p className="text-muted-foreground text-xs">
            {day.slots.length} slot{day.slots.length === 1 ? '' : 's'} · {day.serviceDurationMin}m
            service · times in {day.timezone}
          </p>
          <ul className="flex flex-wrap gap-2">
            {day.slots.map((slot) => (
              <li key={slot.startAt}>
                <span
                  className="border-border/60 bg-background inline-flex items-center rounded-lg border px-2.5 py-1 text-sm tabular-nums"
                  title={
                    `Books ${hhmm(slot.startAt)}–${hhmm(slot.endAt)}; ` +
                    `occupies ${hhmm(slot.reservedFrom)}–${hhmm(slot.reservedTo)}` +
                    (slot.employeeIds.length
                      ? ` · ${slot.employeeIds.length} staff candidate${slot.employeeIds.length === 1 ? '' : 's'}`
                      : '') +
                    (slot.resourceIds.length
                      ? ` · ${slot.resourceIds.length} resource candidate${slot.resourceIds.length === 1 ? '' : 's'}`
                      : '')
                  }
                >
                  {hhmm(slot.startAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {day?.unavailableReason
              ? REASON_COPY[day.unavailableReason]
              : 'No available times for this date.'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">Try another date or branch.</p>
        </div>
      )}
    </section>
  );
}
