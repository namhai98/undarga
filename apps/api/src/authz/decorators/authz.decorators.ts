import { SetMetadata } from '@nestjs/common';
import {
  META_PERMISSION_MODE,
  META_PLATFORM_ONLY,
  META_REQUIRED_PERMISSIONS,
  META_REQUIRED_PLATFORM_PERMISSIONS,
} from '../../common/decorators/metadata';
import type { CompanyPermission, PlatformPermission } from '../permissions';

export type PermissionMode = 'all' | 'any';

/**
 * Require company permissions on this route.
 *
 * `any` is the default because most endpoints have alternative routes to the
 * same data — "read any appointment" OR "read my own" both reach the calendar,
 * with the record-level narrowing applied afterwards by the policy layer.
 */
export const RequirePermission = (...permissions: CompanyPermission[]) =>
  SetMetadata(META_REQUIRED_PERMISSIONS, permissions);

export const RequireAllPermissions = (...permissions: CompanyPermission[]) => {
  const decorate = SetMetadata(META_REQUIRED_PERMISSIONS, permissions);
  const mode = SetMetadata(META_PERMISSION_MODE, 'all' satisfies PermissionMode);
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    decorate(target as never, key as never, descriptor as never);
    mode(target as never, key as never, descriptor as never);
  };
};

/**
 * Restrict a route to the platform realm.
 *
 * Company tokens are refused with a 404, not a 403 — the existence of platform
 * endpoints is not something tenants need confirmed. Implies @NoTenant()
 * unless the route also carries @AllowPlatformAccess().
 */
export const PlatformOnly = (...permissions: PlatformPermission[]) => {
  const only = SetMetadata(META_PLATFORM_ONLY, true);
  const perms = SetMetadata(META_REQUIRED_PLATFORM_PERMISSIONS, permissions);
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    only(target as never, key as never, descriptor as never);
    perms(target as never, key as never, descriptor as never);
  };
};
