'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { tokenStore } from '@/services/token-store';

/**
 * Empties the query cache whenever the session changes underneath the app.
 *
 * ---------------------------------------------------------------------------
 * WHY A SUBSCRIPTION AND NOT JUST THE MUTATION HANDLERS
 * ---------------------------------------------------------------------------
 *
 * `useLogin`, `useLogout` and `useSwitchCompany` each clear the cache
 * themselves, and for the paths a user drives that is enough. But the store can
 * also change from OUTSIDE React: the API client clears it when a refresh comes
 * back `REFRESH_TOKEN_REUSED` or `SESSION_REVOKED`, with no component involved.
 *
 * Without this bridge, an expired session leaves the previous company's members
 * and appointments sitting in the cache, rendered from memory until something
 * refetches. Getting the cross-tenant story right on the server and then
 * leaving stale tenant data in a browser cache would be a strange place to
 * stop.
 *
 * `refreshed` is excluded: a routine token rotation is the same user in the
 * same company, and clearing there would throw away every cached query every
 * fifteen minutes.
 *
 * Queries under a SESSION_INDEPENDENT root key are kept. The public booking
 * page's data is identical for every visitor and derives from no session — and
 * an anonymous visitor's bootstrap refresh 401s moments after the page starts
 * loading, so wiping here would remove its in-flight queries out from under the
 * mounted components and leave them pending forever.
 */
const SESSION_INDEPENDENT: ReadonlySet<unknown> = new Set(['public-booking']);

export function SessionCacheBridge({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      tokenStore.subscribe((_tokens, reason) => {
        if (reason === 'refreshed') return;
        queryClient.removeQueries({
          predicate: (query) => !SESSION_INDEPENDENT.has(query.queryKey[0]),
        });
        queryClient.getMutationCache().clear();
      }),
    [queryClient],
  );

  return <>{children}</>;
}
