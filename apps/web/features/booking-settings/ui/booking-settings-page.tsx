'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { ApiError } from '@/services/api-error';
import type { BookingSettings } from '@/services/booking-settings.service';
import { useBookingSettings, useUpdateBookingSettings } from '../api/use-booking-settings';

/**
 * The company's booking rules: how much notice, how far ahead, the
 * cancellation and rescheduling deadlines, and what customers may do
 * themselves. The server enforces them on staff booking, the public booking
 * page, rescheduling, the customer portal and recurring series alike.
 */
export function BookingSettingsPage() {
  const canRead = useCan('settings:read');
  const settings = useBookingSettings();

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>You do not have permission to see booking settings.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Booking rules</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          These apply everywhere an appointment is booked, moved or cancelled — by staff, online and
          in the customer portal. A service can override the notice, booking window and cancellation
          deadline on its own settings.
        </p>
      </header>
      {settings.isPending ? <Skeleton className="h-72 w-full" aria-busy="true" /> : null}
      {settings.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load booking rules</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}
      {settings.data ? (
        <SettingsForm key={JSON.stringify(settings.data)} saved={settings.data} />
      ) : null}
    </div>
  );
}

function SettingsForm({ saved }: { saved: BookingSettings }) {
  const canWrite = useCan('settings:write');
  const update = useUpdateBookingSettings();
  const [notice, setNotice] = useState(String(saved.minimumBookingNoticeMinutes));
  const [advance, setAdvance] = useState(String(saved.maximumAdvanceBookingDays));
  const [cancelHours, setCancelHours] = useState(String(saved.cancellationDeadlineHours));
  const [reschedulingAllowed, setReschedulingAllowed] = useState(saved.reschedulingAllowed);
  const [rescheduleHours, setRescheduleHours] = useState(
    saved.rescheduleDeadlineHours === null ? '' : String(saved.rescheduleDeadlineHours),
  );
  const [customerCancel, setCustomerCancel] = useState(saved.allowCustomerCancel);
  const [customerReschedule, setCustomerReschedule] = useState(saved.allowCustomerReschedule);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const toInt = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const problems = [
    !(toInt(notice) >= 0 && toInt(notice) <= 43_200) && 'Notice must be 0–43200 minutes.',
    !(toInt(advance) >= 1 && toInt(advance) <= 730) && 'Booking window must be 1–730 days.',
    !(toInt(cancelHours) >= 0 && toInt(cancelHours) <= 720) &&
      'Cancellation deadline must be 0–720 hours.',
    rescheduleHours.trim() !== '' &&
      !(toInt(rescheduleHours) >= 0 && toInt(rescheduleHours) <= 720) &&
      'Rescheduling deadline must be 0–720 hours.',
  ].filter(Boolean) as string[];

  const save = async () => {
    setMessage(null);
    try {
      await update.mutateAsync({
        minimumBookingNoticeMinutes: toInt(notice),
        maximumAdvanceBookingDays: toInt(advance),
        cancellationDeadlineHours: toInt(cancelHours),
        reschedulingAllowed,
        rescheduleDeadlineHours: rescheduleHours.trim() === '' ? null : toInt(rescheduleHours),
        allowCustomerCancel: customerCancel,
        allowCustomerReschedule: customerReschedule,
      });
      setMessage({ ok: true, text: 'Booking rules saved.' });
    } catch (caught) {
      setMessage({
        ok: false,
        text:
          caught instanceof ApiError && caught.code === 'VALIDATION_FAILED'
            ? caught.message
            : 'Could not save.',
      });
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">When bookings can be made</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <NumberField
            id="rule-notice"
            label="Minimum notice (minutes)"
            hint="No booking can start sooner than this. 0 = up to the last minute."
            value={notice}
            onChange={setNotice}
            disabled={!canWrite}
          />
          <NumberField
            id="rule-advance"
            label="Book up to (days ahead)"
            hint="Dates further ahead are not offered."
            value={advance}
            onChange={setAdvance}
            disabled={!canWrite}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cancelling and rescheduling</CardTitle>
          <CardDescription>
            After a deadline, staff must confirm the change as late (it needs the “cancel any
            appointment” permission and is recorded as late). Customers cannot change it at all.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <NumberField
            id="rule-cancel"
            label="Cancellation deadline (hours before)"
            value={cancelHours}
            onChange={setCancelHours}
            disabled={!canWrite}
          />
          <NumberField
            id="rule-reschedule"
            label="Rescheduling deadline (hours before)"
            hint="Leave empty to use the cancellation deadline."
            value={rescheduleHours}
            onChange={setRescheduleHours}
            disabled={!canWrite || !reschedulingAllowed}
          />
          <Check
            label="Appointments may be rescheduled"
            checked={reschedulingAllowed}
            onChange={setReschedulingAllowed}
            disabled={!canWrite}
          />
          <span />
          <Check
            label="Customers may cancel online"
            checked={customerCancel}
            onChange={setCustomerCancel}
            disabled={!canWrite}
          />
          <Check
            label="Customers may reschedule online"
            checked={customerReschedule}
            onChange={setCustomerReschedule}
            disabled={!canWrite || !reschedulingAllowed}
          />
        </CardContent>
      </Card>

      {problems.length ? (
        <ul className="text-destructive grid gap-1 text-sm" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <p role="status" className={message.ok ? 'text-sm' : 'text-destructive text-sm'}>
          {message.text}
        </p>
      ) : null}
      {canWrite ? (
        <div>
          <Button disabled={problems.length > 0 || update.isPending} onClick={() => void save()}>
            {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Save booking rules
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          You can view these rules but not change them.
        </p>
      )}
    </div>
  );
}

function NumberField(props: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type="number"
        min={0}
        inputMode="numeric"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint ? <p className="text-muted-foreground text-xs">{props.hint}</p> : null}
    </div>
  );
}

function Check(props: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}
