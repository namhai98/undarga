'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { EmployeeDetail, EmployeeSchedule as Schedule } from '@/services/employees.service';
import { useEmployeeSchedule, useSaveEmployeeSchedule } from '../api/use-employees';
import { errorText, selectClass } from './shared';
import { useT } from '@/lib/i18n';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday first, the way a week is read on a schedule. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** One break per day in this form; empty times mean no break. */
type Row = {
  working: boolean;
  startsAt: string;
  endsAt: string;
  breakFrom: string;
  breakUntil: string;
};

function rowsFrom(schedule: Schedule | undefined): Record<number, Row> {
  const rows: Record<number, Row> = {};
  for (const day of WEEK_ORDER) {
    rows[day] = {
      working: false,
      startsAt: '09:00',
      endsAt: '18:00',
      breakFrom: '',
      breakUntil: '',
    };
  }
  for (const d of schedule?.days ?? []) {
    const first = d.breaks[0];
    rows[d.dayOfWeek] = {
      working: true,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      breakFrom: first?.startsAt ?? '',
      breakUntil: first?.endsAt ?? '',
    };
  }
  return rows;
}

/** A break is complete when both ends are set and differ. */
function breakOf(row: Row): { startsAt: string; endsAt: string } | null {
  return row.breakFrom && row.breakUntil && row.breakFrom !== row.breakUntil
    ? { startsAt: row.breakFrom, endsAt: row.breakUntil }
    : null;
}

/**
 * The working week at one branch.
 *
 * The availability engine offers this person only inside these hours (and the
 * branch's opening hours, minus time off and bookings). Saving replaces the
 * week from today; existing appointments are not moved.
 */
export function EmployeeSchedule({
  employee,
  canWrite,
}: {
  employee: EmployeeDetail;
  canWrite: boolean;
}) {
  const t = useT();
  const primary = employee.branches.find((b) => b.isPrimary) ?? employee.branches[0];
  const [branchId, setBranchId] = useState<string | null>(primary?.branchId ?? null);
  const current = employee.branches.some((b) => b.branchId === branchId)
    ? branchId
    : (primary?.branchId ?? null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Working hours')}</CardTitle>
        <CardDescription>
          {t(
            "Customers can only book this person inside these hours. Times are the branch's local time; an end before the start is an overnight shift.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {employee.branches.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('Add a branch first.')}</p>
        ) : (
          <>
            {employee.branches.length > 1 ? (
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="schedule-branch">{t('Branch')}</Label>
                <select
                  id="schedule-branch"
                  className={selectClass}
                  value={current ?? ''}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  {employee.branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>
                      {b.name ?? b.branchId}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {current ? (
              <WeekEditor
                key={current}
                employeeId={employee.id}
                branchId={current}
                canWrite={canWrite}
              />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WeekEditor({
  employeeId,
  branchId,
  canWrite,
}: {
  employeeId: string;
  branchId: string;
  canWrite: boolean;
}) {
  const t = useT();
  const schedule = useEmployeeSchedule(employeeId, branchId);

  if (schedule.isPending) return <Skeleton className="h-56 w-full" aria-busy="true" />;
  if (schedule.error) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('Could not load the working hours.')} {t(errorText(schedule.error))}
      </p>
    );
  }
  // Keyed on the data so a save or refetch resets the form to what the server holds.
  return (
    <WeekForm
      key={JSON.stringify(schedule.data.days)}
      employeeId={employeeId}
      branchId={branchId}
      initial={rowsFrom(schedule.data)}
      canWrite={canWrite}
    />
  );
}

function WeekForm({
  employeeId,
  branchId,
  initial,
  canWrite,
}: {
  employeeId: string;
  branchId: string;
  initial: Record<number, Row>;
  canWrite: boolean;
}) {
  const t = useT();
  const save = useSaveEmployeeSchedule(employeeId);
  const [rows, setRows] = useState(initial);
  const [saved, setSaved] = useState(false);

  const set = (day: number, patch: Partial<Row>) => {
    setSaved(false);
    setRows((r) => ({ ...r, [day]: { ...r[day]!, ...patch } }));
  };
  const invalid = WEEK_ORDER.filter(
    (d) => rows[d]!.working && rows[d]!.startsAt === rows[d]!.endsAt,
  );

  const submit = async () => {
    setSaved(false);
    try {
      await save.mutateAsync({
        branchId,
        days: WEEK_ORDER.filter((d) => rows[d]!.working).map((d) => {
          const lunch = breakOf(rows[d]!);
          return {
            dayOfWeek: d,
            startsAt: rows[d]!.startsAt,
            endsAt: rows[d]!.endsAt,
            ...(lunch ? { breaks: [lunch] } : {}),
          };
        }),
      });
      setSaved(true);
    } catch {
      // Shown below.
    }
  };

  return (
    <div className="grid gap-3">
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left text-xs">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('Day')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('Works')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('From')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('Until')}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t('Break (optional)')}
              </th>
            </tr>
          </thead>
          <tbody>
            {WEEK_ORDER.map((day) => {
              const row = rows[day]!;
              const name = DAY_NAMES[day]!;
              return (
                <tr key={day} className="border-border/40 border-t">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {name}
                  </th>
                  <td className="py-1.5 pr-3">
                    <input
                      type="checkbox"
                      aria-label={t('Works on {name}', { name })}
                      checked={row.working}
                      disabled={!canWrite}
                      onChange={(e) => set(day, { working: e.target.checked })}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Input
                      type="time"
                      aria-label={t('{name} from', { name })}
                      className="h-8 w-28"
                      value={row.startsAt}
                      disabled={!canWrite || !row.working}
                      onChange={(e) => set(day, { startsAt: e.target.value })}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Input
                      type="time"
                      aria-label={t('{name} until', { name })}
                      className="h-8 w-28"
                      value={row.endsAt}
                      disabled={!canWrite || !row.working}
                      onChange={(e) => set(day, { endsAt: e.target.value })}
                    />
                  </td>
                  <td className="py-1.5">
                    <div className="flex items-center gap-1">
                      <Input
                        type="time"
                        aria-label={t('{name} break from', { name })}
                        className="h-8 w-28"
                        value={row.breakFrom}
                        disabled={!canWrite || !row.working}
                        onChange={(e) => set(day, { breakFrom: e.target.value })}
                      />
                      <span className="text-muted-foreground">–</span>
                      <Input
                        type="time"
                        aria-label={t('{name} break until', { name })}
                        className="h-8 w-28"
                        value={row.breakUntil}
                        disabled={!canWrite || !row.working}
                        onChange={(e) => set(day, { breakUntil: e.target.value })}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {invalid.length > 0 ? (
        <p role="alert" className="text-destructive text-sm">
          {t('A shift cannot start and end at the same time (')}
          {invalid.map((d) => DAY_NAMES[d]).join(', ')}).
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-destructive text-sm">
          {t(errorText(save.error))}
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={save.isPending || invalid.length > 0}
            onClick={() => void submit()}
          >
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Save working hours')}
          </Button>
          {saved ? (
            <span role="status" className="text-muted-foreground text-sm">
              {t('Saved. New bookings follow these hours from today.')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
