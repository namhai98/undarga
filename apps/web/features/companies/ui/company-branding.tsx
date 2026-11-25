'use client';

import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { errorText } from '@/lib/form';
import type { CompanyBranding } from '@/services/company.service';
import { useCompanyBranding, useUpdateCompanyBranding } from '../api/use-company';
import { useT } from '@/lib/i18n';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * How the public booking page looks and reads: a headline under the name, a
 * short description, and the button colour. The logo is set on the Booking
 * page images screen.
 */
export function CompanyBrandingCard() {
  const t = useT();
  const branding = useCompanyBranding();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Booking page')}</CardTitle>
        <CardDescription>
          {t('What customers see at the top of your online booking page.')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {branding.isPending ? <Skeleton className="h-40 w-full" aria-busy="true" /> : null}
        {branding.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t('Could not load the booking page settings.')} {t(errorText(branding.error))}
          </p>
        ) : null}
        {branding.data ? (
          <BrandingForm key={JSON.stringify(branding.data)} branding={branding.data} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function BrandingForm({ branding }: { branding: CompanyBranding }) {
  const t = useT();
  const canWrite = useCan('company:write');
  const update = useUpdateCompanyBranding();
  const [headline, setHeadline] = useState(branding.bookingPageHeadline ?? '');
  const [blurb, setBlurb] = useState(branding.bookingPageBlurb ?? '');
  const [primary, setPrimary] = useState(branding.primaryColor);
  const [accent, setAccent] = useState(branding.accentColor);
  const [saved, setSaved] = useState(false);
  const badColour = !HEX.test(primary) || !HEX.test(accent);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    update.mutate(
      {
        bookingPageHeadline: headline.trim() || null,
        bookingPageBlurb: blurb.trim() || null,
        primaryColor: primary,
        accentColor: accent,
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="grid gap-1.5">
        <Label htmlFor="brand-headline">{t('Headline')}</Label>
        <Input
          id="brand-headline"
          maxLength={160}
          placeholder={t('e.g. Hair and beauty in the heart of the city')}
          value={headline}
          disabled={!canWrite}
          onChange={(e) => setHeadline(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="brand-blurb">{t('Description')}</Label>
        <textarea
          id="brand-blurb"
          maxLength={1000}
          rows={3}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 rounded-lg border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3"
          value={blurb}
          disabled={!canWrite}
          onChange={(e) => setBlurb(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-4">
        {(
          [
            ['brand-primary', 'Button colour', primary, setPrimary],
            ['brand-accent', 'Accent colour', accent, setAccent],
          ] as const
        ).map(([id, label, value, set]) => (
          <div key={id} className="grid gap-1.5">
            <Label htmlFor={id}>{label}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-hidden
                tabIndex={-1}
                className="h-8 w-10 rounded border"
                value={HEX.test(value) ? value : '#000000'}
                disabled={!canWrite}
                onChange={(e) => set(e.target.value)}
              />
              <Input
                id={id}
                className="h-8 w-28 font-mono"
                value={value}
                maxLength={7}
                disabled={!canWrite}
                onChange={(e) => set(e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>
      {badColour ? (
        <p role="alert" className="text-destructive text-sm">
          {t('Use a colour like #0F6B63.')}
        </p>
      ) : null}
      {update.error ? (
        <p role="alert" className="text-destructive text-sm">
          {t(errorText(update.error))}
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={update.isPending || badColour}>
            {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Save booking page')}
          </Button>
          {saved ? (
            <span role="status" className="text-muted-foreground text-sm">
              {t('Saved. Your booking page shows it now.')}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
