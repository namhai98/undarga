'use client';

import Link from 'next/link';
import { RequireSession, SignOutButton, useSession } from '@/features/auth';
import { ReadOnlyBanner } from '@/features/subscription';

/**
 * Shell for everything behind a session.
 *
 * `'use client'` because the guard needs the session, and the session lives in
 * memory on the client — there is no server-side token to check. That makes
 * this whole subtree client-rendered, which is a real cost, accepted knowingly:
 * nothing under here could be server-rendered with data anyway.
 *
 * `RequireSession` is a redirect, not a security boundary — see its own comment.
 */
export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <RequireSession>
      <div className="flex min-h-dvh flex-col">
        <AppBar />
        <ReadOnlyBanner />
        <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">{children}</main>
      </div>
    </RequireSession>
  );
}

function AppBar() {
  const { user, activeCompany } = useSession();

  return (
    <header className="border-border/60 border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <Link href="/dashboard" className="text-sm font-semibold">
            Undarga
          </Link>
          {activeCompany ? (
            <span className="text-muted-foreground truncate text-sm">
              {activeCompany.companyName}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <span className="text-muted-foreground hidden text-xs sm:inline">{user.email}</span>
          ) : null}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
