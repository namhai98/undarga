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
import { useCompany } from '@/features/companies';
import { useZodForm } from '@/hooks/use-zod-form';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type { CatalogStatus, ServiceInput } from '@/services/catalog.service';
import {
  useCreateService,
  useDeleteService,
  useService,
  useServiceCategories,
  useUpdateService,
} from '../api/use-catalog';

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
});

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
  const [formError, setFormError] = useState<string | null>(null);
  const { errors, onSubmit, applyServerErrors, setErrors } = useZodForm(formSchema);

  const company = useCompany();
  const categories = useServiceCategories();
  const existing = useService(serviceId);

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
        <span className="sr-only">Loading the service…</span>
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
            : `Enter an amount with at most ${format.minorUnit} decimal places.`,
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
        error instanceof ApiError ? error.message : 'Could not save the service. Please try again.',
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
      setFormError(
        error instanceof ApiError ? error.message : 'Could not remove the service.',
      );
    }
  };

  return (
    <form onSubmit={handle} className="grid max-w-2xl gap-5" noValidate>
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">{serviceId ? 'Edit service' : 'New service'}</h2>
        <p className="text-muted-foreground text-sm">
          Prices are in {currencyCode}, the company currency.
        </p>
      </header>

      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <Field id="name" label="Name" error={errors.name}>
        <Input id="name" name="name" defaultValue={service?.name ?? ''} required maxLength={160} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="code"
          label="Code"
          hint="Optional. Your own reference, unique in this company."
          error={errors.code}
        >
          <Input
            id="code"
            name="code"
            defaultValue={service?.code ?? ''}
            maxLength={24}
            placeholder="CUT-60"
            className="font-mono"
          />
        </Field>

        <Field id="categoryId" label="Category" error={errors.categoryId}>
          <select
            id="categoryId"
            name="categoryId"
            defaultValue={service?.categoryId ?? ''}
            className={selectClass}
          >
            <option value="">Uncategorised</option>
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

      <Field id="description" label="Description" hint="Shown to customers." error={errors.description}>
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
        <legend className="mb-2 text-sm font-medium">Time</legend>

        <Field id="durationMin" label="Duration" error={errors.durationMin}>
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
            <span className="text-muted-foreground text-sm">minutes</span>
          </div>
        </Field>

        <Field
          id="bufferBeforeMin"
          label="Buffer before"
          hint="Setup time."
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
            <span className="text-muted-foreground text-sm">minutes</span>
          </div>
        </Field>

        <Field
          id="bufferAfterMin"
          label="Buffer after"
          hint="Clean-up time."
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
            <span className="text-muted-foreground text-sm">minutes</span>
          </div>
        </Field>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="price" label={`Price (${currencyCode})`} error={errors.price}>
          <Input
            id="price"
            name="price"
            inputMode="decimal"
            required
            defaultValue={
              service ? minorToDecimalString(service.priceMinor, format.minorUnit) : ''
            }
            placeholder={format.minorUnit === 0 ? '50000' : '50000.00'}
            className="tabular-nums"
          />
        </Field>

        <Field
          id="sortOrder"
          label="Sort order"
          hint="Lower comes first on the booking page."
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
        <legend className="mb-2 text-sm font-medium">Availability</legend>

        <Field id="status" label="Status" hint="Whether it can be booked at all." error={errors.status}>
          <select
            id="status"
            name="status"
            defaultValue={service?.status ?? 'ACTIVE'}
            className={`${selectClass} sm:w-48`}
          >
            <option value="DRAFT">Draft</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </Field>

        {/* Distinct from status on purpose: an internal-only service is ACTIVE
            and unlisted — reception can book it, the public cannot see it. */}
        <Checkbox
          name="isOnlineBookable"
          label="Show on the public booking site"
          hint="Uncheck for internal-only work. Staff can still book it while the status is active."
          defaultChecked={service?.isOnlineBookable ?? true}
        />
        <Checkbox
          name="requiresEmployee"
          label="Requires a member of staff"
          defaultChecked={service?.requiresEmployee ?? true}
        />
        <Checkbox
          name="requiresResource"
          label="Requires a room or equipment"
          defaultChecked={service?.requiresResource ?? false}
        />
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {serviceId ? 'Save changes' : 'Create service'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
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
            Remove service
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
