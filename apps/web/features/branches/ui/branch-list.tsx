'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useCompany } from '@/features/companies';
import { errorText, selectClass } from '@/lib/form';
import { timezoneOptions } from '@/lib/timezones';
import type { BranchStatus } from '@/services/branches.service';
import { useBranches, useCreateBranch } from '../api/use-branches';
import { useT } from '@/lib/i18n';

export const BRANCH_STATUS_LABEL: Record<BranchStatus, string> = {
  ACTIVE: 'Open',
  TEMPORARILY_CLOSED: 'Temporarily closed',
  INACTIVE: 'Inactive',
};

/** Every branch, and the way to add one. Each opens its own page. */
export function BranchList() {
  const t = useT();
  const branches = useBranches();
  const canWrite = useCan('branch:write');
  const [adding, setAdding] = useState(false);
  const items = branches.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Branches')}</CardTitle>
        <CardDescription>
          {t('Where appointments happen. Each has its own address, time zone and opening hours.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {branches.isPending ? <Skeleton className="h-16 w-full" aria-busy="true" /> : null}
        {branches.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t('Could not load branches.')} {t(errorText(branches.error))}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="divide-border/40 grid divide-y">
            {items.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div className="grid">
                  <Link href={`/settings/branches/${b.id}`} className="font-medium hover:underline">
                    {b.name}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {[b.addressLine1, b.city].filter(Boolean).join(', ') || t('No address')} ·{' '}
                    {b.timezoneName}
                  </span>
                </div>
                <Badge variant={b.status === 'ACTIVE' ? 'default' : 'secondary'}>
                  {t(BRANCH_STATUS_LABEL[b.status])}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {canWrite ? (
          adding ? (
            <AddBranchForm onCancel={() => setAdding(false)} />
          ) : (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
                {t('Add branch')}
              </Button>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function AddBranchForm({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const router = useRouter();
  const company = useCompany();
  const create = useCreateBranch();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [timezone, setTimezone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const zone = timezone || company.data?.defaultTimezoneName || 'Asia/Ulaanbaatar';
  const zones = timezoneOptions();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const branch = await create.mutateAsync({
        name: name.trim(),
        code: code.trim().toUpperCase(),
        timezoneName: zone,
        ...(addressLine1.trim() ? { addressLine1: addressLine1.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
      });
      router.push(`/settings/branches/${branch.id}`);
    } catch {
      // Shown below.
    }
  };

  return (
    <form
      aria-label={t('Add branch')}
      className="border-border/60 grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
      onSubmit={(e) => void submit(e)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="new-branch-name">{t('Branch name')}</Label>
        <Input
          id="new-branch-name"
          value={name}
          required
          maxLength={128}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-branch-code">{t('Short code')}</Label>
        <Input
          id="new-branch-code"
          value={code}
          required
          maxLength={24}
          pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
          placeholder={t('e.g. CENTRAL')}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-branch-address">{t('Address')}</Label>
        <Input
          id="new-branch-address"
          value={addressLine1}
          maxLength={160}
          onChange={(e) => setAddressLine1(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-branch-city">{t('City')}</Label>
        <Input
          id="new-branch-city"
          value={city}
          maxLength={96}
          onChange={(e) => setCity(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-branch-timezone">{t('Time zone')}</Label>
        <select
          id="new-branch-timezone"
          className={selectClass}
          value={zone}
          onChange={(e) => setTimezone(e.target.value)}
        >
          {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
      {create.error ? (
        <p role="alert" className="text-destructive text-sm sm:col-span-2">
          {t(errorText(create.error, 'Could not add the branch. Please try again.'))}
        </p>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={create.isPending || !name.trim() || !code.trim()}>
          {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Add and set hours')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}
