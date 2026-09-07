'use client';

import { useContext } from 'react';
import { SessionContext, type SessionState } from './session-provider';

export function useSession(): SessionState {
  const session = useContext(SessionContext);

  if (!session) {
    // A hard throw rather than a null-shaped default. A component rendering
    // outside the provider would otherwise silently behave as though nobody is
    // signed in, which looks like a logout bug and is miserable to trace.
    throw new Error('useSession must be used inside <SessionProvider>.');
  }

  return session;
}
