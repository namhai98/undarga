'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  invitationsService,
  type AcceptedInvitation,
  type InvitationPreview,
} from '@/services/invitations.service';
import { tokenStore } from '@/services/token-store';

/**
 * What the invitation is for.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS NOT IN THE QUERY KEY
 * ---------------------------------------------------------------------------
 *
 * A query key is stored in the cache, is visible in the React Query devtools,
 * and is serialised into any devtools export. A one-time credential does not
 * belong in any of those. The key is a constant instead — there is only ever
 * one invitation being previewed on this page, so it distinguishes nothing.
 *
 * `gcTime: 0` for the same reason: the response is dropped as soon as the page
 * unmounts rather than lingering in memory behind a back-navigation.
 */
export function useInvitationPreview(token: string) {
  return useQuery<InvitationPreview>({
    queryKey: ['invitation-preview'],
    queryFn: ({ signal }) => invitationsService.preview(token, signal),
    enabled: token.length > 0,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/**
 * Accept, and go where the result says.
 *
 * The API returns no tokens — a stolen link must not be exchangeable for a
 * session — so this cannot sign anybody in. Two outcomes:
 *
 *   new account      -> the password was just chosen, so send them to sign in
 *                       with the address prefilled
 *   already signed in -> they are already authenticated; the membership is new,
 *                       so the cached session must be discarded and re-read
 */
export function useAcceptInvitation(token: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const authenticated = tokenStore.isAuthenticated;

  return useMutation<AcceptedInvitation, unknown, { fullName?: string; password?: string }>({
    mutationFn: (input) => invitationsService.accept({ token, ...input }, authenticated),
    onSuccess: (result) => {
      if (authenticated) {
        // Memberships changed, so `/auth/me` and the context are both stale.
        queryClient.clear();
        router.replace('/select-company');
        return;
      }

      // No session. The address is passed so the login form can prefill it —
      // it is not a secret, and it is what the user just typed.
      //
      // The TOKEN is deliberately not carried forward: it is spent, and putting
      // a consumed credential in another URL achieves nothing but a second
      // place for it to be logged.
      router.replace(`/login?email=${encodeURIComponent(result.email)}`);
    },
  });
}
