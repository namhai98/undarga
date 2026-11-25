'use client';

import { decimalToMinorString, minorToDecimalString } from '@undarga/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { useCan, useSession } from '@/features/auth';
import { useCompany } from '@/features/companies';
import { ImageUpload } from '@/features/media';
import { useZodForm } from '@/hooks/use-zod-form';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type { CatalogStatus, ServiceInput } from '@/services/catalog.service';
import {
  catalogKeys,
  useCreateService,
  useDeleteService,
  useService,
  useServiceCategories,
  useUpdateService,
} from '../api/use-catalog';
import { plainT, useT } from '@/lib/i18n';

/**
 * Everything arrives from `FormData` as a string, so the schema coerces and the
 * component never keeps a parallel controlled copy.
 *
 * Duration and buffers are whole minutes — the same bounds the API enforces, so
 * a mistake is caught before a round trip, and the API still rejects it if this
 * were bypassed (`docs/ARCHITECTURE-RULES.md`, rule 3).
 */
const formSchema = z.object({
  name: z.string().trim().min(1, 'Give the service a name.').max(160),
  code: z.string().trim().max(24),
  description: z.string().trim().max(2000),
  categoryId: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']),
  isOnlineBookable: z.string().optional(),
  durationMin: z.coerce
    .number({ invalid_type_error: 'Enter a whole number of minutes.' })
    .int('Enter a whole number of minutes.')
    .min(1, 'A service must last at least a minute.')
    .max(1440, 'A single service cannot run longer than a day.'),
  bufferBeforeMin: z.coerce.number().int().min(0).max(480),
  bufferAfterMin: z.coerce.number().int().min(0).max(480),
  /** Major units as typed. Converted to minor units below, never parsed as a float. */
  price: z.string().trim().min(1, 'Enter a price. Use 0 for a free service.'),
  requiresEmployee: z.string().optional(),
  requiresResource: z.string().optional(),
  sortOrder: z.coerce.number().int().min(0).max(32767),
  // Optional overrides: empty means "use the company's rule".
  bookingLeadTimeMin: optionalInt(0, 43_200),
  maxAdvanceBookingDays: optionalInt(1, 730),
  cancellationWindowHours: optionalInt(0, 720),
  maxConcurrentBookings: optionalInt(1, 500),
});

function optionalInt(min: number, max: number) {
  return z
    .string()
    .trim()
    .refine((v) => v === '' || (/^d+$/.test(v) && Number(v) >= min && Number(v) <= max), {
      message: plainT('Leave empty, or a whole number from {min} to {max}.', { min, max }),
    })
    .transform((v) => (v === '' ? null : Number(v)));
}

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Create or edit one service.
 *
 * `serviceId === null` means create. The same fields either way — a separate
 * create form and edit form is two places to add the next column to, and they
 * drift.
 */
