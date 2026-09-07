'use client';

import type { CompanyPermission } from '@undarga/shared';
import { useSession } from './use-session';

/**
 * May the current user do this, in the company they are currently in?
 *
 * ---------------------------------------------------------------------------
 * THIS HIDES BUTTONS. IT DOES NOT PROTECT ANYTHING.
 * ---------------------------------------------------------------------------
 *
 * `docs/ARCHITECTURE-RULES.md` rule 3: the web app is not a security boundary.
 * Every endpoint re-checks the permission server-side through PermissionGuard,
 * and a client that calls one anyway gets a 403. What this buys is that a user
 * is not shown a control that will fail — a UX property, not a security one.
 *
 * The permission list comes from `GET /me/context`, which projects what the
 * server already computed for the request. Nothing is derived here: a client
 * that worked out its own permissions from role keys would be re-implementing
 * an authorization rule, which is exactly what rule 8 keeps out of this app.
 *
 * The key is typed as `CompanyPermission` from `@undarga/shared`, so a typo or
 * a renamed permission is a build failure rather than a button that silently
 * stops appearing.
 */
export function useCan(permission: CompanyPermission): boolean {
  const { permissions, isOwner } = useSession();

  // Owners hold everything, mirroring MembershipService — which grants the
  // whole catalog at resolution time rather than storing it.
  if (isOwner) return true;

  return permissions.has(permission);
}

/** The whole set, for a component that needs to test several. */
export function usePermissions(): { permissions: ReadonlySet<string>; isOwner: boolean } {
  const { permissions, isOwner } = useSession();
  return { permissions, isOwner };
}
