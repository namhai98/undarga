'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { useSession } from '@/features/auth';
import { useBranches } from '../api/use-branches';

const STORAGE_KEY = 'undarga.selected-branch';

/**
 * Which branch the user is looking at.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A UI PREFERENCE, NOT AN ACCESS DECISION
 * ---------------------------------------------------------------------------
 *
 * Nothing is authorised by it. Every request carries the branch id explicitly
 * and the server scopes it to the resolved company, so a tampered value in
 * storage buys a 404 and nothing else. Branch-level ACCESS (the
 * `company_user_branch` scope) is a server concern and is not enforced yet.
 *
 * ---------------------------------------------------------------------------
 * WHY localStorage IS ACCEPTABLE HERE, WHEN IT IS NOT FOR TOKENS
 * ---------------------------------------------------------------------------
 *
 * A branch id is not a credential. The rule this codebase follows is that
 * long-lived credentials never touch storage a script can read; a per-viewer
 * convenience that survives a reload is exactly what localStorage is for.
 *
 * Keyed by company, so switching tenant cannot carry a selection across — a
 * stale id from another company would 404 on the first request after a switch.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NOT MIRRORED
 * ---------------------------------------------------------------------------
 *
 * The selection is computed during render from three ordered candidates rather
 * than copied into state by an effect. Mirroring would mean a `setState` inside
 * `useEffect` — a render, then an effect, then a second render — and it would
 * go stale the moment the branch list changed underneath it. State here holds
 * ONLY an explicit user choice.
 *
 * `useSyncExternalStore` is what makes reading storage safe during render: the
 * third argument is the server snapshot, so SSR sees `null` and hydration
 * cannot mismatch.
 */
export function useSelectedBranch() {
  const { activeCompanyId } = useSession();
  const branches = useBranches();
  const [chosen, setChosen] = useState<string | null>(null);

  const remembered = useSyncExternalStore(
    subscribeToNothing,
    () => (activeCompanyId ? read(activeCompanyId) : null),
    // Server render: storage does not exist, and pretending otherwise is a
    // hydration mismatch.
    () => null,
  );

  const items = branches.data?.items ?? [];

  // First candidate that still exists in THIS company's list. A remembered
  // branch can have been deleted, and an explicit choice can be left over from
  // before a company switch.
  const selectedId =
    [chosen, remembered].find((id) => id && items.some((b) => b.id === id)) ??
    items[0]?.id ??
    null;

  const select = useCallback(
    (branchId: string) => {
      setChosen(branchId);
      if (activeCompanyId) write(activeCompanyId, branchId);
    },
    [activeCompanyId],
  );

  return {
    branches: items,
    selectedId,
    selected: items.find((b) => b.id === selectedId) ?? null,
    select,
    isLoading: branches.isPending,
  };
}

/**
 * `localStorage` fires no event for same-tab writes, and the only writer is
 * `select`, which already re-renders through `setChosen`. Nothing to subscribe
 * to.
 */
function subscribeToNothing(): () => void {
  return () => undefined;
}

/**
 * Every access is wrapped: storage throws outright in some contexts — a private
 * window with site data blocked, a thumbnail renderer — and a stored preference
 * must never be able to break the page.
 */
function read(companyId: string): string | null {
  try {
    return window.localStorage.getItem(`${STORAGE_KEY}.${companyId}`);
  } catch {
    return null;
  }
}

function write(companyId: string, branchId: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_KEY}.${companyId}`, branchId);
  } catch {
    // A preference that cannot be saved is not an error worth surfacing.
  }
}