export function ServiceForm({
  serviceId,
  onDone,
  onCancel,
}: {
  serviceId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [formError, setFormError] = useState<string | null>(null);
  const { errors, onSubmit, applyServerErrors, setErrors } = useZodForm(formSchema);

  const company = useCompany();
  const categories = useServiceCategories();
  const existing = useService(serviceId);

  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  const canWriteImage = useCan('service:write');

  const create = useCreateService();
  const update = useUpdateService(serviceId ?? '');
  const remove = useDeleteService();

  const currencyCode = company.data?.currencyCode ?? 'MNT';
  const format = currencyFormat(currencyCode);
  const service = existing.data;
  const pending = create.isPending || update.isPending || remove.isPending;

  if (serviceId && existing.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t('Loading the service…')}</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const handle = onSubmit(async (values) => {
    setFormError(null);

    // Major units to minor as a STRING operation. `Number(price) * 100` would
    // be shorter and would round a large amount — the one value that must not.
    const priceMinor = decimalToMinorString(values.price, format.minorUnit);
    if (priceMinor === null || priceMinor.startsWith('-')) {
      setErrors({
        price:
          format.minorUnit === 0
            ? 'Enter a whole amount.'
            : t('Enter an amount with at most {minorUnit} decimal places.', {
                minorUnit: format.minorUnit,
              }),
      });
      return;
    }

    const input: ServiceInput = {
      name: values.name,
      code: values.code || null,
      description: values.description || null,
      categoryId: values.categoryId || null,
      status: values.status as CatalogStatus,
      isOnlineBookable: values.isOnlineBookable === 'on',
      durationMin: values.durationMin,
      bufferBeforeMin: values.bufferBeforeMin,
      bufferAfterMin: values.bufferAfterMin,
      priceMinor,
      requiresEmployee: values.requiresEmployee === 'on',
      requiresResource: values.requiresResource === 'on',
      sortOrder: values.sortOrder,
      bookingLeadTimeMin: values.bookingLeadTimeMin,
      maxAdvanceBookingDays: values.maxAdvanceBookingDays,
      cancellationWindowHours: values.cancellationWindowHours,
      maxConcurrentBookings: values.maxConcurrentBookings,
    };

    try {
      if (serviceId) {
        await update.mutateAsync(input);
      } else {
        await create.mutateAsync(input);
      }
      onDone();
    } catch (error) {
      if (applyServerErrors(error)) return;
      setFormError(
        error instanceof ApiError
          ? error.message
          : t('Could not save the service. Please try again.'),
      );
    }
  });

  const handleDelete = async () => {
    if (!serviceId) return;
    setFormError(null);
    try {
      await remove.mutateAsync(serviceId);
      onDone();
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : t('Could not remove the service.'));
    }
  };

  return (
    <form onSubmit={handle} className="grid max-w-2xl gap-5" noValidate>
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">
          {serviceId ? t('Edit service') : t('New service')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t('Prices are in {currencyCode}, the company currency.', { currencyCode })}
        </p>
      </header>

      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not save')}</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      {serviceId && service ? (
        // Saved straight away, independent of the form's Save button.
        <ImageUpload
          purpose="SERVICE_IMAGE"
          targetId={serviceId}
          fileId={service.imageFileId}
          label={t('Service image')}
          hint={t('Shown on your booking page. JPEG, PNG or WebP, at least 200 × 200 pixels.')}
          shape="wide"
          canEdit={canWriteImage}
          onChange={() => {
            if (activeCompanyId)
              void queryClient.invalidateQueries({
                queryKey: catalogKeys.services(activeCompanyId),
              });
          }}
        />
      ) : null}

      <Field id="name" label={t('Name')} error={errors.name}>
        <Input id="name" name="name" defaultValue={service?.name ?? ''} required maxLength={160} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="code"
          label={t('Code')}
          hint={t('Optional. Your own reference, unique in this company.')}
          error={errors.code}
        >
          <Input
            id="code"
            name="code"
            defaultValue={service?.code ?? ''}
            maxLength={24}
            placeholder={t('CUT-60')}
            className="font-mono"
          />
        </Field>

        <Field id="categoryId" label={t('Category')} error={errors.categoryId}>
          <select
            id="categoryId"
            name="categoryId"
            defaultValue={service?.categoryId ?? ''}
            className={selectClass}
          >
            <option value="">{t('Uncategorised')}</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {/* The em dash is the nesting: the API caps it at one level. */}
                {category.parentId ? '— ' : ''}
                {category.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        id="description"
        label={t('Description')}
        hint={t('Shown to customers.')}
        error={errors.description}
      >
        <textarea
          id="description"
          name="description"
          defaultValue={service?.description ?? ''}
          rows={3}
          maxLength={2000}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3"
        />
      </Field>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">{t('Time')}</legend>

        <Field id="durationMin" label={t('Duration')} error={errors.durationMin}>
          <div className="flex items-center gap-2">
            <Input
              id="durationMin"
              name="durationMin"
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              step={1}
              required
              defaultValue={service?.durationMin ?? 60}
              className="w-24"
            />
            <span className="text-muted-foreground text-sm">{t('minutes')}</span>
          </div>
        </Field>

        <Field
          id="bufferBeforeMin"
          label={t('Buffer before')}
          hint={t('Setup time.')}
          error={errors.bufferBeforeMin}
        >
          <div className="flex items-center gap-2">
            <Input
              id="bufferBeforeMin"
              name="bufferBeforeMin"
              type="number"
              inputMode="numeric"
              min={0}
              max={480}
              step={1}
              defaultValue={service?.bufferBeforeMin ?? 0}
              className="w-24"
            />
            <span className="text-muted-foreground text-sm">{t('minutes')}</span>
          </div>
        </Field>

        <Field
          id="bufferAfterMin"
          label={t('Buffer after')}
          hint={t('Clean-up time.')}
          error={errors.bufferAfterMin}
        >
          <div className="flex items-center gap-2">
            <Input
              id="bufferAfterMin"
              name="bufferAfterMin"
              type="number"
              inputMode="numeric"
              min={0}
              max={480}
              step={1}
              defaultValue={service?.bufferAfterMin ?? 0}
              className="w-24"
            />
            <span className="text-muted-foreground text-sm">{t('minutes')}</span>
          </div>
        </Field>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="price"
          label={t('Price ({currencyCode})', { currencyCode })}
          error={errors.price}
        >
          <Input
            id="price"
            name="price"
            inputMode="decimal"
            required
            defaultValue={service ? minorToDecimalString(service.priceMinor, format.minorUnit) : ''}
            placeholder={format.minorUnit === 0 ? '50000' : '50000.00'}
            className="tabular-nums"
          />
        </Field>

        <Field
          id="sortOrder"
          label={t('Sort order')}
          hint={t('Lower comes first on the booking page.')}
          error={errors.sortOrder}
        >
          <Input
            id="sortOrder"
            name="sortOrder"
            type="number"
            inputMode="numeric"
            min={0}
            max={32767}
            step={1}
            defaultValue={service?.sortOrder ?? 0}
            className="w-24"
          />
        </Field>
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium">{t('Availability')}</legend>

        <Field
          id="status"
          label={t('Status')}
          hint={t('Whether it can be booked at all.')}
          error={errors.status}
        >
          <select
            id="status"
            name="status"
            defaultValue={service?.status ?? 'ACTIVE'}
            className={`${selectClass} sm:w-48`}
          >
            <option value="DRAFT">{t('Draft')}</option>
            <option value="ACTIVE">{t('Active')}</option>
            <option value="INACTIVE">{t('Inactive')}</option>
            <option value="ARCHIVED">{t('Archived')}</option>
          </select>
        </Field>

        {/* Distinct from status on purpose: an internal-only service is ACTIVE
            and unlisted — reception can book it, the public cannot see it. */}
        <Checkbox
          name="isOnlineBookable"
          label={t('Show on the public booking site')}
          hint={t(
            'Uncheck for internal-only work. Staff can still book it while the status is active.',
          )}
          defaultChecked={service?.isOnlineBookable ?? true}
        />
        <Checkbox
          name="requiresEmployee"
          label={t('Requires a member of staff')}
          defaultChecked={service?.requiresEmployee ?? true}
        />
        <Checkbox
          name="requiresResource"
          label={t('Requires a room or equipment')}
          defaultChecked={service?.requiresResource ?? false}
        />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">{t('Booking rules for this service')}</legend>
        <p className="text-muted-foreground -mt-1 text-xs sm:col-span-2">
          {t('Leave a field empty to use the company’s booking rules.')}
        </p>
        <RuleField
          name="bookingLeadTimeMin"
          label={t('Minimum notice')}
          unit="minutes"
          value={service?.bookingRules?.bookingLeadTimeMin}
          error={errors.bookingLeadTimeMin}
        />
        <RuleField
          name="maxAdvanceBookingDays"
          label={t('Book up to')}
          unit="days ahead"
          value={service?.bookingRules?.maxAdvanceBookingDays}
          error={errors.maxAdvanceBookingDays}
        />
        <RuleField
          name="cancellationWindowHours"
          label={t('Cancellation deadline')}
          unit="hours before"
          value={service?.bookingRules?.cancellationWindowHours}
          error={errors.cancellationWindowHours}
        />
        <RuleField
          name="maxConcurrentBookings"
          label={t('At most at the same time')}
          unit="bookings per branch"
          hint={t('Across all staff, e.g. limited equipment or a capped class.')}
          value={service?.bookingRules?.maxConcurrentBookings}
          error={errors.maxConcurrentBookings}
        />
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {serviceId ? t('Save changes') : t('Create service')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {t('Cancel')}
        </Button>
        {serviceId ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive ml-auto"
            onClick={() => void handleDelete()}
            disabled={pending}
          >
            {/* Soft delete: appointment history keeps resolving. */}
            {t('Remove service')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Field({
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
  children: React.ReactNode;
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

function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={name}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        className="border-input accent-primary mt-0.5 size-4 rounded"
      />
      <div className="grid gap-0.5">
        <Label htmlFor={name} className="font-normal">
          {label}
        </Label>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
    </div>
  );
}

function RuleField(props: {
  name: string;
  label: string;
  unit: string;
  hint?: string;
  value: number | null | undefined;
  error?: string;
}) {
  const t = useT();
  return (
    <Field id={props.name} label={props.label} hint={props.hint} error={props.error}>
      <div className="flex items-center gap-2">
        <Input
          id={props.name}
          name={props.name}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder={t('Default')}
          defaultValue={props.value ?? ''}
          className="w-28"
        />
        <span className="text-muted-foreground text-sm">{props.unit}</span>
      </div>
    </Field>
  );
}
