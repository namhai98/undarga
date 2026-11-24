'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/services/api-error';
import type { PortalActionVerdict, PortalAppointmentDetail } from '@/services/customer-portal.service';
import {
  useCancelAppointment,
  useCustomerAppointment,
  useRescheduleAppointment,
  useRescheduleOptions,
} from '../api/use-customer-portal';
import {
  METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  STATUS_LABEL,
  day,
  isoDateIn,
  money,
  statusTone,
  time,
  when,
} from '../model/format';
import { Field, Loadable } from './portal-pages';

/** What a refused action means, in the customer's words. */
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SLOT_UNAVAILABLE' || error.code === 'SLOT_TAKEN') {
      return 'That time is no longer available. Pick another.';
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

export function PortalAppointment({ slug, id }: { slug: string; id: string }) {
  const appointment = useCustomerAppointment(slug, id);

  return (
    <div className="grid gap-4">
      <Link
        href={`/portal/${slug}/appointments`}
        className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} -ml-2 w-fit`}
      >
        <ArrowLeft aria-hidden className="size-4" />
        My appointments
      </Link>
      {appointment.error instanceof ApiError && appointment.error.status === 404 ? (
        <Alert role="alert">
          <AlertTitle>Appointment not found</AlertTitle>
          <AlertDescription>It may belong to a different account.</AlertDescription>
        </Alert>
      ) : (
        <Loadable query={appointment} label="Loading the appointment…" error="Could not load this appointment.">
          {(data) => <Detail slug={slug} data={data} />}
        </Loadable>
      )}
    </div>
  );
}

function Detail({ slug, data }: { slug: string; data: PortalAppointmentDetail }) {
  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{data.service ?? 'Appointment'}</h1>
          <Badge variant={statusTone(data.status)}>{STATUS_LABEL[data.status]}</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {when(data.startsAt, data.timezone)} – {time(data.endsAt, data.timezone)}
          <span className="font-mono"> · {data.appointmentNumber}</span>
        </p>
        {data.rescheduledFrom ? (
          <p className="text-muted-foreground text-xs">Moved from {data.rescheduledFrom}.</p>
        ) : null}
      </header>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Row label="Where">
              {data.branch.name}
              {data.branch.address ? <span className="text-muted-foreground block">{data.branch.address}</span> : null}
            </Row>
            <Row label="With">{data.employee ?? 'Our team'}</Row>
            <Row label="Duration">{data.durationMin ? `${data.durationMin} minutes` : '—'}</Row>
            <Row label="Times shown in">{data.timezone}</Row>
            {data.branch.phone ? <Row label="Phone">{data.branch.phone}</Row> : null}
            {data.customerNote ? <Row label="Your note">{data.customerNote}</Row> : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Price and payment</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <Line label="Price" value={money(data.price.subtotalMinor, data.price.currencyCode)} />
          {data.promotions.map((p) => (
            <Line
              key={p.name}
              label={`Discount — ${p.name}${p.code ? ` (${p.code})` : ''}`}
              value={`− ${money(p.discountMinor, data.price.currencyCode)}`}
            />
          ))}
          {data.promotions.length === 0 && data.price.discountMinor !== '0' ? (
            <Line label="Discount" value={`− ${money(data.price.discountMinor, data.price.currencyCode)}`} />
          ) : null}
          <Line label="Total" value={money(data.price.totalMinor, data.price.currencyCode)} strong />
          <div className="border-border/60 grid gap-2 border-t pt-3">
            <Line label="Payment" value={PAYMENT_STATUS_LABEL[data.payment.status] ?? data.payment.status} />
            <Line label="Paid" value={money(data.payment.paidMinor, data.price.currencyCode)} />
            {data.payment.refundedMinor !== '0' ? (
              <Line label="Refunded" value={money(data.payment.refundedMinor, data.price.currencyCode)} />
            ) : null}
            {data.status !== 'CANCELLED' ? (
              <Line label="Still to pay" value={money(data.payment.outstandingMinor, data.price.currencyCode)} />
            ) : null}
            {data.payment.inProgress ? (
              <p className="text-muted-foreground text-xs" role="status">
                An online payment is being processed.
              </p>
            ) : null}
          </div>
          {data.payment.payments.length > 0 ? (
            <ul className="text-muted-foreground grid gap-1 text-xs">
              {data.payment.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-2">
                  <span>
                    {day(p.paidAt)} · {METHOD_LABEL[p.method] ?? p.method}
                    {p.status !== 'SUCCEEDED' ? ` · ${p.status.toLowerCase()}` : ''}
                  </span>
                  <span className="tabular-nums">{money(p.amountMinor, p.currencyCode)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Actions slug={slug} data={data} />
    </div>
  );
}

function Actions({ slug, data }: { slug: string; data: PortalAppointmentDetail }) {
  const [mode, setMode] = useState<'none' | 'cancel' | 'reschedule'>('none');
  const [done, setDone] = useState<string | null>(null);
  const { cancel, reschedule } = data.actions;

  if (data.status === 'CANCELLED' || data.status === 'COMPLETED' || data.status === 'NO_SHOW') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {done ? (
          <Alert role="status" className="w-full">
            <AlertDescription>{done}</AlertDescription>
          </Alert>
        ) : null}
        <Link href={`/book/${slug}`} className={buttonVariants({ size: 'sm' })}>
          Book again
        </Link>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Need to change it?</CardTitle>
        {cancel.allowed && cancel.deadline ? (
          <CardDescription>
            You can change or cancel online until {when(cancel.deadline, data.timezone)}.
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {done ? (
          <Alert role="status">
            <AlertDescription>{done}</AlertDescription>
          </Alert>
        ) : null}
        {mode === 'none' ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {reschedule.allowed ? (
                <Button size="sm" onClick={() => setMode('reschedule')}>
                  Reschedule
                </Button>
              ) : null}
              {cancel.allowed ? (
                <Button size="sm" variant="outline" onClick={() => setMode('cancel')}>
                  Cancel appointment
                </Button>
              ) : null}
            </div>
            <NotAllowed verdict={cancel} label="Cancelling" />
            {reschedule.reason !== cancel.reason ? <NotAllowed verdict={reschedule} label="Rescheduling" /> : null}
          </div>
        ) : mode === 'cancel' ? (
          <CancelForm
            slug={slug}
            data={data}
            onDone={() => {
              setMode('none');
              setDone('Your appointment was cancelled.');
            }}
            onBack={() => setMode('none')}
          />
        ) : (
          <RescheduleForm slug={slug} data={data} onBack={() => setMode('none')} />
        )}
      </CardContent>
    </Card>
  );
}

function NotAllowed({ verdict, label }: { verdict: PortalActionVerdict; label: string }) {
  if (verdict.allowed || !verdict.message) return null;
  return (
    <p className="text-muted-foreground text-sm">
      <span className="font-medium">{label} online is not available.</span> {verdict.message}
    </p>
  );
}

function CancelForm({
  slug,
  data,
  onDone,
  onBack,
}: {
  slug: string;
  data: PortalAppointmentDetail;
  onDone: () => void;
  onBack: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cancel = useCancelAppointment(slug, data.id);
  const paid = data.payment.paidMinor !== '0';

  return (
    <div className="grid gap-3" role="group" aria-label="Cancel appointment">
      <p className="text-sm font-medium">Cancel {data.service ?? 'this appointment'} on {when(data.startsAt, data.timezone)}?</p>
      {paid ? (
        <p className="text-muted-foreground text-sm">
          You have paid {money(data.payment.paidMinor, data.price.currencyCode)}. The business handles any refund.
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not cancel</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field id="cancel-reason" label="Reason (optional)">
        <Input id="cancel-reason" value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={cancel.isPending}
          onClick={() => {
            setError(null);
            cancel.mutateAsync(reason.trim() || undefined).then(onDone, (caught: unknown) => setError(refusalMessage(caught)));
          }}
        >
          {cancel.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Yes, cancel it
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Keep my appointment
        </Button>
      </div>
    </div>
  );
}

function RescheduleForm({
  slug,
  data,
  onBack,
}: {
  slug: string;
  data: PortalAppointmentDetail;
  onBack: () => void;
}) {
  const router = useRouter();
  const [date, setDate] = useState(() => isoDateIn(data.timezone, 1));
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useRescheduleOptions(slug, data.id, date);
  const move = useRescheduleAppointment(slug, data.id);

  return (
    <div className="grid gap-4" role="group" aria-label="Reschedule appointment">
      <Field id="reschedule-date" label="New date" hint={`Times are in ${data.timezone}.`}>
        <Input
          id="reschedule-date"
          type="date"
          className="w-fit"
          value={date}
          min={isoDateIn(data.timezone)}
          onChange={(e) => {
            setDate(e.target.value);
            setPicked(null);
          }}
        />
      </Field>

      {options.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : options.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{refusalMessage(options.error)}</AlertDescription>
        </Alert>
      ) : options.data && options.data.slots.length === 0 ? (
        <p className="text-muted-foreground text-sm">No times are free that day. Try another date.</p>
      ) : (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Choose a time</p>
          <div className="flex flex-wrap gap-2">
            {options.data?.slots.map((slot) => (
              <Button
                key={slot.startAt}
                size="sm"
                variant={picked === slot.startAt ? 'default' : 'outline'}
                aria-pressed={picked === slot.startAt}
                onClick={() => setPicked(slot.startAt)}
              >
                {time(slot.startAt, data.timezone)}
              </Button>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not reschedule</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!picked || move.isPending}
          onClick={() => {
            if (!picked) return;
            setError(null);
            move.mutateAsync(picked).then(
              (moved) => router.replace(`/portal/${slug}/appointments/${moved.id}`),
              (caught: unknown) => {
                setError(refusalMessage(caught));
                setPicked(null);
                void options.refetch();
              },
            );
          }}
        >
          {move.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {picked ? `Move to ${when(picked, data.timezone)}` : 'Pick a time'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Keep the current time
        </Button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}
