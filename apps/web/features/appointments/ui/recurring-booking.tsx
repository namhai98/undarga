'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/services/api-error';
import type {
  CreateSeriesInput,
  RecurrenceFrequency,
  RecurrenceInput,
  SeriesOccurrencePreview,
  SeriesPreview,
} from '@/services/appointments.service';
import { useCreateSeries, usePreviewSeries } from '../api/use-appointments';
import {
  WEEKDAY_SHORT,
  bookingErrorMessage,
  localTime,
  occurrenceReason,
} from '../model/appointment-display';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

const UNIT: Record<RecurrenceFrequency, string> = {
  DAILY: 'day(s)',
  WEEKLY: 'week(s)',
  MONTHLY: 'month(s)',
};
const MAX_OCCURRENCES = 52;

export type SeriesBase = Omit<CreateSeriesInput, 'recurrence' | 'onConflict'>;

/**
 * Repeat a booking: daily, weekly (on chosen weekdays) or monthly, ending on
 * a date or after a number of visits.
 *
 * "Check dates" asks the server to validate every occurrence — hours, staff
 * schedules, time off, rooms, booking rules, existing bookings — and lists
 * each one. Nothing is booked until "Book", and then all dates are written
 * together: if any date was taken in the meantime, none are created (unless
 * "skip" was chosen, which books only the free dates and never forces one).
 */
