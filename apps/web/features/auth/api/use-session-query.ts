'use client';

import { useQuery } from '@tanstack/react-query';
import { authService, type CurrentUser, type SessionContext } from '@/services/auth.service';

/**
 * Query keys, namespaced by feature.
 *
 * `context` carries the company id even though the server derives the company
 * from the token. Without it, switching company and then switching back would
 * serve the first company's cached permissions — and a cache key that cannot
 * distinguish two tenants is the one shape this codebase spends the most effort
 * avoiding on the server.
 */
export const authKeys = {
  all: ['auth'] as const,
  me: () => [...authKeys.all, 'me'] as const,
  context: (companyId: string | null | undefined) =>
    [...authKeys.all, 'context', companyId ?? 'none'] as const,
};

/** The signed-in user and every company they belong to. Tenant-less. */
export function useMe(enabled: boolean) {
  return useQuery<CurrentUser>({
    queryKey: authKeys.me(),
    queryFn: ({ signal }) => authService.me(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * The active company and what may be done in it.
 *
 * Disabled until a company is actually selected: `/me/context` is tenant-scoped
 * and would 404 with TENANT_UNRESOLVED for a user who has not chosen one, which
 * would look like a failure rather than the ordinary "no company yet" state.
 */
export function useSessionContext(companyId: string | null | undefined) {
  return useQuery<SessionContext>({
    queryKey: authKeys.context(companyId),
    queryFn: ({ signal }) => authService.context(signal),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
}
