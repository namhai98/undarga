'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { authService, type AuthenticatedSession } from '@/services/auth.service';
import { tokenStore } from '@/services/token-store';

/**
 * Where a user lands after signing in, decided from their memberships.
 *
 *   none     -> nothing to enter; explain rather than dump them in a broken app
 *   one      -> straight in, no picker for a choice of one
 *   several  -> choose deliberately, rather than silently landing in whichever
 *               company happens to sort first
 *
 * The API does pick a default active company on login, so "several" could skip
 * the picker. It should not: a user who administers two salons and lands in the
 * wrong one by default will edit the wrong one. On a later RELOAD there is no
 * picker, because the session cookie remembers the company they actually chose.
 */
export function destinationFor(session: { memberships: unknown[] }, next?: string | null): string {
  if (session.memberships.length === 0) return '/no-company';
  if (session.memberships.length > 1) return '/select-company';
  return next && isSafeReturnPath(next) ? next : '/dashboard';
}

/**
 * Only same-origin, absolute-path returns.
 *
 * `?next=` comes from the URL, so it is attacker-controlled. Without this check
 * a crafted link — `/login?next=https://evil.example` — turns the login screen
 * into an open redirect, which is a credible phishing primitive precisely
 * because the first hop is a real domain the user trusts.
 *
 * `//evil.example` is rejected too: it is protocol-relative and browsers treat
 * it as an absolute URL.
 */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//');
}

export function useLogin(next?: string | null) {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation<AuthenticatedSession, unknown, { email: string; password: string }>({
    mutationFn: ({ email, password }) => authService.login(email, password),
    onSuccess: (session) => {
      // Anything cached under a previous session belongs to a previous user.
      queryClient.clear();
      tokenStore.set(session, 'signed-in');
      router.replace(destinationFor(session, next));
    },
  });
}
