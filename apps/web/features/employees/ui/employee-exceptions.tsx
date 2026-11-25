'use client';

import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useScheduleExceptionChanges, useScheduleExceptions } from '../api/use-employees';
import { errorText } from './shared';
import { useT } from '@/lib/i18n';

/**
 * One-off days: "off on the 14th", "only 10:00–14:00 this Friday". Each
 * replaces the usual shift for that date. Existing bookings are not moved —
 * the screen says so, because that is the surprise people hit.
 */
export function EmployeeExceptions({
  employeeId,
  canWrite,
}: {
  employeeId: string;
  canWrite: boolean;
}) {
  const t = useT();
  const list = useScheduleExceptions(employeeId);
  const { put, remove } = useScheduleExceptionChanges(employeeId);
  const [date, setDate] = useState('');
  const [working, setWorking] = useState(false);
  const [from, setFrom] = useState('10:00');
  const [until, setUntil] = useState('14:00');
  const [note, setNote] = useState('');
  const error = put.error ?? remove.error;
  const invalid = !date || (working && (!from || !until || from === until));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    put.mutate(
      {
        date,
        isWorking: working,
        ...(working ? { startsAt: from, endsAt: until } : {}),
        note: note.trim() || null,
      },
      {
        onSuccess: () => {
          setDate('');
          setNote('');
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('One-off days')}</CardTitle>
        <CardDescription>
          {t(
            'A day off or different hours on one date. Existing appointments on that date are not moved — check them in the appointment list.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {(list.data?.items ?? []).length === 0 ? (
          <p className="text-muted-foreground">{t('None in the next 90 days.')}</p>
        ) : (
          <ul className="grid gap-2">
            {list.data!.items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="tabular-nums">
                  {x.date}{' '}
                  {x.isWorking ? (
                    <Badge variant="secondary">
                      {x.startsAt}–{x.endsAt}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">{t('Day off')}</Badge>
                  )}
                  {x.note ? <span className="text-muted-foreground"> · {x.note}</span> : null}
                </span>
                {canWrite ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    aria-label={t('Remove the change on {date}', { date: x.date })}
                    onClick={() => remove.mutate(x.id)}
                  >
                    {t('Remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
            <div className="grid gap-1.5">
              <Label htmlFor="exception-date">{t('Date')}</Label>
              <Input
                id="exception-date"
                type="date"
                className="h-8 w-40"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <label className="flex h-8 items-center gap-2">
              <input
                type="checkbox"
                checked={working}
                onChange={(e) => setWorking(e.target.checked)}
              />
              {t('Works, different hours')}
            </label>
            {working ? (
              <>
                <Input
                  type="time"
                  aria-label={t('Works from')}
                  className="h-8 w-28"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <Input
                  type="time"
                  aria-label={t('Works until')}
                  className="h-8 w-28"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="exception-note">{t('Note (optional)')}</Label>
              <Input
                id="exception-note"
                className="h-8 w-48"
                maxLength={256}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={invalid || put.isPending}>
              {put.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {working ? t('Set hours') : t('Set day off')}
            </Button>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {t(errorText(error))}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
