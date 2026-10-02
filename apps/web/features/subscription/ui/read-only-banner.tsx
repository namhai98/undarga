'use client';

import Link from 'next/link';
import { useCan, useSession, useSessionContext } from '@/features/auth';

/**
 * Shown on every page while the company is read-only — its subscription
 * expired (or the company was suspended). Reads the session context the shell
 * already loads, so it costs no request of its own.
 */
export function ReadOnlyBanner() {
  const { activeCompanyId } = useSession();
  const context = useSessionContext(activeCompanyId);
  const canSeeBilling = useCan('settings:billing:read');

  if (context.data?.company.operationalStatus !== 'READ_ONLY') return null;

  return (
    <div
      role="status"
      className="bg-destructive/10 text-destructive border-destructive/30 border-b px-6 py-2 text-sm"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2">
        <span>This company is read-only: its subscription has expired. All data is kept.</span>
        {canSeeBilling ? (
          <Link href="/subscription" className="font-medium underline underline-offset-2">
            Manage subscription
          </Link>
        ) : (
          <span className="text-xs">Ask the account owner to renew.</span>
        )}
      </div>
    </div>
  );
}
