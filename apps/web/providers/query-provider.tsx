'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/services/api-error';

/**
 * TanStack Query setup.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLIENT IS CREATED IN STATE, NOT AT MODULE SCOPE
 * ---------------------------------------------------------------------------
 *
 * A module-level QueryClient is shared across every request on the server. In
 * an App Router app that means one user's cached data can be served to the
 * next — a cross-tenant leak in a multi-tenant product, which is the one bug
 * this codebase spends the most effort preventing on the backend. `useState`
 * gives each render tree its own client.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The API client already retries idempotent GETs with backoff.
            // Retrying again here would multiply the delay before a user sees
            // an error, so Query only retries what the transport gave up on.
            retry: (failureCount, error) => {
              if (error instanceof ApiError) {
                // 4xx will not become 5xx on a second attempt, and a 401 is
                // handled by the refresh flow in the API client.
                if (error.status < 500) return false;
              }
              return failureCount < 1;
            },
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
          mutations: {
            // Never automatic. A retried "create appointment" is a double
            // booking; retrying a mutation is always the caller's decision.
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
