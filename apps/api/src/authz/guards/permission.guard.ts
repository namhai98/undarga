import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  META_IS_PUBLIC,
  META_PERMISSION_MODE,
  META_REQUIRED_PERMISSIONS,
  META_REQUIRED_PLATFORM_PERMISSIONS,
  META_REQUIRES_WRITE,
} from '../../common/decorators/metadata';
import {
  PermissionDeniedError,
  PlatformAccessRequiredError,
  TenantReadOnlyError,
} from '../../common/errors';
import { RequestContextService } from '../../tenancy/context/request-context.service';
import { isPlatformUser } from '../../tenancy/context/context.types';
import type { PermissionMode } from '../decorators/authz.decorators';

/**
 * Guard 3 of 3: what the caller may do.
 *
 * Runs after TenantGuard, so the permission set it reads is the one
 * MembershipService produced for *this* company. A user who owns company A and
 * answers the phone at company B holds receptionist permissions while their
 * context is B — permissions are per membership, never per user.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContextService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(META_IS_PUBLIC, targets)) {
      return true;
    }

    // --- platform permissions ------------------------------------------------
    const platformRequired =
      this.reflector.getAllAndOverride<string[]>(META_REQUIRED_PLATFORM_PERMISSIONS, targets) ?? [];

    if (platformRequired.length > 0) {
      const actor = this.context.actor;

      if (!actor || !isPlatformUser(actor)) {
        // 404, not 403: the existence of platform endpoints is not something
        // tenants need confirmed.
        throw new PlatformAccessRequiredError();
      }

      const missing = platformRequired.filter((p) => !actor.platformPermissions.has(p));
      if (missing.length > 0) {
        throw new PermissionDeniedError(missing);
      }
    }

    // --- read-only companies -------------------------------------------------
    if (this.reflector.getAllAndOverride<boolean>(META_REQUIRES_WRITE, targets)) {
      const tenant = this.context.tenantOrNull();
      // Tenant-less routes have nothing to be read-only about.
      if (tenant && tenant.company.operationalStatus === 'READ_ONLY') {
        throw new TenantReadOnlyError();
      }
    }

    // --- company permissions -------------------------------------------------
    const required =
      this.reflector.getAllAndOverride<string[]>(META_REQUIRED_PERMISSIONS, targets) ?? [];

    if (required.length === 0) {
      return true;
    }

    const mode =
      this.reflector.getAllAndOverride<PermissionMode>(META_PERMISSION_MODE, targets) ?? 'any';

    // requireTenant, not tenantOrNull: a route asking for a company permission
    // with no company is a wiring bug. It must surface as one, rather than as a
    // permission denial that someone "fixes" by widening a role.
    const tenant = this.context.requireTenant('permission check');

    const granted =
      mode === 'all'
        ? required.every((p) => tenant.permissions.has(p))
        : required.some((p) => tenant.permissions.has(p));

    if (!granted) {
      throw new PermissionDeniedError(required);
    }

    return true;
  }
}
