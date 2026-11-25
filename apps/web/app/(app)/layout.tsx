'use client';

import Link from 'next/link';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { RequireSession, SignOutButton, useSession } from '@/features/auth';
import { OnboardingGate } from '@/features/onboarding';
import { ReadOnlyBanner } from '@/features/subscription';
import { useT } from '@/lib/i18n';

/**
 * Shell for everything behind a session.
 *
 * `'use client'` because the guard needs the session, and the session lives in
 * memory on the client — there is no server-side token to check. That makes
 * this whole subtree client-rendered, which is a real cost, accepted knowingly:
 * nothing under here could be server-rendered with data anyway.
 *
 * `RequireSession` and `OnboardingGate` are redirects, not security boundaries —
 * see their own comments.
 */
export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <RequireSession>
      <OnboardingGate>
        <div className="flex min-h-dvh flex-col">
          <AppBar />
          <ReadOnlyBanner />
          <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">{children}</main>
        </div>
      </OnboardingGate>
    </RequireSession>
  );
}

function AppBar() {
  const t = useT();
  const { user, activeCompany } = useSession();

  return (
    <header className="border-border/60 border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <Link href="/dashboard" className="text-sm font-semibold">
            {t('Undarga')}
          </Link>
          {activeCompany ? (
            <span className="text-muted-foreground truncate text-sm">
              {activeCompany.companyName}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <Link
              href="/account"
              className="text-muted-foreground max-w-40 truncate text-xs hover:underline"
            >
              {user.email}
            </Link>
          ) : null}
          <LocaleSwitcher />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
