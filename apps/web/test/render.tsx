import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { SessionContext, type SessionState } from '@/features/auth';

/**
 * A fresh QueryClient per test, with retries off.
 *
 * Retries are the default in TanStack Query and they turn a deliberate failure
 * assertion into a multi-second wait; a test that means to see an error should
 * see it immediately.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export const anonymousSession: SessionState = {
  status: 'anonymous',
  user: null,
  memberships: [],
  activeCompanyId: null,
  activeCompany: null,
  permissions: new Set(),
  isOwner: false,
  isLoadingCompany: false,
};

export function sessionWith(overrides: Partial<SessionState> = {}): SessionState {
  return { ...anonymousSession, status: 'authenticated', ...overrides };
}

/**
 * Render with the providers a component actually needs.
 *
 * Passing `session` injects a fixed SessionState through the real context,
 * which is what lets a UI test assert on "an owner with two companies" without
 * standing up a bootstrap refresh. Components that are testing the provider
 * itself pass nothing and mount `SessionProvider` directly.
 */
// The return type is written out rather than inferred: the inferred one
// reaches into `pretty-format` through a pnpm-internal path, which TypeScript
// correctly refuses to emit as non-portable (TS2742).
export function renderWithProviders(
  ui: ReactElement,
  { session, ...options }: RenderOptions & { session?: SessionState } = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = makeQueryClient();

  function Wrapper({ children }: { children: ReactNode }) {
    const inner = session ? (
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    ) : (
      children
    );

    return <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>;
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}
