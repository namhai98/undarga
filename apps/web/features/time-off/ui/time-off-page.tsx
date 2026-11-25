'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBusinessTimezone } from '@/features/companies';
import { useEmployees } from '@/features/employees';
import { formatInZone as when, wallToIso } from '@/lib/zoned';
import { ApiError } from '@/services/api-error';
import type {
  TimeOff,
  TimeOffConflict,
  TimeOffStatus,
  TimeOffType,
} from '@/services/time-off.service';
import { useCreateTimeOff, useTimeOff, useUpdateTimeOff } from '../api/use-time-off';
import { useT } from '@/lib/i18n';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

export const TYPE_LABEL: Record<TimeOffType, string> = {
  VACATION: 'Vacation',
  SICK: 'Sick leave',
  PERSONAL: 'Personal leave',
  UNPAID: 'Unpaid leave',
  TRAINING: 'Training',
  PUBLIC_HOLIDAY: 'Public holiday',
  OTHER: 'Other',
};

const STATUS_LABEL: Record<TimeOffStatus, string> = {
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (
    ['VALIDATION_FAILED', 'CONFLICT', 'RESOURCE_NOT_FOUND', 'TIME_OFF_CONFLICT'].includes(
      error.code,
    )
  ) {
    return error.message;
  }
  if (error.code === 'PERMISSION_DENIED') return 'You do not have permission to do that.';
  return fallback;
}

function conflictsOf(error: unknown): TimeOffConflict[] {
  return error instanceof ApiError && error.code === 'TIME_OFF_CONFLICT'
    ? ((error.details?.appointments as TimeOffConflict[] | undefined) ?? [])
    : [];
}

/**
 * Employee time off: vacation, sick, personal leave and other absences.
 *
 * Managers (`timeoff:approve`) record anyone's time off as approved and
 * approve or reject requests. Staff (`timeoff:request`) request their own,
 * which stays pending until approved. Approved time off is removed from
 * availability at once, everywhere; booked appointments inside it are never
 * cancelled automatically — the server lists them and asks for confirmation.
 */
