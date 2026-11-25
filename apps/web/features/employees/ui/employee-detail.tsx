'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useServices } from '@/features/catalog';
import type { EmployeeDetail as Detail, EmployeeStatus } from '@/services/employees.service';
import {
  useDeleteEmployee,
  useEmployee,
  useEmployeeBranchAssignment,
  useEmployeeServiceAssignment,
  useUpdateEmployee,
} from '../api/use-employees';
import { EmployeeExceptions } from './employee-exceptions';
import { EmployeeLogin } from './employee-login';
import { EmployeeSchedule } from './employee-schedule';
import { STATUS_LABEL, errorText, selectClass } from './shared';
import { useT } from '@/lib/i18n';

/**
 * One member of staff: details, where they work, what they do, and when.
 *
 * Without branches, services and working hours an employee is never offered
 * a slot — this screen is where a new person becomes bookable.
 */
export function EmployeeDetail({ employeeId }: { employeeId: string }) {
  const t = useT();
  const employee = useEmployee(employeeId);
  const canWrite = useCan('employee:write');

  if (employee.isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">{t('Loading…')}</span>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (employee.error || !employee.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{t('Staff member not found')}</AlertTitle>
        <AlertDescription>
          {t('They may have been removed, or you may not have access.')}{' '}
          <Link href="/staff" className="underline">
            {t('Back to staff')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const data = employee.data;
  const bookable =
    data.status === 'ACTIVE' &&
    data.isBookable &&
    data.branches.length > 0 &&
    data.services.length > 0;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link
          href="/staff"
          className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> {t('Staff')}
        </Link>
        <h1 className="text-xl font-semibold">{data.displayName}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge variant={data.status === 'ACTIVE' ? 'default' : 'secondary'}>
            {t(STATUS_LABEL[data.status])}
          </Badge>
          {bookable ? null : (
            <Badge variant="secondary">
              {t('Not bookable yet — needs a branch, a service and working hours')}
            </Badge>
          )}
        </div>
      </div>

      <DetailsCard employee={data} canWrite={canWrite} />
      <BranchesCard employee={data} canWrite={canWrite} />
      <ServicesCard employee={data} canWrite={canWrite} />
      <EmployeeSchedule employee={data} canWrite={canWrite} />
      <EmployeeExceptions employeeId={data.id} canWrite={canWrite} />
      <EmployeeLogin employee={data} />
      {canWrite ? <RemoveCard employee={data} /> : null}
    </div>
  );
}

function DetailsCard({ employee, canWrite }: { employee: Detail; canWrite: boolean }) {
  const t = useT();
  const update = useUpdateEmployee(employee.id);
  const [displayName, setDisplayName] = useState(employee.displayName);
  const [jobTitle, setJobTitle] = useState(employee.publicProfile.jobTitle ?? '');
  const [phone, setPhone] = useState(employee.privateProfile.phone ?? '');
  const [status, setStatus] = useState<EmployeeStatus>(employee.status);
  const [isBookable, setIsBookable] = useState(employee.isBookable);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    try {
      await update.mutateAsync({
        displayName: displayName.trim(),
        status,
        isBookable,
        profile: { jobTitle: jobTitle.trim() || null, phone: phone.trim() || null },
      });
      setSaved(true);
    } catch {
      // Shown below from update.error.
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Details')}</CardTitle>
        <CardDescription>{t('The name and title appear on your booking page.')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void submit(e)}>
          <div className="grid gap-1.5">
            <Label htmlFor="emp-name">{t('Name')}</Label>
            <Input
              id="emp-name"
              value={displayName}
              maxLength={128}
              required
              disabled={!canWrite}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="emp-title">{t('Job title')}</Label>
            <Input
              id="emp-title"
              value={jobTitle}
              maxLength={96}
              disabled={!canWrite}
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="emp-phone">{t('Work phone')}</Label>
            <Input
              id="emp-phone"
              value={phone}
              maxLength={32}
              disabled={!canWrite}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="emp-status">{t('Status')}</Label>
            <select
              id="emp-status"
              className={selectClass}
              value={status}
              disabled={!canWrite}
              onChange={(e) => setStatus(e.target.value as EmployeeStatus)}
            >
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={isBookable}
              disabled={!canWrite}
              onChange={(e) => setIsBookable(e.target.checked)}
            />
            {t('Customers can book with this person')}
          </label>
          {update.error ? (
            <p role="alert" className="text-destructive text-sm sm:col-span-2">
              {t(errorText(update.error))}
            </p>
          ) : null}
          {canWrite ? (
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" size="sm" disabled={update.isPending || !displayName.trim()}>
                {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('Save details')}
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

function BranchesCard({ employee, canWrite }: { employee: Detail; canWrite: boolean }) {
  const t = useT();
  const branches = useBranches();
  const { assign, remove } = useEmployeeBranchAssignment(employee.id);
  const [choice, setChoice] = useState('');
  const assigned = new Set(employee.branches.map((b) => b.branchId));
  const available = (branches.data?.items ?? []).filter((b) => !assigned.has(b.id));
  const error = assign.error ?? remove.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Branches')}</CardTitle>
        <CardDescription>
          {t('Where this person works. Working hours are set per branch.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {employee.branches.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('No branch yet.')}</p>
        ) : (
          <ul className="grid gap-2">
            {employee.branches.map((b) => (
              <li key={b.branchId} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {b.name ?? b.branchId}
                  {b.isPrimary ? (
                    <Badge variant="secondary" className="ml-2">
                      {t('Primary')}
                    </Badge>
                  ) : null}
                </span>
                {canWrite ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    aria-label={t('Remove {value}', { value: b.name ?? t('branch') })}
                    onClick={() => remove.mutate(b.branchId)}
                  >
                    {t('Remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite && available.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="emp-add-branch">{t('Add a branch')}</Label>
              <select
                id="emp-add-branch"
                className={selectClass}
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">{t('Select…')}</option>
                {available.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!choice || assign.isPending}
              onClick={() =>
                assign.mutate({ branchId: choice }, { onSuccess: () => setChoice('') })
              }
            >
              {t('Add')}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(errorText(error))}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ServicesCard({ employee, canWrite }: { employee: Detail; canWrite: boolean }) {
  const t = useT();
  const services = useServices({ limit: 100 });
  const { assign, remove } = useEmployeeServiceAssignment(employee.id);
  const [choice, setChoice] = useState('');
  const assigned = new Set(employee.services.map((s) => s.serviceId));
  const available = (services.data?.items ?? []).filter((s) => !assigned.has(s.id));
  const error = assign.error ?? remove.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Services')}</CardTitle>
        <CardDescription>{t('What customers can book with this person.')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {employee.services.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('No services yet.')}</p>
        ) : (
          <ul className="grid gap-2">
            {employee.services.map((s) => (
              <li key={s.serviceId} className="flex items-center justify-between gap-3 text-sm">
                <span>{s.name ?? s.serviceId}</span>
                {canWrite ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    aria-label={t('Remove {value}', { value: s.name ?? t('service') })}
                    onClick={() => remove.mutate(s.serviceId)}
                  >
                    {t('Remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite && available.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="emp-add-service">{t('Add a service')}</Label>
              <select
                id="emp-add-service"
                className={selectClass}
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">{t('Select…')}</option>
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!choice || assign.isPending}
              onClick={() => assign.mutate(choice, { onSuccess: () => setChoice('') })}
            >
              {t('Add')}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(errorText(error))}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RemoveCard({ employee }: { employee: Detail }) {
  const t = useT();
  const router = useRouter();
  const remove = useDeleteEmployee();
  const [confirming, setConfirming] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Remove from staff')}</CardTitle>
        <CardDescription>
          {t('They stop being bookable. Past appointments keep their name; nothing is deleted.')}
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
              onClick={() => remove.mutate(employee.id, { onSuccess: () => router.push('/staff') })}
            >
              {t('Yes, remove {displayName}', { displayName: employee.displayName })}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
              {t('Keep')}
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            {t('Remove from staff')}
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
