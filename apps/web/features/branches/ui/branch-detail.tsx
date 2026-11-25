'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { errorText, selectClass } from '@/lib/form';
import { timezoneOptions } from '@/lib/timezones';
import type { Branch, BranchStatus, BusinessHoursDay } from '@/services/branches.service';
import {
  useBranch,
  useBusinessHours,
  useDeleteBranch,
  usePutBusinessHours,
  useUpdateBranch,
} from '../api/use-branches';
import { BRANCH_STATUS_LABEL } from './branch-list';
import { BranchRules } from './branch-rules';
import { useT } from '@/lib/i18n';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** One branch: its details, its opening hours, and closing it down. */
export function BranchDetail({ branchId }: { branchId: string }) {
  const t = useT();
  const branch = useBranch(branchId);
  const canWrite = useCan('branch:write');

  if (branch.isPending) return <Skeleton className="h-64 w-full" aria-busy="true" />;
  if (branch.error || !branch.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{t('Branch not found')}</AlertTitle>
        <AlertDescription>
          {t('It may have been removed.')}{' '}
          <Link href="/settings" className="underline">
            {t('Back to settings')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link
          href="/settings"
          className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> {t('Settings')}
        </Link>
        <h1 className="text-xl font-semibold">{branch.data.name}</h1>
      </div>
      <BranchForm key={branch.data.updatedAt} branch={branch.data} canWrite={canWrite} />
      <OpeningHours branchId={branchId} canWrite={canWrite} />
      <BranchRules branchId={branchId} canWrite={canWrite} />
      {canWrite ? <RemoveBranch branch={branch.data} /> : null}
    </div>
  );
}

function BranchForm({ branch, canWrite }: { branch: Branch; canWrite: boolean }) {
  const t = useT();
  const update = useUpdateBranch(branch.id);
  const [form, setForm] = useState({
    name: branch.name,
    code: branch.code,
    status: branch.status,
    timezoneName: branch.timezoneName,
    phone: branch.phone ?? '',
    email: branch.email ?? '',
    addressLine1: branch.addressLine1 ?? '',
    addressLine2: branch.addressLine2 ?? '',
    city: branch.city ?? '',
    district: branch.district ?? '',
  });
  const [saved, setSaved] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const zones = timezoneOptions();
  const orNull = (v: string) => v.trim() || null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        status: form.status,
        timezoneName: form.timezoneName,
        phone: orNull(form.phone),
        email: orNull(form.email),
        addressLine1: orNull(form.addressLine1),
        addressLine2: orNull(form.addressLine2),
        city: orNull(form.city),
        district: orNull(form.district),
      });
      setSaved(true);
    } catch {
      // Shown below.
    }
  };

  const field = (id: keyof typeof form, label: string, props: Record<string, unknown> = {}) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`branch-${id}`}>{label}</Label>
      <Input
        id={`branch-${id}`}
        value={form[id]}
        disabled={!canWrite}
        onChange={(e) => set(id)(e.target.value)}
        {...props}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Details')}</CardTitle>
        <CardDescription>
          {t(
            'The time zone decides when this branch opens: every booking here is calculated in it.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void submit(e)}>
          {field('name', 'Branch name', { required: true, maxLength: 128 })}
          {field('code', 'Short code', { required: true, maxLength: 24 })}
          <div className="grid gap-1.5">
            <Label htmlFor="branch-status">{t('Status')}</Label>
            <select
              id="branch-status"
              className={selectClass}
              value={form.status}
              disabled={!canWrite}
              onChange={(e) => set('status')(e.target.value as BranchStatus)}
            >
              {Object.entries(BRANCH_STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="branch-timezoneName">{t('Time zone')}</Label>
            <select
              id="branch-timezoneName"
              className={selectClass}
              value={form.timezoneName}
              disabled={!canWrite}
              onChange={(e) => set('timezoneName')(e.target.value)}
            >
              {(zones.includes(form.timezoneName) ? zones : [form.timezoneName, ...zones]).map(
                (z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ),
              )}
            </select>
          </div>
          {field('phone', 'Phone', { maxLength: 32 })}
          {field('email', 'Email', { type: 'email', maxLength: 320 })}
          {field('addressLine1', 'Address', { maxLength: 160 })}
          {field('addressLine2', 'Address line 2', { maxLength: 160 })}
          {field('district', 'District', { maxLength: 96 })}
          {field('city', 'City', { maxLength: 96 })}
          {update.error ? (
            <p role="alert" className="text-destructive text-sm sm:col-span-2">
              {t(errorText(update.error))}
            </p>
          ) : null}
          {canWrite ? (
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" size="sm" disabled={update.isPending || !form.name.trim()}>
                {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('Save branch')}
              </Button>
              {saved ? (
                <span role="status" className="text-muted-foreground text-sm">
                  {t('Saved.')}
                </span>
              ) : null}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

type HoursRow = { open: boolean; opensAt: string; closesAt: string };

function rowsFrom(days: BusinessHoursDay[] | undefined): Record<number, HoursRow> {
  const rows: Record<number, HoursRow> = {};
  for (const d of WEEK_ORDER) rows[d] = { open: false, opensAt: '09:00', closesAt: '18:00' };
  for (const d of days ?? []) {
    if (!d.isClosed && d.opensAt && d.closesAt) {
      rows[d.dayOfWeek] = { open: true, opensAt: d.opensAt, closesAt: d.closesAt };
    }
  }
  return rows;
}

function OpeningHours({ branchId, canWrite }: { branchId: string; canWrite: boolean }) {
  const t = useT();
  const hours = useBusinessHours(branchId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Opening hours')}</CardTitle>
        <CardDescription>
          {t(
            "Nothing can be booked outside these hours, whatever staff schedules say. Times are this branch's local time; a close before the open runs past midnight.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hours.isPending ? <Skeleton className="h-56 w-full" aria-busy="true" /> : null}
        {hours.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t('Could not load the opening hours.')} {t(errorText(hours.error))}
          </p>
        ) : null}
        {hours.data ? (
          <HoursForm
            key={JSON.stringify(hours.data.days)}
            branchId={branchId}
            initial={rowsFrom(hours.data.days)}
            canWrite={canWrite}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function HoursForm({
  branchId,
  initial,
  canWrite,
}: {
  branchId: string;
  initial: Record<number, HoursRow>;
  canWrite: boolean;
}) {
  const t = useT();
  const save = usePutBusinessHours(branchId);
  const [rows, setRows] = useState(initial);
  const [saved, setSaved] = useState(false);
  const change = (day: number, patch: Partial<HoursRow>) => {
    setSaved(false);
    setRows((r) => ({ ...r, [day]: { ...r[day]!, ...patch } }));
  };
  const invalid = WEEK_ORDER.filter((d) => rows[d]!.open && rows[d]!.opensAt === rows[d]!.closesAt);

  const submit = async () => {
    try {
      await save.mutateAsync({
        days: WEEK_ORDER.map((d) =>
          rows[d]!.open
            ? {
                dayOfWeek: d,
                isClosed: false,
                opensAt: rows[d]!.opensAt,
                closesAt: rows[d]!.closesAt,
              }
            : { dayOfWeek: d, isClosed: true },
        ),
      });
      setSaved(true);
    } catch {
      // Shown below.
    }
  };

  return (
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {WEEK_ORDER.map((d) => {
          const row = rows[d]!;
          const day = DAY_NAMES[d]!;
          return (
            <li key={d} className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex w-32 items-center gap-2">
                <input
                  type="checkbox"
                  checked={row.open}
                  aria-label={t('Open on {day}', { day })}
                  disabled={!canWrite}
                  onChange={(e) => change(d, { open: e.target.checked })}
                />
                {day}
              </label>
              {row.open ? (
                <>
                  <Input
                    type="time"
                    aria-label={t('{day} opens', { day })}
                    className="h-8 w-28"
                    value={row.opensAt}
                    disabled={!canWrite}
                    onChange={(e) => change(d, { opensAt: e.target.value })}
                  />
                  <span className="text-muted-foreground">{t('to')}</span>
                  <Input
                    type="time"
                    aria-label={t('{day} closes', { day })}
                    className="h-8 w-28"
                    value={row.closesAt}
                    disabled={!canWrite}
                    onChange={(e) => change(d, { closesAt: e.target.value })}
                  />
                </>
              ) : (
                <span className="text-muted-foreground">{t('Closed')}</span>
              )}
            </li>
          );
        })}
      </ul>
      {invalid.length > 0 ? (
        <p role="alert" className="text-destructive text-sm">
          {t('Opening and closing times cannot be the same (')}
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
            {t('Save opening hours')}
          </Button>
          {saved ? (
            <span role="status" className="text-muted-foreground text-sm">
              {t('Saved. Existing appointments are not moved.')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RemoveBranch({ branch }: { branch: Branch }) {
  const t = useT();
  const router = useRouter();
  const remove = useDeleteBranch();
  const [confirming, setConfirming] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Remove branch')}</CardTitle>
        <CardDescription>
          {t(
            'For a branch that has closed for good. To pause bookings, set the status to Temporarily closed instead.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(branch.id, { onSuccess: () => router.push('/settings') })
              }
            >
              {t('Yes, remove {name}', { name: branch.name })}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
              {t('Keep')}
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            {t('Remove branch')}
          </Button>
        )}
        {remove.error ? (
          <p role="alert" className="text-destructive w-full text-sm">
            {t(errorText(remove.error))}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
