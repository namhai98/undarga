'use client';

import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { errorText, selectClass } from '@/lib/form';
import { timezoneOptions } from '@/lib/timezones';
import type { Company } from '@/services/company.service';
import { useCompany, useUpdateCompany } from '../api/use-company';
import { useT } from '@/lib/i18n';

/**
 * The company's own details: the name customers see, the legal name on
 * invoices, how to reach the business, and the default time zone new
 * branches start with. The booking-link identifier is fixed once created.
 */
export function CompanyDetails() {
  const t = useT();
  const company = useCompany();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Company')}</CardTitle>
        <CardDescription>
          {t('The name customers see on your booking page and in messages.')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {company.isPending ? <Skeleton className="h-40 w-full" aria-busy="true" /> : null}
        {company.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t('Could not load the company.')} {t(errorText(company.error))}
          </p>
        ) : null}
        {company.data ? <CompanyForm key={company.data.updatedAt} company={company.data} /> : null}
      </CardContent>
    </Card>
  );
}

function CompanyForm({ company }: { company: Company }) {
  const t = useT();
  const canWrite = useCan('company:write');
  const update = useUpdateCompany();
  const [form, setForm] = useState({
    displayName: company.displayName,
    legalName: company.legalName,
    registrationNumber: company.registrationNumber ?? '',
    taxNumber: company.taxNumber ?? '',
    contactEmail: company.contactEmail ?? '',
    contactPhone: company.contactPhone ?? '',
    defaultTimezoneName: company.defaultTimezoneName,
  });
  const [saved, setSaved] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const zones = timezoneOptions();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        displayName: form.displayName.trim(),
        legalName: form.legalName.trim(),
        registrationNumber: form.registrationNumber.trim() || null,
        taxNumber: form.taxNumber.trim() || null,
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        defaultTimezoneName: form.defaultTimezoneName,
      });
      setSaved(true);
    } catch {
      // Shown below.
    }
  };

  const field = (
    id: keyof typeof form,
    label: string,
    props: { type?: string; maxLength?: number; required?: boolean } = {},
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`company-${id}`}>{label}</Label>
      <Input
        id={`company-${id}`}
        value={form[id]}
        disabled={!canWrite}
        onChange={(e) => set(id)(e.target.value)}
        {...props}
      />
    </div>
  );

  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void submit(e)}>
      {field('displayName', 'Company name', { maxLength: 160, required: true })}
      {field('legalName', 'Legal name', { maxLength: 160, required: true })}
      {field('registrationNumber', 'Registration no.', { maxLength: 64 })}
      {field('taxNumber', 'Tax no.', { maxLength: 64 })}
      {field('contactEmail', 'Contact email', { type: 'email', maxLength: 320 })}
      {field('contactPhone', 'Contact phone', { maxLength: 32 })}
      <div className="grid gap-1.5">
        <Label htmlFor="company-defaultTimezoneName">{t('Default time zone')}</Label>
        <select
          id="company-defaultTimezoneName"
          className={selectClass}
          value={form.defaultTimezoneName}
          disabled={!canWrite}
          onChange={(e) => set('defaultTimezoneName')(e.target.value)}
        >
          {(zones.includes(form.defaultTimezoneName)
            ? zones
            : [form.defaultTimezoneName, ...zones]
          ).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">{t('Booking link')}</span>
        <span className="text-muted-foreground text-sm">
          {t('/book/{slug} — fixed once the company is created.', { slug: company.slug })}
        </span>
      </div>
      {update.error ? (
        <p role="alert" className="text-destructive text-sm sm:col-span-2">
          {t(errorText(update.error))}
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button
            type="submit"
            size="sm"
            disabled={update.isPending || !form.displayName.trim() || !form.legalName.trim()}
          >
            {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Save company')}
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
