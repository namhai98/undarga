'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useCancelSeries, useSeries } from '../api/use-appointments';
import {
  bookingErrorMessage,
  describeRecurrence,
  isLive,
  localDate,
  localTime,
  ruleViolation,
} from '../model/appointment-display';
import { StatusBadge } from './status-badge';

const SERIES_STATUS = { ACTIVE: 'Active', ENDED: 'Ended', CANCELLED: 'Cancelled' } as const;

/**
 * The recurring series an appointment belongs to: its rule, every
 * occurrence, and cancelling this one or every one from here on.
 *
 * Cancelling the future ones needs `appointment:cancel:any`; past the
 * cancellation deadline the server refuses until it is confirmed as late
 * (which also needs that permission).
 */
export function SeriesCard({ seriesId, currentId }: { seriesId: string; currentId: string }) {
  const series = useSeries(seriesId);
  const cancel = useCancelSeries(seriesId);
  const canCancelAny = useCan('appointment:cancel:any');
  const canCancelOwn = useCan('appointment:cancel:own');

  const [mode, setMode] = useState<'idle' | 'occurrence' | 'future'>('idle');
  const [reason, setReason] = useState('');
  const [late, setLate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (series.isPending) return <Skeleton className="h-32 w-full" aria-busy="true" />;
  if (!series.data) return null;
  const s = series.data;
  const current = s.occurrences.find((o) => o.id === currentId);

  const submit = async (confirmLate = false) => {
    if (!reason.trim() || mode === 'idle') return;
    setError(null);
    try {
      await cancel.mutateAsync(
        mode === 'occurrence'
          ? {
              scope: 'occurrence',
              appointmentId: currentId,
              reason: reason.trim(),
              lateCancellation: confirmLate || undefined,
            }
          : {
              scope: 'future',
              from: current?.startsAt,
              reason: reason.trim(),
              lateCancellation: confirmLate || undefined,
            },
      );
      setMode('idle');
      setReason('');
      setLate(false);
    } catch (caught) {
      setLate(ruleViolation(caught) === 'CANCELLATION_DEADLINE' && canCancelAny);
      setError(bookingErrorMessage(caught, 'Could not cancel.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Recurring series</CardTitle>
          <Badge variant={s.status === 'ACTIVE' ? 'default' : 'secondary'}>
            {SERIES_STATUS[s.status]}
          </Badge>
        </div>
        <CardDescription>
          {describeRecurrence(s.recurrence)} at {s.recurrence.localStartTime} · {s.counts.upcoming}{' '}
          upcoming, {s.counts.cancelled} cancelled of {s.counts.total}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ol className="grid max-h-60 gap-1 overflow-y-auto text-sm" aria-label="Occurrences">
          {s.occurrences.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-right tabular-nums">{(o.seriesIndex ?? 0) + 1}.</span>
              {o.id === currentId ? (
                <span className="font-medium tabular-nums">
                  {localDate(o.startsAt)} {localTime(o.startsAt)} (this one)
                </span>
              ) : (
                <Link href={`/appointments/${o.id}`} className="tabular-nums hover:underline">
                  {localDate(o.startsAt)} {localTime(o.startsAt)}
                </Link>
              )}
              <StatusBadge status={o.status} />
            </li>
          ))}
        </ol>

        {mode === 'idle' && s.status === 'ACTIVE' ? (
          <div className="flex flex-wrap gap-2">
            {(canCancelAny || canCancelOwn) && current && isLive(current.status) ? (
              <Button size="sm" variant="outline" onClick={() => setMode('occurrence')}>
                Cancel this occurrence
              </Button>
            ) : null}
            {canCancelAny ? (
              <Button size="sm" variant="destructive" onClick={() => setMode('future')}>
                Cancel this and all later
              </Button>
            ) : null}
          </div>
        ) : null}

        {mode !== 'idle' ? (
          <div className="grid gap-2" role="group" aria-label="Cancel series">
            <p className="text-sm">
              {mode === 'occurrence'
                ? 'Only this date is cancelled; the rest of the series stays booked.'
                : 'This date and every later one in the series are cancelled. Earlier ones are kept.'}
            </p>
            <div className="grid gap-1.5 sm:max-w-md">
              <Label htmlFor="series-cancel-reason">Reason (required)</Label>
              <Input
                id="series-cancel-reason"
                value={reason}
                maxLength={400}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={!reason.trim() || cancel.isPending}
                onClick={() => void submit(false)}
              >
                {cancel.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Confirm cancellation
              </Button>
              {late ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={cancel.isPending}
                  onClick={() => void submit(true)}
                >
                  Cancel anyway (late cancellation)
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMode('idle');
                  setError(null);
                  setLate(false);
                }}
              >
                Keep
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
