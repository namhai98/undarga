'use client';

import type { ReactNode } from 'react';
import { SessionProvider } from '@/features/auth';
import { LocaleProvider, type Locale } from '@/lib/i18n';
import { QueryProvider } from './query-provider';
import { SessionCacheBridge } from './session-cache-bridge';

/**
 * Every client-side provider, composed once.
 *
 * The root layout stays a Server Component — only this subtree is marked
 * `'use client'`. Marking the layout itself would opt the entire application
 * out of Server Components.
 *
 * Order is load-bearing. SessionProvider runs its queries through TanStack
 * Query, and SessionCacheBridge needs `useQueryClient()`, so both must be
 * INSIDE QueryProvider. The bridge sits above SessionProvider so it is
 * subscribed before the bootstrap refresh can fire.
 */
export function AppProviders({ children, locale }: { children: ReactNode; locale: Locale }) {
  return (
    <LocaleProvider locale={locale}>
      <QueryProvider>
        <SessionCacheBridge>
          <SessionProvider>{children}</SessionProvider>
        </SessionCacheBridge>
      </QueryProvider>
    </LocaleProvider>
  );
}
