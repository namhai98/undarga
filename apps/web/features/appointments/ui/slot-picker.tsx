'use client';

import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAvailability } from '@/features/availability';
import type {
  AvailabilitySlot,
  AvailabilityUnavailableReason,
} from '@/services/availability.service';
import { localTime } from '../model/appointment-display';

const REASON_COPY: Record<AvailabilityUnavailableReason, string> = {
  BRANCH_CLOSED: 'This branch is closed on this date.',
  SERVICE_NOT_OFFERED_AT_BRANCH: 'This service is not available at this branch.',
  NO_ELIGIBLE_EMPLOYEE: 'Nobody who provides this service is scheduled on this date.',
  NO_ELIGIBLE_RESOURCE: 'No required room or equipment is available on this date.',
  DATE_IN_PAST: 'That date has already passed.',
  BEYOND_BOOKING_WINDOW: 'That date is further ahead than this branch takes bookings.',
};

/**
 * The bookable times for a branch, service and date — straight from the
 * availability engine. The browser never computes or filters a slot; picking
 * one hands back the server's own `startAt` string, which the booking endpoint
 * re-validates.
 */
export function SlotPicker(props: {
  branchId: string;
  serviceId: string;
  date: string;
  /** Restrict to one employee (the server re-checks regardless). */
  employeeId?: string;
  /** Rescheduling: the appointment being moved does not block itself. */
  excludeAppointmentId?: string;
  selected: string | null;
  onSelect: (slot: AvailabilitySlot) => void;
}) {
  const availability = useAvailability({
    branchId: props.branchId || undefined,
    serviceId: props.serviceId || undefined,
    date: props.date || undefined,
    employeeId: props.employeeId || undefined,
    excludeAppointmentId: props.excludeAppointmentId,
  });

  if (!props.branchId || !props.serviceId || !props.date) {
    return <p className="text-muted-foreground text-sm">Choose a branch, a service and a date.</p>;
  }

  if (availability.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">Calculating availability…</span>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (availability.error) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load available times</AlertTitle>
        <AlertDescription>Please try again.</AlertDescription>
      </Alert>
    );
  }

  const day = availability.data;
  if (!day || day.slots.length === 0) {
    return (
      <div className="border-border/60 rounded-lg border border-dashed p-6 text-center text-sm">
        {day?.unavailableReason
          ? REASON_COPY[day.unavailableReason]
          : 'No available times for this date.'}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        {availability.isFetching ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
        {day.slots.length} time{day.slots.length === 1 ? '' : 's'} · {day.serviceDurationMin}m ·
        times in {day.timezone}
      </p>
      <div role="radiogroup" aria-label="Available times" className="flex flex-wrap gap-2">
        {day.slots.map((slot) => {
          const active = props.selected === slot.startAt;
          return (
            <button
              key={slot.startAt}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => props.onSelect(slot)}
              className={
                'rounded-lg border px-2.5 py-1 text-sm tabular-nums transition-colors ' +
                (active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/60 bg-background hover:bg-muted')
              }
            >
              {localTime(slot.startAt)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
