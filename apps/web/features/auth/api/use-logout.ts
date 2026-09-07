'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { authService } from '@/services/auth.service';
import { tokenStore } from '@/services/token-store';

/**
 * Sign out.
 *
 * The local teardown runs whether or not the server call succeeded. A user who
 * clicks "sign out" on a flaky connection must not be left signed in — and the
 * failure mode is asymmetric: ending a session that is already dead costs
 * nothing, while leaving one alive on a shared machine is the actual harm.
 *
 * Three things are cleared, in this order:
 *
 *   1. the server session and its refresh cookie (POST /auth/logout)
 *   2. the in-memory access token
 *   3. every cached query
 *
 * (3) is not housekeeping. The cache holds one company's members, appointments
 * and customers; leaving it in place means the next person to sign in on this
 * machine sees the previous tenant's data rendered from cache before their own
 * arrives.
 */
export function useLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void>({
    mutationFn: () => authService.logout(),
    onSettled: () => {
      tokenStore.clear('signed-out');
      queryClient.clear();
      router.replace('/login');
    },
  });
}
