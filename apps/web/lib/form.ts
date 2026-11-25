import { ApiError } from '@/services/api-error';

/** The native <select> styled like the Input component. */
export const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/** The server's sentence when it sent one; a generic one otherwise. */
export function errorText(error: unknown, fallback = 'Please try again.'): string {
  return error instanceof ApiError ? error.message : fallback;
}