export function RecurringBooking({
  base,
  startDate,
  onBooked,
}: {
  base: SeriesBase;
  /** The first occurrence's local date, `YYYY-MM-DD`. */
  startDate: string;
  onBooked: (result: { firstAppointmentId: string | null; seriesId: string }) => void;
}) {
  const startWeekday = new Date(`${startDate}T00:00:00Z`).getUTCDay();
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('WEEKLY');
  const [interval, setInterval] = useState(1);
  const [weekdays, setWeekdays] = useState<number[]>([startWeekday]);
  const [endMode, setEndMode] = useState<'count' | 'date'>('count');
  const [count, setCount] = useState(4);
  const [endDate, setEndDate] = useState('');
  const [skipConflicts, setSkipConflicts] = useState(false);
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = usePreviewSeries();
  const create = useCreateSeries();

  const recurrence: RecurrenceInput = {
    frequency,
    interval,
    ...(frequency === 'WEEKLY' ? { weekdays: [...weekdays].sort() } : {}),
    ...(endMode === 'count' ? { count } : { endDate }),
  };
  const input: CreateSeriesInput = { ...base, recurrence };
  const ruleError =
    frequency === 'WEEKLY' && weekdays.length === 0
      ? 'Choose at least one weekday.'
      : endMode === 'date' && !endDate
        ? 'Choose an end date.'
        : endMode === 'date' && endDate < startDate
          ? 'The end date must be on or after the first date.'
          : endMode === 'count' && (count < 1 || count > MAX_OCCURRENCES)
            ? `Between 1 and ${MAX_OCCURRENCES} occurrences.`
            : null;

  /** Any change to the rule makes the checked list stale. */
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setError(null);
    };

  const runPreview = async () => {
    setError(null);
    try {
      setPreview(await check.mutateAsync(input));
    } catch (caught) {
      setError(bookingErrorMessage(caught, 'Could not check these dates.'));
    }
  };

  const book = async () => {
    setError(null);
    try {
      const series = await create.mutateAsync({
        ...input,
        onConflict: skipConflicts ? 'skip' : 'fail',
      });
      onBooked({ firstAppointmentId: series.occurrences[0]?.id ?? null, seriesId: series.id });
    } catch (caught) {
      setError(bookingErrorMessage(caught, 'Could not book this series.'));
      // A date was taken since the check: show the fresh state of every date.
      if (caught instanceof ApiError && caught.code === 'SERIES_CONFLICT') void runPreview();
    }
  };

  const conflicts = preview?.conflictCount ?? 0;
  const bookable = preview?.bookableCount ?? 0;
  const canBook = preview !== null && bookable > 0 && (conflicts === 0 || skipConflicts);

  return (
    <div className="grid gap-3" aria-label="Repeat">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="repeat-frequency">Repeats</Label>
          <select
            id="repeat-frequency"
            className={selectClass}
            value={frequency}
            onChange={(e) => changed(setFrequency)(e.target.value as RecurrenceFrequency)}
          >
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly (same day of month)</option>
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="repeat-interval">Every</Label>
          <div className="flex items-center gap-2">
            <Input
              id="repeat-interval"
              type="number"
              min={1}
              max={12}
              className="w-20"
              value={interval}
              onChange={(e) =>
                changed(setInterval)(Math.max(1, Math.min(12, Number(e.target.value) || 1)))
              }
            />
            <span className="text-muted-foreground text-sm">{UNIT[frequency]}</span>
          </div>
        </div>
      </div>

      {frequency === 'WEEKLY' ? (
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-medium">On</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_SHORT.map((label, day) => (
              <label key={label} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={weekdays.includes(day)}
                  onChange={(e) =>
                    changed(setWeekdays)(
                      e.target.checked ? [...weekdays, day] : weekdays.filter((d) => d !== day),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Ends</legend>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="repeat-end"
              checked={endMode === 'count'}
              onChange={() => changed(setEndMode)('count')}
            />
            After
          </label>
          <Input
            aria-label="Number of occurrences"
            type="number"
            min={1}
            max={MAX_OCCURRENCES}
            className="w-20"
            value={count}
            disabled={endMode !== 'count'}
            onChange={(e) => changed(setCount)(Number(e.target.value) || 1)}
          />
          <span>occurrences</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="repeat-end"
              checked={endMode === 'date'}
              onChange={() => changed(setEndMode)('date')}
            />
            On
          </label>
          <Input
            aria-label="End date"
            type="date"
            className="w-44"
            min={startDate}
            value={endDate}
            disabled={endMode !== 'date'}
            onChange={(e) => changed(setEndDate)(e.target.value)}
          />
        </div>
      </fieldset>

      {ruleError ? <p className="text-destructive text-sm">{ruleError}</p> : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Not booked</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {preview ? <PreviewList preview={preview} /> : null}

      {preview && conflicts > 0 && bookable > 0 ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={skipConflicts}
            onChange={(e) => setSkipConflicts(e.target.checked)}
          />
          Book the {bookable} available date{bookable === 1 ? '' : 's'} and skip the {conflicts}{' '}
          that cannot be booked
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={Boolean(ruleError) || check.isPending}
          onClick={() => void runPreview()}
        >
          {check.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Check dates
        </Button>
        <Button disabled={!canBook || create.isPending} onClick={() => void book()}>
          {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {preview
            ? `Book ${skipConflicts ? bookable : preview.occurrences.length} appointments`
            : 'Book series'}
        </Button>
      </div>
    </div>
  );
}

function PreviewList({ preview }: { preview: SeriesPreview }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        {preview.bookableCount} of {preview.occurrences.length} dates can be booked
        {preview.conflictCount ? `; ${preview.conflictCount} cannot.` : '.'}
      </p>
      <ul className="grid max-h-64 gap-1 overflow-y-auto text-sm" aria-label="Occurrences">
        {preview.occurrences.map((o) => (
          <Occurrence key={o.index} occurrence={o} />
        ))}
      </ul>
      {preview.skippedDates.length ? (
        <p className="text-muted-foreground text-xs">
          Skipped (no such day that month): {preview.skippedDates.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function Occurrence({ occurrence: o }: { occurrence: SeriesOccurrencePreview }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-28 tabular-nums">{o.date}</span>
      <span className="w-12 tabular-nums">{localTime(o.startsAt)}</span>
      {o.bookable ? (
        <Badge variant="secondary">Available</Badge>
      ) : (
        <>
          <Badge variant="destructive">Cannot book</Badge>
          <span className="text-muted-foreground text-xs">
            {occurrenceReason(o.reason, o.message)}
          </span>
        </>
      )}
    </li>
  );
}
