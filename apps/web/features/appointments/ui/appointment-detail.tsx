'use client';

import { formatMoney } from '@undarga/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { currencyFormat } from '@/lib/currency';
import { PriceBreakdown } from '@/components/price-breakdown';
import type { AppointmentDetail as Detail, StatusAction } from '@/services/appointments.service';
import type { AvailabilitySlot } from '@/services/availability.service';
import {
  useAppointment,
  useAppointmentAction,
  useCancelAppointment,
  useRescheduleAppointment,
} from '../api/use-appointments';
import {
  ACTIONS_BY_STATUS,
  ACTION_LABEL,
  STATUS_LABEL,
  bookingErrorMessage,
  localDate,
  localTime,
} from '../model/appointment-display';
import { SlotPicker } from './slot-picker';
import { StatusBadge } from './status-badge';

/**
 * One appointment: who, what, when, where, its history, and what can happen
 * next. Action buttons follow the status as a convenience; the server's
 * transition graph decides.
 */
export function AppointmentDetail({ appointmentId }: { appointmentId: string }) {
  const appointment = useAppointment(appointmentId);

  if (appointment.isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">Loading appointment…</span>
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (appointment.error || !appointment.data) {
    return (
      <div className="grid gap-4">
        <BackLink />
        <Alert variant="destructive" role="alert">
          <AlertTitle>Appointment not found</AlertTitle>
          <AlertDescription>It may belong to another company, or you may not have access.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return <Loaded detail={appointment.data} />;
}

function Loaded({ detail }: { detail: Detail }) {
  const router = useRouter();
  const canWrite = useCan('appointment:write');
  // Both hooks always run — never short-circuit a hook call.
  const canCancelAny = useCan('appointment:cancel:any');
  const canCancelOwn = useCan('appointment:cancel:own');
  const canCancel = canCancelAny || canCancelOwn;

  const act = useAppointmentAction(detail.id);
  const cancel = useCancelAppointment(detail.id);
  const reschedule = useRescheduleAppointment(detail.id);

  const [mode, setMode] = useState<'idle' | 'cancel' | 'reschedule'>('idle');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [newDate, setNewDate] = useState(localDate(detail.startsAt));
  const [newSlot, setNewSlot] = useState<AvailabilitySlot | null>(null);

  const allowed = ACTIONS_BY_STATUS[detail.status];
  const busy = act.isPending || cancel.isPending || reschedule.isPending;

  const run = async (action: StatusAction) => {
    setError(null);
    try {
      await act.mutateAsync({ action });
    } catch (caught) {
      setError(bookingErrorMessage(caught, `Could not ${ACTION_LABEL[action].toLowerCase()}.`));
    }
  };

  const confirmCancel = async () => {
    if (!reason.trim()) return;
    setError(null);
    try {
      await cancel.mutateAsync(reason.trim());
      setMode('idle');
      setReason('');
    } catch (caught) {
      setError(bookingErrorMessage(caught, 'Could not cancel this appointment.'));
    }
  };

  const confirmReschedule = async () => {
    if (!newSlot) return;
    setError(null);
    try {
      const moved = await reschedule.mutateAsync({
        startsAt: newSlot.startAt,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      router.push(`/appointments/${moved.id}`);
    } catch (caught) {
      setError(bookingErrorMessage(caught, 'Could not reschedule this appointment.'));
      setNewSlot(null);
    }
  };

  const serviceId = detail.service?.id ?? '';

  return (
    <div className="grid gap-4">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {detail.service?.name ?? 'Appointment'} <StatusBadge status={detail.status} />
          </h1>
          <p className="text-muted-foreground text-sm tabular-nums">
            {localDate(detail.startsAt)} · {localTime(detail.startsAt)}–{localTime(detail.endsAt)} (
            {detail.timezone}) ·{' '}
            <span className="font-mono text-xs">{detail.appointmentNumber}</span>
          </p>
        </div>

        {mode === 'idle' ? (
          <div className="flex flex-wrap gap-2">
            {canWrite
              ? allowed.actions.map((action) => (
                  <Button key={action} size="sm" disabled={busy} onClick={() => void run(action)}>
                    {act.isPending && act.variables?.action === action ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : null}
                    {ACTION_LABEL[action]}
                  </Button>
                ))
              : null}
            {canWrite && allowed.reschedule ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('reschedule')}>
                Reschedule
              </Button>
            ) : null}
            {canCancel && allowed.cancel ? (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => setMode('cancel')}>
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Not done</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {mode === 'cancel' ? (
        <Alert role="alert">
          <AlertTitle>Cancel this appointment?</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              The slot is released immediately. The appointment is kept with the reason you give —
              it is never deleted.
            </p>
            <div className="grid gap-1.5 sm:max-w-md">
              <Label htmlFor="cancel-reason">Reason (required)</Label>
              <Input
                id="cancel-reason"
                value={reason}
                maxLength={512}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={!reason.trim() || cancel.isPending}
                onClick={() => void confirmCancel()}
              >
                {cancel.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Cancel appointment
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMode('idle');
                  setReason('');
                }}
              >
                Keep it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {mode === 'reschedule' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Move to another time</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-muted-foreground text-sm">
              Same service and customer
              {detail.employee ? ` with ${detail.employee.name}` : ''}. The original is cancelled
              and a new appointment is created, linked to it.
            </p>
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor="reschedule-date">Date</Label>
              <Input
                id="reschedule-date"
                type="date"
                value={newDate}
                onChange={(e) => {
                  setNewDate(e.target.value);
                  setNewSlot(null);
                }}
              />
            </div>
            <SlotPicker
              branchId={detail.branch.id}
              serviceId={serviceId}
              date={newDate}
              employeeId={detail.employee?.id}
              excludeAppointmentId={detail.id}
              selected={newSlot?.startAt ?? null}
              onSelect={setNewSlot}
            />
            <div className="grid gap-1.5 sm:max-w-md">
              <Label htmlFor="reschedule-reason">Reason (optional)</Label>
              <Input
                id="reschedule-reason"
                value={reason}
                maxLength={400}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!newSlot || reschedule.isPending}
                onClick={() => void confirmReschedule()}
              >
                {reschedule.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Move to {newSlot ? localTime(newSlot.startAt) : '…'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMode('idle');
                  setNewSlot(null);
                  setReason('');
                }}
              >
                Back
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {detail.rescheduledTo ? (
        <Alert role="status">
          <AlertTitle>Rescheduled</AlertTitle>
          <AlertDescription>
            Moved to{' '}
            <Link href={`/appointments/${detail.rescheduledTo.id}`} className="underline">
              {localDate(detail.rescheduledTo.startsAt)} {localTime(detail.rescheduledTo.startsAt)}{' '}
              ({detail.rescheduledTo.appointmentNumber})
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer">
                <Link href={`/customers/${detail.customer.id}`} className="hover:underline">
                  {detail.customer.name}
                </Link>
                {detail.customer.phone ? (
                  <span className="text-muted-foreground block text-xs">{detail.customer.phone}</span>
                ) : null}
              </Field>
              <Field label="Service">
                {detail.service?.name ?? '—'}
                {detail.durationMin ? (
                  <span className="text-muted-foreground block text-xs">
                    {detail.durationMin}m
                    {detail.bufferBeforeMin || detail.bufferAfterMin
                      ? ` · occupies ${localTime(detail.reservedFrom!)}–${localTime(detail.reservedTo!)}`
                      : ''}
                  </span>
                ) : null}
              </Field>
              <Field label="Employee">{detail.employee?.name ?? '—'}</Field>
              <Field label="Room / equipment">
                {detail.resources.length ? detail.resources.map((r) => r.name).join(', ') : '—'}
              </Field>
              <Field label="Branch">{detail.branch.name}</Field>
              <Field label="Price">
                {detail.discountMinor !== '0' ? (
                  <PriceBreakdown
                    originalMinor={detail.subtotalMinor}
                    discountMinor={detail.discountMinor}
                    finalMinor={detail.totalMinor}
                    currencyCode={detail.currencyCode}
                    discountLabel={
                      detail.promotions
                        .map((p) => (p.code ? `${p.name} · ${p.code}` : p.name))
                        .join(', ') || null
                    }
                  />
                ) : (
                  formatMoney(
                    { amountMinor: detail.totalMinor, currencyCode: detail.currencyCode },
                    currencyFormat(detail.currencyCode),
                  )
                )}
              </Field>
              <Field label="Booked via">{detail.source.toLowerCase().replace(/_/g, ' ')}</Field>
              <Field label="Payment">{detail.paymentStatus.toLowerCase().replace(/_/g, ' ')}</Field>
              <Field label="Customer note">{detail.customerNote ?? '—'}</Field>
              <Field label="Internal note">{detail.internalNote ?? '—'}</Field>
              {detail.cancellation ? (
                <Field label="Cancelled">
                  {new Date(detail.cancellation.cancelledAt).toLocaleString()}
                  <span className="text-muted-foreground block text-xs">
                    {detail.cancellation.reason ?? 'No reason given'}
                  </span>
                </Field>
              ) : null}
              {detail.rescheduledFrom ? (
                <Field label="Moved from">
                  <Link href={`/appointments/${detail.rescheduledFrom.id}`} className="hover:underline">
                    {localDate(detail.rescheduledFrom.startsAt)}{' '}
                    {localTime(detail.rescheduledFrom.startsAt)}
                  </Link>
                </Field>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-3">
              {detail.history.map((h) => (
                <li key={h.id} className="text-sm">
                  <div className="font-medium">
                    {h.fromStatus ? `${STATUS_LABEL[h.fromStatus]} → ` : ''}
                    {STATUS_LABEL[h.toStatus]}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {new Date(h.changedAt).toLocaleString()}
                    {h.actorLabel ? ` · ${h.actorLabel}` : ''}
                  </div>
                  {h.reason ? <div className="text-muted-foreground text-xs">{h.reason}</div> : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/appointments"
      className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} -ml-2 w-fit`}
    >
      <ArrowLeft aria-hidden className="size-4" />
      All appointments
    </Link>
  );
}
