'use client';

import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useEmployees } from '@/features/employees';
import type {
  AvailabilityDay,
  AvailabilityUnavailableReason,
} from '@/services/availability.service';
import { useAvailability, useBookableServices } from '../api/use-availability';
import { useT, type Translate } from '@/lib/i18n';

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
  const t = useT();
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
        <AlertTitle>{t('Not available')}</AlertTitle>
        <AlertDescription>
          {t('You do not have the')} <code>availability:read</code>{' '}
          {t('permission in this company.')}
        </AlertDescription>
      </Alert>
    );
  }

  const ready = Boolean(branchId && serviceId && date);

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">{t('Availability')}</h2>
        <p className="text-muted-foreground text-sm">
          {t('What the engine says is bookable. Read-only — nothing here creates an appointment.')}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="availability-branch">{t('Branch')}</Label>
          <select
            id="availability-branch"
            className={selectClass}
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">{t('Select…')}</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="availability-service">{t('Service')}</Label>
          <select
            id="availability-service"
            className={selectClass}
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          >
            <option value="">{t('Select…')}</option>
            {(services.data?.items ?? []).map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} · {service.durationMin}m
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="availability-date">{t('Date')}</Label>
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
          <Label htmlFor="availability-employee">{t('Employee (optional)')}</Label>
          <select
            id="availability-employee"
            className={selectClass}
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">{t('Any')}</option>
            {(employees.data?.items ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!ready ? (
        <p className="text-muted-foreground text-sm">
          {t('Choose a branch, a service and a date.')}
        </p>
      ) : availability.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t('Calculating availability…')}</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : availability.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not calculate availability')}</AlertTitle>
          <AlertDescription>{t('Please check the selection and try again.')}</AlertDescription>
        </Alert>
      ) : day && day.slots.length > 0 ? (
        <div className="grid gap-3">
          <p className="text-muted-foreground text-xs">
            {t(
              day.slots.length === 1
                ? '1 slot · {duration}m service · times in {timezone}'
                : '{count} slots · {duration}m service · times in {timezone}',
              { count: day.slots.length, duration: day.serviceDurationMin, timezone: day.timezone },
            )}
          </p>
          <ul className="flex flex-wrap gap-2">
            {day.slots.map((slot) => (
              <li key={slot.startAt}>
                <span
                  className="border-border/60 bg-background inline-flex items-center rounded-lg border px-2.5 py-1 text-sm tabular-nums"
                  title={
                    t('Books {hhmm}–{hhmm2}; ', {
                      hhmm: hhmm(slot.startAt),
                      hhmm2: hhmm(slot.endAt),
                    }) +
                    t('occupies {hhmm}–{hhmm2}', {
                      hhmm: hhmm(slot.reservedFrom),
                      hhmm2: hhmm(slot.reservedTo),
                    }) +
                    (slot.employeeIds.length
                      ? slot.employeeIds.length === 1
                        ? t(' · 1 staff candidate')
                        : t(' · {count} staff candidates', { count: slot.employeeIds.length })
                      : '') +
                    (slot.resourceIds.length
                      ? slot.resourceIds.length === 1
                        ? t(' · 1 resource candidate')
                        : t(' · {count} resource candidates', { count: slot.resourceIds.length })
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
              : t('No available times for this date.')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">{t('Try another date or branch.')}</p>
        </div>
      )}

      {ready && day ? (
        <DayDetails
          day={day}
          nameOf={(id) =>
            employees.data?.items.find((e) => e.id === id)?.displayName ?? 'Staff member'
          }
        />
      ) : null}
    </section>
  );
}

/** The rules behind the day, and who is away — so an empty day explains itself. */
function DayDetails({ day, nameOf }: { day: AvailabilityDay; nameOf: (id: string) => string }) {
  const t = useT();
  const away = day.employeesUnavailable ?? [];
  if (!day.rules && away.length === 0) return null;
  return (
    <div className="grid gap-2 text-sm" aria-label={t('Booking rules and absences')}>
      {day.rules ? (
        <p className="text-muted-foreground text-xs">
          {t('Rules: at least {notice} notice · up to {days} days ahead', {
            notice: describeNotice(day.rules.minimumNoticeMinutes, t),
            days: day.rules.maximumAdvanceDays,
          })}
          {day.rules.maxConcurrentBookings
            ? t(' · at most {max} at once', { max: day.rules.maxConcurrentBookings })
            : ''}
        </p>
      ) : null}
      {away.length ? (
        <div className="grid gap-1">
          <p className="font-medium">{t('Unavailable staff')}</p>
          <ul className="text-muted-foreground grid gap-0.5 text-xs">
            {away.map((a, i) => (
              <li key={`${a.employeeId}-${i}`} className="tabular-nums">
                {nameOf(a.employeeId)}: {a.from.slice(0, 10)} {hhmm(a.from)} → {a.to.slice(0, 10)}{' '}
                {hhmm(a.to)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** 90 → "90 minutes", 120 → "2 hours", 1440 → "1 day". */
function describeNotice(minutes: number, t: Translate): string {
  const unit = (n: number, one: string, many: string) => (n === 1 ? t(one) : t(many, { count: n }));
  if (minutes > 0 && minutes % 1440 === 0) return unit(minutes / 1440, '1 day', '{count} days');
  if (minutes > 0 && minutes % 60 === 0) return unit(minutes / 60, '1 hour', '{count} hours');
  return unit(minutes, '1 minute', '{count} minutes');
}
