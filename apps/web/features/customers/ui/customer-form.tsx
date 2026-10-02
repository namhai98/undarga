'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useEmployees } from '@/features/employees';
import { useZodForm } from '@/hooks/use-zod-form';
import { ApiError } from '@/services/api-error';
import type { CustomerInput, CustomerStatus } from '@/services/customers.service';
import { useCreateCustomer, useCustomer, useUpdateCustomer } from '../api/use-customers';

/**
 * Everything arrives from `FormData` as a string, so the schema coerces and the
 * component never keeps a parallel controlled copy.
 *
 * The rules mirror the API's, so an obvious mistake costs no round trip — and
 * the API still enforces them, because a client check is a convenience and
 * never protection (`docs/ARCHITECTURE-RULES.md`, rule 3).
 */
const formSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Enter a first name.').max(96),
    lastName: z.string().trim().max(96),
    email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address.')]),
    phone: z.string().trim().max(32),
    address: z.string().trim().max(512),
    notes: z.string().trim().max(4000),
    birthDate: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')]),
    tags: z.string().trim().max(200),
    preferredEmployeeId: z.string(),
    status: z.enum(['ACTIVE', 'BLOCKED', 'ARCHIVED']),
  })
  .superRefine((value, ctx) => {
    // A customer with neither is unreachable and unfindable — two of them are
    // indistinguishable to whoever has to pick one at the desk.
    if (!value.email && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Give at least a phone number or an email address.',
        path: ['phone'],
      });
    }
  });

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Create or edit one customer.
 *
 * `customerId === null` means create. The same fields either way — a separate
 * create form and edit form is two places to add the next column to, and they
 * drift.
 */
export function CustomerForm({
  customerId,
  onDone,
  onCancel,
}: {
  customerId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  /** Set when the API says this contact detail already belongs to somebody. */
  const [duplicateId, setDuplicateId] = useState<string | null>(null);

  const { errors, onSubmit, applyServerErrors, setErrors } = useZodForm(formSchema);

  const existing = useCustomer(customerId);
  const employees = useEmployees({ limit: 100, status: 'ACTIVE' });

  const create = useCreateCustomer();
  const update = useUpdateCustomer(customerId ?? '');

  const customer = existing.data;
  const pending = create.isPending || update.isPending;

  if (customerId && existing.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading the customer…</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const handle = onSubmit(async (values) => {
    setFormError(null);
    setDuplicateId(null);

    const input: CustomerInput = {
      firstName: values.firstName,
      lastName: values.lastName || null,
      email: values.email || null,
      phone: values.phone || null,
      address: values.address || null,
      notes: values.notes || null,
      birthDate: values.birthDate || null,
      tags: values.tags
        ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : [],
      preferredEmployeeId: values.preferredEmployeeId || null,
      status: values.status as CustomerStatus,
    };

    try {
      if (customerId) {
        await update.mutateAsync(input);
      } else {
        await create.mutateAsync(input);
      }
      onDone();
    } catch (error) {
      if (applyServerErrors(error)) return;

      if (error instanceof ApiError && error.code === 'CONFLICT') {
        // The API names the colliding field and the record that holds it, so
        // the message lands on the right input and offers a way out instead of
        // leaving somebody to search for a customer they were just told exists.
        const field = typeof error.details?.field === 'string' ? error.details.field : 'phone';
        const existingId = error.details?.existingCustomerId;
        setErrors({ [field]: error.message });
        setDuplicateId(typeof existingId === 'string' ? existingId : null);
        return;
      }

      setFormError(
        error instanceof ApiError ? error.message : 'Could not save the customer. Please try again.',
      );
    }
  });

  return (
    <form onSubmit={handle} className="grid max-w-2xl gap-5" noValidate>
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">{customerId ? 'Edit customer' : 'New customer'}</h2>
        <p className="text-muted-foreground text-sm">
          A phone number or an email address is required — one of them is how you find this person
          again.
        </p>
      </header>

      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      {duplicateId ? (
        <Alert role="alert">
          <AlertTitle>That contact detail is already on file</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>You are probably looking for the existing record.</span>
            <Link
              href={`/customers/${duplicateId}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Open that customer
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="firstName" label="First name" error={errors.firstName}>
          <Input
            id="firstName"
            name="firstName"
            defaultValue={customer?.firstName ?? ''}
            required
            maxLength={96}
          />
        </Field>

        <Field id="lastName" label="Last name" error={errors.lastName}>
          <Input
            id="lastName"
            name="lastName"
            defaultValue={customer?.lastName ?? ''}
            maxLength={96}
          />
        </Field>

        <Field
          id="phone"
          label="Phone"
          hint="Spaces and dashes are fine — they are stripped before saving."
          error={errors.phone}
        >
          <Input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            defaultValue={customer?.phone ?? ''}
            maxLength={32}
            placeholder="+976 9911 2233"
          />
        </Field>

        <Field id="email" label="Email" error={errors.email}>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={customer?.email ?? ''}
            maxLength={320}
          />
        </Field>
      </div>

      <Field id="address" label="Address" hint="One line — wherever you would drive to." error={errors.address}>
        <Input
          id="address"
          name="address"
          defaultValue={customer?.address ?? ''}
          maxLength={512}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="birthDate" label="Birthday" hint="YYYY-MM-DD." error={errors.birthDate}>
          <Input
            id="birthDate"
            name="birthDate"
            type="date"
            defaultValue={customer?.birthDate ?? ''}
          />
        </Field>

        <Field
          id="preferredEmployeeId"
          label="Usual staff member"
          error={errors.preferredEmployeeId}
        >
          <select
            id="preferredEmployeeId"
            name="preferredEmployeeId"
            defaultValue={customer?.preferredEmployeeId ?? ''}
            className={selectClass}
          >
            <option value="">No preference</option>
            {(employees.data?.items ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.displayName}
              </option>
            ))}
          </select>
        </Field>

        <Field id="status" label="Status" error={errors.status}>
          <select
            id="status"
            name="status"
            defaultValue={customer?.status ?? 'ACTIVE'}
            className={selectClass}
          >
            <option value="ACTIVE">Active</option>
            <option value="BLOCKED">Blocked</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </Field>
      </div>

      <Field id="tags" label="Tags" hint="Comma separated, e.g. vip, allergy." error={errors.tags}>
        <Input id="tags" name="tags" defaultValue={customer?.tags.join(', ') ?? ''} maxLength={200} />
      </Field>

      <Field id="notes" label="Notes" hint="Visible to everyone who can see this customer." error={errors.notes}>
        <textarea
          id="notes"
          name="notes"
          defaultValue={customer?.notes ?? ''}
          rows={3}
          maxLength={4000}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {customerId ? 'Save changes' : 'Create customer'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
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
