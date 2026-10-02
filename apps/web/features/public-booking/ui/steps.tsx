'use client';

import { formatMoney } from '@undarga/shared';
import { Check, Clock, Loader2, MapPin, User } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { currencyFormat } from '@/lib/currency';
import type {
  PublicBranch,
  PublicService,
  PublicSlot,
  PublicUnavailableReason,
} from '@/services/public-booking.service';
import { usePublicAvailability, usePublicEmployees, usePublicServices } from '../api/use-public-booking';
import {
  customerFormSchema,
  formatDay,
  isoDay,
  wallTime,
  type CustomerFormValues,
} from '../model/booking-flow';

const CHOICE =
  'border-border/70 bg-card hover:border-primary/60 hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-3';

export function price(minor: string, currency: string): string {
  return formatMoney({ amountMinor: minor, currencyCode: currency }, currencyFormat(currency));
}

// -----------------------------------------------------------------------------
// Branch
// -----------------------------------------------------------------------------

export function BranchStep(props: { branches: PublicBranch[]; onSelect: (id: string) => void }) {
  if (props.branches.length === 0) {
    return <Empty>This business isn’t taking online bookings at the moment.</Empty>;
  }
  return (
    <ul className="grid gap-3">
      {props.branches.map((b) => (
        <li key={b.id}>
          <button type="button" className={CHOICE} onClick={() => props.onSelect(b.id)}>
            <MapPin aria-hidden className="text-muted-foreground mt-0.5 size-5 shrink-0" />
            <span className="grid gap-0.5">
              <span className="font-medium">{b.name}</span>
              {b.address ? <span className="text-muted-foreground text-sm">{b.address}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export function ServiceStep(props: {
  slug: string;
  branchId: string;
  selectedId: string | null;
  onSelect: (service: PublicService) => void;
}) {
  const services = usePublicServices(props.slug, props.branchId);
  const [category, setCategory] = useState<string>('all');

  const visible = useMemo(
    () =>
      (services.data?.services ?? []).filter(
        (s) => category === 'all' || s.categoryId === category,
      ),
    [services.data, category],
  );

  if (services.isPending) return <ListSkeleton label="Loading services…" />;
  if (services.error) return <LoadError what="services" retry={() => void services.refetch()} />;

  const categories = services.data.categories;
  if (services.data.services.length === 0) {
    return <Empty>No services can be booked online at this location yet.</Empty>;
  }

  return (
    <div className="grid gap-4">
      {categories.length > 1 ? (
        <div role="tablist" aria-label="Service categories" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {[{ id: 'all', name: 'All' }, ...categories].map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              onClick={() => setCategory(c.id)}
              className={
                'min-h-11 shrink-0 rounded-full border px-4 text-sm transition-colors ' +
                (category === c.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/70 hover:bg-muted')
              }
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}

      <ul className="grid gap-3">
        {visible.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={CHOICE}
              aria-pressed={props.selectedId === s.id}
              onClick={() => props.onSelect(s)}
            >
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="font-medium">{s.name}</span>
                {s.description ? (
                  <span className="text-muted-foreground line-clamp-2 text-sm">{s.description}</span>
                ) : null}
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Clock aria-hidden className="size-3.5" />
                  {s.durationMin} min
                </span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {price(s.priceMinor, s.currencyCode)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Employee
// -----------------------------------------------------------------------------

export function EmployeeStep(props: {
  slug: string;
  branchId: string;
  serviceId: string;
  onSelect: (employeeId: string | null) => void;
}) {
  const employees = usePublicEmployees(props.slug, props.branchId, props.serviceId);

  if (employees.isPending) return <ListSkeleton label="Loading staff…" />;
  if (employees.error) return <LoadError what="staff" retry={() => void employees.refetch()} />;

  return (
    <ul className="grid gap-3">
      <li>
        <button type="button" className={CHOICE} onClick={() => props.onSelect(null)}>
          <User aria-hidden className="text-muted-foreground mt-0.5 size-5 shrink-0" />
          <span className="grid gap-0.5">
            <span className="font-medium">Anyone available</span>
            <span className="text-muted-foreground text-sm">Most times to choose from</span>
          </span>
        </button>
      </li>
      {employees.data.map((e) => (
        <li key={e.id}>
          <button type="button" className={CHOICE} onClick={() => props.onSelect(e.id)}>
            <span
              aria-hidden
              className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full text-sm font-medium"
            >
              {e.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="grid gap-0.5">
              <span className="font-medium">{e.name}</span>
              {e.jobTitle ? <span className="text-muted-foreground text-sm">{e.jobTitle}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// Date & time
// -----------------------------------------------------------------------------

const REASON: Record<PublicUnavailableReason, string> = {
  BRANCH_CLOSED: 'Closed on this day.',
  SERVICE_NOT_OFFERED_AT_BRANCH: 'This service isn’t offered on this day.',
  NO_ELIGIBLE_EMPLOYEE: 'Nobody is available for this service on this day.',
  NO_ELIGIBLE_RESOURCE: 'No room is available for this service on this day.',
  DATE_IN_PAST: 'That day has passed.',
  BEYOND_BOOKING_WINDOW: 'Bookings aren’t open that far ahead yet.',
};

export function TimeStep(props: {
  slug: string;
  branchId: string;
  serviceId: string;
  employeeId: string | null;
  date: string;
  notice: string | null;
  locale?: string;
  onDate: (date: string) => void;
  onSelect: (slot: PublicSlot) => void;
}) {
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => isoDay(i)), []);
  const availability = usePublicAvailability(props.slug, {
    branchId: props.branchId,
    serviceId: props.serviceId,
    date: props.date,
    employeeId: props.employeeId,
  });
  const day = availability.data;

  return (
    <div className="grid gap-4">
      {props.notice ? (
        <Alert role="alert">
          <AlertTitle>That time was just taken</AlertTitle>
          <AlertDescription>{props.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-2">
        <div role="radiogroup" aria-label="Date" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {days.map((d) => {
            const active = d === props.date;
            const [weekday = '', ...rest] = formatDay(d, props.locale).split(' ');
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={formatDay(d, props.locale, true)}
                onClick={() => props.onDate(d)}
                className={
                  'grid min-w-14 shrink-0 place-items-center rounded-xl border px-2 py-2 text-sm transition-colors ' +
                  (active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border/70 hover:bg-muted')
                }
              >
                <span className="text-xs opacity-80">{weekday.replace(',', '')}</span>
                <span className="font-medium">{rest.join(' ')}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="pb-date" className="text-muted-foreground text-xs">
            Another date
          </Label>
          <input
            id="pb-date"
            type="date"
            min={isoDay()}
            value={props.date}
            onChange={(e) => e.target.value && props.onDate(e.target.value)}
            className="border-input bg-background h-11 rounded-lg border px-3 text-sm"
          />
        </div>
      </div>

      {availability.isPending ? (
        <div aria-busy="true" className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          <span className="sr-only">Finding available times…</span>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      ) : availability.error ? (
        <LoadError what="available times" retry={() => void availability.refetch()} />
      ) : day && day.slots.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            {availability.isFetching ? <Loader2 aria-hidden className="size-3 animate-spin" /> : null}
            {formatDay(props.date, props.locale, true)} · times shown in {day.timezone}
          </p>
          <div role="radiogroup" aria-label="Available times" className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {day.slots.map((slot) => (
              <button
                key={slot.startAt}
                type="button"
                role="radio"
                aria-checked={false}
                onClick={() => props.onSelect(slot)}
                className="border-border/70 hover:border-primary hover:bg-primary hover:text-primary-foreground min-h-11 rounded-xl border text-sm font-medium tabular-nums transition-colors"
              >
                {wallTime(slot.startAt)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Empty>
          {day?.unavailableReason ? REASON[day.unavailableReason] : 'No times left on this day.'}{' '}
          Try another date.
        </Empty>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Details
// -----------------------------------------------------------------------------

export type FieldErrors = Partial<Record<keyof CustomerFormValues, string>>;

export function DetailsStep(props: {
  submitting: boolean;
  serverErrors: FieldErrors;
  onSubmit: (values: CustomerFormValues) => void;
}) {
  const [values, setValues] = useState<CustomerFormValues>({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    note: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const shown = { ...props.serverErrors, ...errors };

  const set = (field: keyof CustomerFormValues) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const parsed = customerFormSchema.safeParse(values);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof CustomerFormValues;
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    props.onSubmit(parsed.data);
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pb-first" label="First name" error={shown.firstName}>
          <Input id="pb-first" autoComplete="given-name" value={values.firstName} onChange={set('firstName')} aria-invalid={Boolean(shown.firstName)} />
        </Field>
        <Field id="pb-last" label="Last name (optional)" error={shown.lastName}>
          <Input id="pb-last" autoComplete="family-name" value={values.lastName} onChange={set('lastName')} />
        </Field>
      </div>
      <Field id="pb-phone" label="Phone" error={shown.phone}>
        <Input id="pb-phone" type="tel" inputMode="tel" autoComplete="tel" value={values.phone} onChange={set('phone')} aria-invalid={Boolean(shown.phone)} />
      </Field>
      <Field id="pb-email" label="Email (optional)" error={shown.email}>
        <Input id="pb-email" type="email" inputMode="email" autoComplete="email" value={values.email} onChange={set('email')} aria-invalid={Boolean(shown.email)} />
      </Field>
      <Field id="pb-note" label="Anything we should know? (optional)" error={shown.note}>
        <Input id="pb-note" value={values.note} maxLength={1000} onChange={set('note')} />
      </Field>
      <Button type="submit" size="lg" className="h-12 w-full sm:w-auto" disabled={props.submitting}>
        {props.submitting ? <Loader2 aria-hidden className="animate-spin" /> : <Check aria-hidden />}
        Confirm booking
      </Button>
    </form>
  );
}

// -----------------------------------------------------------------------------
// Small pieces
// -----------------------------------------------------------------------------

function Field(props: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.error ? (
        <p role="alert" className="text-destructive text-sm">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="border-border/70 text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
      {children}
    </div>
  );
}

function ListSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

function LoadError({ what, retry }: { what: string; retry: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>Couldn’t load {what}</AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>Check your connection and try again.</span>
        <Button size="sm" variant="outline" className="w-fit" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
