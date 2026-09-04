'use client';

import { Button } from '@/components/ui/button';
import { ApiError, ApiNetworkError } from '@/services/api-error';

/**
 * Route-level error boundary.
 *
 * Renders inside the root layout, so providers and the design system are
 * available. Distinguishes the three failure classes a user can act on
 * differently: the server refused, the server was unreachable, or something
 * else entirely.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground text-sm">{describe(error)}</p>
      {error.digest ? (
        <p className="text-muted-foreground font-mono text-xs">Reference: {error.digest}</p>
      ) : null}
      <div>
        <Button onClick={reset} variant="outline" size="sm">
          Try again
        </Button>
      </div>
    </main>
  );
}

function describe(error: Error): string {
  if (error instanceof ApiNetworkError) {
    return 'We could not reach the server. Check your connection and try again.';
  }
  if (error instanceof ApiError) {
    // The API's own message is already written for end users and never
    // contains internal detail — the exception filter strips that server-side.
    return error.message;
  }
  return 'An unexpected error occurred.';
}
