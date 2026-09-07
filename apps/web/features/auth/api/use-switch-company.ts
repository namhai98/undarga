'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { authService, type AuthenticatedSession } from '@/services/auth.service';
import { tokenStore } from '@/services/token-store';

/**
 * Change the active company.
 *
 * The server issues a brand-new token pair and retires the old session, so a
 * token is only ever valid for one company — there is no window in which it
 * means two things.
 *
 * ---------------------------------------------------------------------------
 * `clear()`, NOT `invalidateQueries()`
 * ---------------------------------------------------------------------------
 *
 * Invalidate marks cached data stale but KEEPS it, and React re-renders the
 * stale value while the refetch is in flight. After a company switch that means
 * the previous tenant's members and appointments are painted on screen under
 * the new company's name — briefly, and then corrected. The backend spends four
 * layers of effort making cross-tenant reads impossible; the client must not
 * reintroduce one in a cache.
 *
 * Queries are cancelled first so a request already in flight for the OLD
 * company cannot resolve after the clear and repopulate the cache with it.
 */
export function useSwitchCompany() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation<AuthenticatedSession, unknown, { companyId: string }>({
    mutationFn: ({ companyId }) => authService.switchCompany(companyId),
    onSuccess: async (session) => {
      await queryClient.cancelQueries();
      queryClient.clear();
      tokenStore.set(session, 'company-switched');
      router.replace('/dashboard');
    },
  });
}