export function TimeOffPage() {
  const t = useT();
  const canApprove = useCan('timeoff:approve');
  const canRequest = useCan('timeoff:request');
  const [status, setStatus] = useState<TimeOffStatus | ''>('');
  const list = useTimeOff({ ...(status ? { status } : {}), limit: 100 });

  if (!canApprove && !canRequest) {
    return (
      <Alert role="status">
        <AlertTitle>{t('Not available')}</AlertTitle>
        <AlertDescription>{t('You do not have permission to see time off.')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Time off')}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          {canApprove
            ? t(
                'Approved time off blocks bookings for that staff member straight away. Requests from staff wait here for approval.',
              )
            : t('Request time off for yourself. It blocks bookings once a manager approves it.')}
        </p>
      </header>

      <NewTimeOff canApprove={canApprove} />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {canApprove ? t('All time off') : t('Your time off')}
            </CardTitle>
            <select
              aria-label={t('Filter by status')}
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as TimeOffStatus | '')}
            >
              <option value="">{t('Any status')}</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {list.isPending ? <Skeleton className="h-24 w-full" aria-busy="true" /> : null}
          {list.error ? (
            <p role="alert" className="text-destructive text-sm">
              {t('Could not load time off.')}
            </p>
          ) : null}
          {list.data && list.data.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('No time off recorded.')}</p>
          ) : null}
          <ul className="grid gap-2">
            {(list.data?.items ?? []).map((item) => (
              <TimeOffRow key={item.id} entry={item} canApprove={canApprove} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function NewTimeOff({ canApprove }: { canApprove: boolean }) {
  const t = useT();
  const canReadStaff = useCan('employee:read');
  const employees = useEmployees({ status: 'ACTIVE', limit: 100 });
  const create = useCreateTimeOff();
  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState<TimeOffType>('VACATION');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<TimeOffConflict[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const tz = useBusinessTimezone();

  const needsEmployee = canApprove;
  const invalid = (needsEmployee && !employeeId) || !from || !to || new Date(to) <= new Date(from);

  const submit = async (allowConflicts = false) => {
    setError(null);
    setDone(null);
    try {
      const saved = await create.mutateAsync({
        ...(employeeId ? { employeeId } : {}),
        type,
        startsAt: wallToIso(from, tz),
        endsAt: wallToIso(to, tz),
        reason: reason.trim() || null,
        ...(allowConflicts ? { allowConflicts: true } : {}),
      });
      setConflicts([]);
      setDone(
        saved.status === 'APPROVED'
          ? t('Recorded. {employeeName} is now unavailable for bookings in that period.', {
              employeeName: saved.employeeName,
            })
          : t('Requested. It blocks bookings once a manager approves it.'),
      );
      setFrom('');
      setTo('');
      setReason('');
    } catch (caught) {
      setConflicts(conflictsOf(caught));
      setError(errorText(caught, t('Could not save the time off.')));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {canApprove ? t('Record time off') : t('Request time off')}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {needsEmployee ? (
            <div className="grid gap-1.5">
              <Label htmlFor="timeoff-employee">{t('Staff member')}</Label>
              <select
                id="timeoff-employee"
                className={selectClass}
                value={employeeId}
                disabled={!canReadStaff}
                onChange={(e) => setEmployeeId(e.target.value)}
              >
                <option value="">{t('Select…')}</option>
                {(employees.data?.items ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="timeoff-type">{t('Type')}</Label>
            <select
              id="timeoff-type"
              className={selectClass}
              value={type}
              onChange={(e) => setType(e.target.value as TimeOffType)}
            >
              {Object.entries(TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="timeoff-from">{t('From')}</Label>
            <Input
              id="timeoff-from"
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="timeoff-to">{t('Until')}</Label>
            <Input
              id="timeoff-to"
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-1.5 sm:max-w-md">
          <Label htmlFor="timeoff-reason">{t('Note (optional, staff only)')}</Label>
          <Input
            id="timeoff-reason"
            value={reason}
            maxLength={512}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {t('Times are in the business’s time zone ({tz}).', { tz })}
        </p>

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{t('Not saved')}</AlertTitle>
            <AlertDescription className="grid gap-2">
              <p>{error}</p>
              {conflicts.length ? (
                <>
                  <ul className="list-disc pl-5">
                    {conflicts.map((c) => (
                      <li key={c.appointmentId}>
                        <a className="underline" href={`/appointments/${c.appointmentId}`}>
                          {c.appointmentNumber}
                        </a>{' '}
                        · {when(c.startsAt, tz)}
                      </li>
                    ))}
                  </ul>
                  <div>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={create.isPending}
                      onClick={() => void submit(true)}
                    >
                      {t('Record anyway (appointments stay booked)')}
                    </Button>
                  </div>
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {done ? (
          <p role="status" className="text-sm">
            {done}
          </p>
        ) : null}

        <div>
          <Button disabled={invalid || create.isPending} onClick={() => void submit()}>
            {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {canApprove ? t('Record time off') : t('Request time off')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TimeOffRow({ entry, canApprove }: { entry: TimeOff; canApprove: boolean }) {
  const t = useT();
  const update = useUpdateTimeOff();
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<TimeOffConflict[]>([]);
  const tz = useBusinessTimezone();

  const change = async (status: 'APPROVED' | 'REJECTED' | 'CANCELLED', allowConflicts = false) => {
    setError(null);
    try {
      await update.mutateAsync({
        id: entry.id,
        status,
        ...(allowConflicts ? { allowConflicts: true } : {}),
      });
      setConflicts([]);
    } catch (caught) {
      setConflicts(conflictsOf(caught));
      setError(errorText(caught, t('Could not change this time off.')));
    }
  };

  const open = entry.status === 'PENDING' || entry.status === 'APPROVED';

  return (
    <li className="border-border/60 grid gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="font-medium">
            {entry.employeeName} · {t(TYPE_LABEL[entry.type])}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {when(entry.startsAt, tz)} → {when(entry.endsAt, tz)}
          </span>
          {entry.reason ? (
            <span className="text-muted-foreground text-xs">{entry.reason}</span>
          ) : null}
        </div>
        <Badge
          variant={
            entry.status === 'APPROVED'
              ? 'default'
              : entry.status === 'PENDING'
                ? 'outline'
                : 'secondary'
          }
        >
          {t(STATUS_LABEL[entry.status])}
        </Badge>
      </div>
      {open ? (
        <div className="flex flex-wrap gap-2">
          {canApprove && entry.status === 'PENDING' ? (
            <>
              <Button size="sm" disabled={update.isPending} onClick={() => void change('APPROVED')}>
                {t('Approve')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => void change('REJECTED')}
              >
                {t('Reject')}
              </Button>
            </>
          ) : null}
          {canApprove || entry.status === 'PENDING' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => void change('CANCELLED')}
            >
              {entry.status === 'PENDING' && !canApprove ? t('Withdraw') : t('Cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-destructive grid gap-1">
          <p>{error}</p>
          {conflicts.length ? (
            <div>
              <Button size="sm" variant="destructive" onClick={() => void change('APPROVED', true)}>
                {conflicts.length === 1
                  ? t('Approve anyway (1 appointment stays booked)')
                  : t('Approve anyway ({count} appointments stay booked)', {
                      count: conflicts.length,
                    })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
