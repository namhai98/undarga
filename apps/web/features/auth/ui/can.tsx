'use client';

import type { CompanyPermission } from '@undarga/shared';
import type { ReactNode } from 'react';
import { useCan } from '../model/use-permissions';

/**
 * Render children only when the user holds the permission.
 *
 * A convenience over `useCan`, for the common case of hiding one control.
 *
 * NEVER wrap a data fetch in this. A query that would 403 anyway costs a
 * request and nothing else, but hiding it here teaches the next reader that the
 * client is enforcing something — and that is how a real check ends up omitted
 * from the server. This hides buttons; the API decides
 * (`docs/ARCHITECTURE-RULES.md` rule 3).
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: CompanyPermission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}
