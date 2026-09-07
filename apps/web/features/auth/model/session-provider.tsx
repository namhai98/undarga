'use client';

import { createContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { apiClient } from '@/services/api-client';
import { tokenStore } from '@/services/token-store';
import type { MembershipSummary } from '@/services/auth.service';
import { useMe, useSessionContext } from '../api/use-session-query';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface SessionState {
  status: SessionStatus;
  user: { id: string; email: string; displayName: string } | null;
  memberships: MembershipSummary[];
  activeCompanyId: string | null;
  activeCompany: MembershipSummary | null;
  permissions: ReadonlySet<string>;
  isOwner: boolean;
  /** True while the company picture is still arriving, after auth is settled. */
  isLoadingCompany: boolean;
}

export const SessionContext = createContext<SessionState | null>(null);

const EMPTY_PERMISSIONS: ReadonlySet<string> = new Set();

/**
 * Restores the session on startup and exposes it to the tree.
 *
 * ---------------------------------------------------------------------------
 * THE BOOTSTRAP IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * On a fresh page load this client holds nothing: the access token lives in
 * memory and memory is gone. The refresh token is in an HttpOnly cookie the
 * browser will send but JavaScript cannot read, so the only way to find out
 * whether there is a session is to ask.
 *
 * `apiClient.ensureSession()` does that through the same single-flighted
 * refresh a 401 uses. That sharing matters: `reactStrictMode` double-invokes
 * this effect in development, and two refreshes under token ROTATION means the
 * second presents an already-rotated token, which the API treats as theft and
 * answers by killing the session family. Sharing the in-flight promise makes
 * the double invocation produce one request.
 *
 * Until that resolves the status is `loading`, and nothing may redirect. A
 * guard that treats "not yet known" as "anonymous" flashes the login screen on
 * every reload for users who are perfectly signed in.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [bootstrapped, setBootstrapped] = useState(false);

  // Subscribing to the store rather than mirroring it into state: the API
  // client can clear it from outside React entirely — a refresh that comes
  // back REFRESH_TOKEN_REUSED, for instance — and the tree has to notice.
  const tokens = useSyncExternalStore(
    (onChange) => tokenStore.subscribe(onChange),
    () => tokenStore.get(),
    () => null, // Server render: never authenticated, there is no request cookie here.
  );

  useEffect(() => {
    let cancelled = false;

    void apiClient.ensureSession().finally(() => {
      if (!cancelled) setBootstrapped(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const authenticated = bootstrapped && tokens !== null;
  const activeCompanyId = tokens?.activeCompanyId ?? null;

  const me = useMe(authenticated);
  const context = useSessionContext(authenticated ? activeCompanyId : null);

  const memberships = me.data?.memberships ?? [];

  const value: SessionState = {
    status: !bootstrapped ? 'loading' : tokens ? 'authenticated' : 'anonymous',
    user: me.data ? { id: me.data.id, email: me.data.email, displayName: me.data.displayName } : null,
    memberships,
    activeCompanyId,
    activeCompany: memberships.find((m) => m.companyId === activeCompanyId) ?? null,
    permissions: context.data ? new Set(context.data.permissions) : EMPTY_PERMISSIONS,
    isOwner: context.data?.membership?.isOwner ?? false,
    // `me` is what tells us whether the user has any companies at all, so a
    // screen that branches on membership count must wait for it.
    isLoadingCompany: authenticated && (me.isPending || (Boolean(activeCompanyId) && context.isPending)),
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
