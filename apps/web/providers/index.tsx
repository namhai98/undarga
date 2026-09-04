'use client';

import type { ReactNode } from 'react';
import { QueryProvider } from './query-provider';

/**
 * Every client-side provider, composed once.
 *
 * The root layout stays a Server Component — only this subtree is marked
 * `'use client'`. Marking the layout itself would opt the entire application
 * out of Server Components.
 *
 * Auth and tenant providers will join this list; they are not here yet because
 * this phase ships no authentication UI.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
