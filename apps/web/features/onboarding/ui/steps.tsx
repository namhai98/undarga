'use client';

import { Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useSlugAvailability } from '../api/use-onboarding';
import {
  CURRENCIES,
  DAY_NAMES,
  slugify,
  timezoneOptions,
  type Draft,
  type ServiceRow,
  type StepErrors,
} from '../model/draft';
import { useT } from '@/lib/i18n';

export const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

type Update = (change: (draft: Draft) => Draft) => void;

// ---------------------------------------------------------------------------
// Step 1 — Company
// ---------------------------------------------------------------------------

export function CompanyStep({
  draft,
  update,
  errors,
  slugEditable,
}: {
  draft: Draft;
  update: Update;
  errors: StepErrors;
  slugEditable: boolean;
}) {
  const t = useT();
  const slug = useDebounced(draft.company.slug, 400);
  const availability = useSlugAvailability(slugEditable ? slug : '');

  return (
    <div className="grid gap-4">
      <Field id="displayName" label={t('Company name')} error={errors.displayName}>
        <Input
          id="displayName"
          value={draft.company.displayName}
          maxLength={160}
          autoFocus
          placeholder={t('Nomin Spa')}
          onChange={(e) => {
            const displayName = e.target.value;
            update((d) => ({
              ...d,
              company: {
                ...d.company,
                displayName,
                // Follows the name until the owner types an identifier of their own.
                slug: d.company.slugEdited || !slugEditable ? d.company.slug : slugify(displayName),
              },
            }));
          }}
        />
      </Field>

      <Field
        id="legalName"
        label={t('Legal name')}
        hint={t('Optional. The registered name, if different.')}
        error={errors.legalName}
      >
        <Input
          id="legalName"
          value={draft.company.legalName}
          maxLength={160}
          onChange={(e) =>
            update((d) => ({ ...d, company: { ...d.company, legalName: e.target.value } }))
          }
        />
      </Field>

      <Field
        id="slug"
        label={t('Company identifier')}
        hint={
          slugEditable
            ? 'Used in your booking page address. Lowercase letters, digits and hyphens.'
            : 'Set when your company was created; it cannot be changed here.'
        }
        error={errors.slug}
      >
        <Input
          id="slug"
          value={draft.company.slug}
          maxLength={64}
          readOnly={!slugEditable}
          className="font-mono"
          onChange={(e) =>
            update((d) => ({
              ...d,
              company: { ...d.company, slug: e.target.value.toLowerCase(), slugEdited: true },
            }))
          }
        />
      </Field>
      {slugEditable && !errors.slug && slug.length >= 3 ? (
        <p className="text-xs" aria-live="polite">
          {availability.isFetching ? (
            <span className="text-muted-foreground">{t('Checking…')}</span>
          ) : availability.data?.available ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              <Check aria-hidden className="mr-1 inline size-3" />
              {t('Available')}
            </span>
          ) : availability.data ? (
            <span className="text-destructive">{availability.data.reason}</span>
          ) : null}
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">
        {t('A logo can be added later; image uploads are not available yet.')}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Branch
// ---------------------------------------------------------------------------

export function BranchStep({
  draft,
  update,
  errors,
}: {
  draft: Draft;
  update: Update;
  errors: StepErrors;
}) {
  const t = useT();
  const zones = useMemo(() => timezoneOptions(), []);
  const set = (field: keyof Draft['branch']) => (value: string) =>
    update((d) => ({ ...d, branch: { ...d.branch, [field]: value } }));

  return (
    <div className="grid gap-4">
      <Field id="branchName" label={t('Branch name')} error={errors.branchName}>
        <Input
          id="branchName"
          value={draft.branch.name}
          maxLength={128}
          autoFocus
          onChange={(e) => set('name')(e.target.value)}
        />
      </Field>

      <Field
        id="addressLine1"
        label={t('Address')}
        hint={t('Optional.')}
        error={errors.addressLine1}
      >
        <Input
          id="addressLine1"
          value={draft.branch.addressLine1}
          maxLength={160}
          placeholder={t('Street and number')}
          onChange={(e) => set('addressLine1')(e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="addressLine2"
          label={t('Address line 2')}
          hint={t('Optional.')}
          error={errors.addressLine2}
        >
          <Input
            id="addressLine2"
            value={draft.branch.addressLine2}
            maxLength={160}
            onChange={(e) => set('addressLine2')(e.target.value)}
          />
        </Field>
        <Field id="city" label={t('City')} hint={t('Optional.')} error={errors.city}>
          <Input
            id="city"
            value={draft.branch.city}
            maxLength={96}
            onChange={(e) => set('city')(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="branchPhone" label={t('Phone')} hint={t('Optional.')} error={errors.branchPhone}>
          <Input
            id="branchPhone"
            type="tel"
            value={draft.branch.phone}
            maxLength={32}
            placeholder="+976 9911 2233"
            onChange={(e) => set('phone')(e.target.value)}
          />
        </Field>
        <Field
          id="timezoneName"
          label={t('Timezone')}
          hint={t('Bookings at this branch use this timezone.')}
          error={errors.timezoneName}
        >
          <select
            id="timezoneName"
            className={selectClass}
            value={draft.branch.timezoneName}
            onChange={(e) => set('timezoneName')(e.target.value)}
          >
            {zones.includes(draft.branch.timezoneName) ? null : (
              <option value={draft.branch.timezoneName}>{draft.branch.timezoneName}</option>
            )}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Business settings
// ---------------------------------------------------------------------------

export function BusinessStep({
  draft,
  update,
  errors,
}: {
  draft: Draft;
  update: Update;
  errors: StepErrors;
}) {
  const t = useT();
  const set =
    (
      field: 'currencyCode' | 'contactEmail' | 'contactPhone' | 'registrationNumber' | 'taxNumber',
    ) =>
    (value: string) =>
      update((d) => ({ ...d, business: { ...d.business, [field]: value } }));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="currencyCode"
          label={t('Currency')}
          hint={t('Prices and reports use this currency.')}
          error={errors.currencyCode}
        >
          <select
            id="currencyCode"
            className={selectClass}
            value={draft.business.currencyCode}
            onChange={(e) => set('currencyCode')(e.target.value)}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="contactEmail"
          label={t('Contact email')}
          hint={t('Optional.')}
          error={errors.contactEmail}
        >
          <Input
            id="contactEmail"
            type="email"
            value={draft.business.contactEmail}
            maxLength={320}
            onChange={(e) => set('contactEmail')(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="contactPhone"
          label={t('Contact phone')}
          hint={t('Optional.')}
          error={errors.contactPhone}
        >
          <Input
            id="contactPhone"
            type="tel"
            value={draft.business.contactPhone}
            maxLength={32}
            onChange={(e) => set('contactPhone')(e.target.value)}
          />
        </Field>
        <Field
          id="registrationNumber"
          label={t('Registration no.')}
          hint={t('Optional.')}
          error={errors.registrationNumber}
        >
          <Input
            id="registrationNumber"
            value={draft.business.registrationNumber}
            maxLength={64}
            onChange={(e) => set('registrationNumber')(e.target.value)}
          />
        </Field>
        <Field id="taxNumber" label={t('Tax no.')} hint={t('Optional.')} error={errors.taxNumber}>
          <Input
            id="taxNumber"
            value={draft.business.taxNumber}
            maxLength={64}
            onChange={(e) => set('taxNumber')(e.target.value)}
          />
        </Field>
      </div>

      <fieldset className="border-border/60 grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t('Opening hours')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.business.setHours}
            onChange={(e) =>
              update((d) => ({ ...d, business: { ...d.business, setHours: e.target.checked } }))
            }
          />
          {t('Set opening hours now')}
        </label>
        {draft.business.setHours ? (
          <ul className="grid gap-2">
            {draft.business.hours.map((row) => {
              const error = errors[`hours-${row.dayOfWeek}`];
              const change = (patch: Partial<typeof row>) =>
                update((d) => ({
                  ...d,
                  business: {
                    ...d.business,
                    hours: d.business.hours.map((h) =>
                      h.dayOfWeek === row.dayOfWeek ? { ...h, ...patch } : h,
                    ),
                  },
                }));
              const day = DAY_NAMES[row.dayOfWeek]!;
              return (
                <li key={row.dayOfWeek} className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex w-32 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={row.open}
                        aria-label={t('Open on {day}', { day })}
                        onChange={(e) => change({ open: e.target.checked })}
                      />
                      {day}
                    </label>
                    {row.open ? (
                      <>
                        <Input
                          type="time"
                          aria-label={t('{day} opens', { day })}
                          className="w-28"
                          value={row.opensAt}
                          onChange={(e) => change({ opensAt: e.target.value })}
                        />
                        <span className="text-muted-foreground">{t('to')}</span>
                        <Input
                          type="time"
                          aria-label={t('{day} closes', { day })}
                          className="w-28"
                          value={row.closesAt}
                          onChange={(e) => change({ closesAt: e.target.value })}
                        />
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t('Closed')}</span>
                    )}
                  </div>
                  {error ? (
                    <p role="alert" className="text-destructive text-xs">
                      {day}: {error}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t('Optional. You can set or change hours per branch at any time.')}
          </p>
        )}
      </fieldset>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Services
// ---------------------------------------------------------------------------

export function ServicesStep({
  rows,
  setRows,
  errors,
  currencyCode,
  nextKey,
}: {
  rows: ServiceRow[];
  setRows: (rows: ServiceRow[]) => void;
  errors: StepErrors;
  currencyCode: string;
  nextKey: () => number;
}) {
  const t = useT();
  const change = (key: number, patch: Partial<ServiceRow>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div className="grid gap-4">
      {rows.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{t('No services yet')}</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('Add what customers can book, or skip this and add them later.')}
          </p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row, index) => (
            <li key={row.key} className="border-border/60 grid gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t('Service')} {index + 1}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('Remove service {value}', { value: index + 1 })}
                  onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={`service-${row.key}-name`}
                  label={t('Name')}
                  error={errors[`service-${row.key}-name`]}
                >
                  <Input
                    id={`service-${row.key}-name`}
                    value={row.name}
                    maxLength={160}
                    placeholder={t('Haircut')}
                    onChange={(e) => change(row.key, { name: e.target.value })}
                  />
                </Field>
                <Field
                  id={`service-${row.key}-category`}
                  label={t('Category')}
                  hint={t('Optional.')}
                >
                  <Input
                    id={`service-${row.key}-category`}
                    value={row.category}
                    maxLength={128}
                    placeholder={t('Hair')}
                    onChange={(e) => change(row.key, { category: e.target.value })}
                  />
                </Field>
                <Field
                  id={`service-${row.key}-duration`}
                  label={t('Duration (minutes)')}
                  error={errors[`service-${row.key}-duration`]}
                >
                  <Input
                    id={`service-${row.key}-duration`}
                    type="number"
                    inputMode="numeric"
                    min={5}
                    max={1440}
                    step={5}
                    value={row.durationMin}
                    onChange={(e) => change(row.key, { durationMin: e.target.value })}
                  />
                </Field>
                <Field
                  id={`service-${row.key}-price`}
                  label={t('Price ({currencyCode})', { currencyCode })}
                  error={errors[`service-${row.key}-price`]}
                >
                  <Input
                    id={`service-${row.key}-price`}
                    inputMode="decimal"
                    value={row.price}
                    placeholder="35000"
                    onChange={(e) => change(row.key, { price: e.target.value })}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={row.isActive}
                  onChange={(e) => change(row.key, { isActive: e.target.checked })}
                />
                {t('Active — can be booked')}
              </label>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={rows.length >= 20}
        onClick={() =>
          setRows([
            ...rows,
            {
              key: nextKey(),
              name: '',
              category: '',
              durationMin: '60',
              price: '',
              isActive: true,
            },
          ])
        }
      >
        <Plus aria-hidden className="size-4" />
        {t('Add a service')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Pending({ children }: { children: ReactNode }) {
  return (
    <>
      <Loader2 className="animate-spin" aria-hidden />
      {children}
    </>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
