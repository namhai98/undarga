'use client';

import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorText } from '@/lib/form';
import type { BranchSettings } from '@/services/branches.service';
import { useBranchSettings, useUpdateBranchSettings } from '../api/use-branches';
import { useT } from '@/lib/i18n';

type Field = 'bookingLeadTimeMin' | 'maxAdvanceBookingDays' | 'cancellationWindowHours';

const FIELDS: Array<{ key: Field; label: string; min: number; max: number }> = [
  { key: 'bookingLeadTimeMin', label: 'Minimum notice (minutes)', min: 0, max: 10080 },
  { key: 'maxAdvanceBookingDays', label: 'Book up to (days ahead)', min: 1, max: 730 },
  {
    key: 'cancellationWindowHours',
    label: 'Cancellation deadline (hours before)',
    min: 0,
    max: 720,
  },
];

/**
 * Booking rules for this branch only. Blank means "use the company's rule";
 * a service's own rule still wins over both (service → branch → company).
 */
export function BranchRules({ branchId, canWrite }: { branchId: string; canWrite: boolean }) {
  const t = useT();
  const settings = useBranchSettings(branchId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Booking rules for this branch')}</CardTitle>
        <CardDescription>
          {t(
            "Leave a field blank to use the company's rule. A service's own rule still takes priority.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? <Skeleton className="h-24 w-full" aria-busy="true" /> : null}
        {settings.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t('Could not load the rules.')} {t(errorText(settings.error))}
          </p>
        ) : null}
        {settings.data ? (
          <RulesForm
            key={JSON.stringify(settings.data)}
            branchId={branchId}
            initial={settings.data}
            canWrite={canWrite}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RulesForm({
  branchId,
  initial,
  canWrite,
}: {
  branchId: string;
  initial: BranchSettings;
  canWrite: boolean;
}) {
  const t = useT();
  const save = useUpdateBranchSettings(branchId);
  const [values, setValues] = useState<Record<Field, string>>({
    bookingLeadTimeMin: initial.bookingLeadTimeMin?.toString() ?? '',
    maxAdvanceBookingDays: initial.maxAdvanceBookingDays?.toString() ?? '',
    cancellationWindowHours: initial.cancellationWindowHours?.toString() ?? '',
  });
  const [saved, setSaved] = useState(false);
  const invalid = FIELDS.filter(({ key, min, max }) => {
    const v = values[key].trim();
    if (!v) return false;
    const n = Number(v);
    return !Number.isInteger(n) || n < min || n > max;
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const input: Partial<BranchSettings> = {};
    for (const { key } of FIELDS) {
      const v = values[key].trim();
      input[key] = v ? Number(v) : null;
    }
    save.mutate(input, { onSuccess: () => setSaved(true) });
  };

  return (
    <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit}>
      {FIELDS.map(({ key, label, min, max }) => (
        <div key={key} className="grid gap-1.5">
          <Label htmlFor={`branch-rule-${key}`}>{label}</Label>
          <Input
            id={`branch-rule-${key}`}
            inputMode="numeric"
            placeholder={t('Company rule')}
            value={values[key]}
            disabled={!canWrite}
            onChange={(e) => {
              setSaved(false);
              setValues((v) => ({ ...v, [key]: e.target.value }));
            }}
          />
          <span className="text-muted-foreground text-xs">
            {min}–{max}
          </span>
        </div>
      ))}
      {invalid.length > 0 ? (
        <p role="alert" className="text-destructive text-sm sm:col-span-3">
          {t('Use a whole number in the range shown:')} {invalid.map((f) => f.label).join(', ')}.
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-destructive text-sm sm:col-span-3">
          {t(errorText(save.error))}
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" size="sm" disabled={save.isPending || invalid.length > 0}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Save branch rules')}
          </Button>
          {saved ? (
            <span role="status" className="text-muted-foreground text-sm">
              {t('Saved.')}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
