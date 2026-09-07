'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../model/use-session';

/**
 * Keeps signed-out visitors off the authenticated screens.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT PROTECTION
 * ---------------------------------------------------------------------------
 *
 * It exists so a user does not watch a page render and then immediately 401.
 * Anyone can edit client state; the API is the boundary and re-checks every
 * request (`docs/ARCHITECTURE-RULES.md` rule 3). Nothing sensitive reaches this
 * component in the first place — the data behind these screens is fetched with
 * a bearer token that a signed-out visitor does not have.
 *
 * ---------------------------------------------------------------------------
 * WHY A CLIENT GUARD AND NOT MIDDLEWARE
 * ---------------------------------------------------------------------------
 *
 * Middleware runs on the Next origin and can only read cookies set for it. The
 * refresh cookie is set by the API host, scoped to `/api/v1/auth`, and in
 * production is on a different host entirely — middleware would see nothing at
 * all. Even where it could, cookie presence proves only that a cookie exists,
 * not that the session is valid, so gating on it would be a client-side
 * authorization decision.
 *
 * The consequence is honest: everything under `(app)` is client-rendered. There
 * is no server-side token to fetch with, so it could not have been otherwise.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status !== 'anonymous') return;

    // Remember where they were headed. A user who deep-links into the app,
    // signs in, and lands on a generic dashboard has to navigate twice.
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  // `loading` must render a placeholder, never the login screen and never the
  // children. Treating "not yet known" as "signed out" flashes the login form
  // on every reload for users who are perfectly authenticated — the single most
  // common bug in this pattern.
  if (status === 'loading') {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-10" aria-busy="true" aria-live="polite">
        <span className="sr-only">Restoring your session…</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-32 w-full" />
      </div>
    );
  }

  // Redirecting. Rendering nothing beats rendering a flash of the app.
  if (status === 'anonymous') return null;

  return <>{children}</>;
}
