'use client';

import { useCallback, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { ApiError } from '@/services/api-error';

export type FieldErrors = Record<string, string>;

/**
 * Uncontrolled forms, validated with Zod on submit.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT REACT-HOOK-FORM
 * ---------------------------------------------------------------------------
 *
 * `docs/ARCHITECTURE-RULES.md` rule 9 asks what an abstraction buys. The forms
 * in this application are two to four fields, with no dynamic arrays and no
 * async cross-field validation, and every one submits through a TanStack
 * mutation that already owns the pending and error state. RHF plus a resolver
 * package would add two dependencies and a controlled-input model to solve a
 * problem these forms do not have.
 *
 * Uncontrolled inputs also mean the password never becomes React state, so it
 * cannot end up in a devtools snapshot or an error boundary's serialised props.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ACTUALLY EARNS ITS PLACE FOR
 * ---------------------------------------------------------------------------
 *
 * `applyServerErrors`. The API returns `VALIDATION_FAILED` with a `details`
 * object, and mapping that back onto the right input is the part five separate
 * components would otherwise each invent differently — and get subtly wrong,
 * because the payload has two shapes depending on whether zod or a service
 * produced it.
 */
export function useZodForm<TSchema extends z.ZodType>(schema: TSchema) {
  const [errors, setErrors] = useState<FieldErrors>({});

  const clear = useCallback(() => setErrors({}), []);

  const onSubmit = useCallback(
    (handler: (values: z.infer<TSchema>) => void | Promise<void>) =>
      (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const raw = Object.fromEntries(new FormData(event.currentTarget));
        const parsed = schema.safeParse(raw);

        if (!parsed.success) {
          setErrors(fieldErrorsFromZod(parsed.error));
          return;
        }

        setErrors({});
        void handler(parsed.data);
      },
    [schema],
  );

  /**
   * Map a server rejection onto the fields it names.
   *
   * Only `VALIDATION_FAILED` is unpacked. Anything else — bad credentials, a
   * conflict, a network failure — is a form-level message and belongs in the
   * component, which knows what to say about it.
   */
  const applyServerErrors = useCallback((error: unknown): boolean => {
    if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return false;

    const mapped = fieldErrorsFromApi(error.details);
    if (Object.keys(mapped).length === 0) return false;

    setErrors(mapped);
    return true;
  }, []);

  return { errors, onSubmit, applyServerErrors, clear, setErrors };
}

function fieldErrorsFromZod(error: z.ZodError): FieldErrors {
  const result: FieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path.join('.') || '_';
    // First message per field. A field with three problems shows the first;
    // listing all of them under one input is noise, not help.
    result[field] ??= issue.message;
  }

  return result;
}

/**
 * The API's `details.issues` arrives in one of two shapes, because two
 * different things produce it:
 *
 *   ZodValidationPipe  ->  [{ path: 'email', message: '…' }]
 *   a service          ->  { email: '…' }
 *
 * Both are handled here rather than at five call sites.
 */
function fieldErrorsFromApi(details: Record<string, unknown> | undefined): FieldErrors {
  const issues = details?.issues;
  if (!issues) return {};

  if (Array.isArray(issues)) {
    const result: FieldErrors = {};
    for (const issue of issues) {
      if (typeof issue !== 'object' || issue === null) continue;
      const { path, message } = issue as { path?: unknown; message?: unknown };
      if (typeof message !== 'string') continue;
      const field = Array.isArray(path) ? path.join('.') : String(path ?? '_');
      result[field] ??= message;
    }
    return result;
  }

  if (typeof issues === 'object') {
    const result: FieldErrors = {};
    for (const [field, message] of Object.entries(issues as Record<string, unknown>)) {
      if (typeof message === 'string') result[field] = message;
    }
    return result;
  }

  return {};
}
