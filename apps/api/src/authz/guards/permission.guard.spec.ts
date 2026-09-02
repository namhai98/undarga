import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import {
  MissingTenantContextError,
  PermissionDeniedError,
  PlatformAccessRequiredError,
  TenantReadOnlyError,
} from '../../common/errors';
import {
  META_IS_PUBLIC,
  META_PERMISSION_MODE,
  META_REQUIRED_PERMISSIONS,
  META_REQUIRED_PLATFORM_PERMISSIONS,
  META_REQUIRES_WRITE,
} from '../../common/decorators/metadata';
import { RequestContextService } from '../../tenancy/context/request-context.service';
import type { Actor, TenantContext } from '../../tenancy/context/context.types';
import { COMPANY_PERMISSIONS, PLATFORM_PERMISSIONS } from '../permissions';
import { PermissionGuard } from './permission.guard';

const ctx = {
  switchToHttp: () => ({ getRequest: () => ({}) }),
  getHandler: () => function h() {},
  getClass: () => class C {},
} as unknown as ExecutionContext;

function reflectorWith(meta: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
}

function tenant(
  permissions: string[],
  operationalStatus: 'ACTIVE' | 'READ_ONLY' = 'ACTIVE',
): TenantContext {
  return {
    company: {
      id: 'company-a',
      slug: 'a',
      status: 'ACTIVE',
      operationalStatus,
      defaultTimezoneName: 'UTC',
      currencyCode: 'MNT',
    },
    membership: {
      companyUserId: 'cu',
      userAccountId: 'u',
      isOwner: false,
      roleKeys: [],
      branchScope: null,
    },
    permissions: new Set(permissions),
    source: 'ACTIVE_COMPANY_CLAIM',
    viaPlatformAccess: false,
  };
}

describe('PermissionGuard', () => {
  let context: RequestContextService;

  const inContext = (actor: Actor, tenantContext: TenantContext | null, fn: () => void) => {
    context.run({ requestId: 'r', actor, tenant: null, startedAt: new Date() }, () => {
      if (tenantContext) context.attachTenant(tenantContext);
      fn();
    });
  };

  const companyUser: Actor = {
    kind: 'COMPANY_USER',
    userAccountId: 'u',
    email: 'u@e.test',
    displayName: 'U',
    sessionId: 's',
  };

  beforeEach(() => {
    context = new RequestContextService();
  });

  it('allows a public route without consulting anything', () => {
    const guard = new PermissionGuard(reflectorWith({ [META_IS_PUBLIC]: true }), context);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a route that declares no permissions', () => {
    const guard = new PermissionGuard(reflectorWith({}), context);
    inContext(companyUser, tenant([]), () => {
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('company permissions', () => {
    it('allows when the permission is held', () => {
      const guard = new PermissionGuard(
        reflectorWith({ [META_REQUIRED_PERMISSIONS]: [COMPANY_PERMISSIONS.CUSTOMER_READ] }),
        context,
      );
      inContext(companyUser, tenant([COMPANY_PERMISSIONS.CUSTOMER_READ]), () => {
        expect(guard.canActivate(ctx)).toBe(true);
      });
    });

    it('denies when it is not', () => {
      const guard = new PermissionGuard(
        reflectorWith({ [META_REQUIRED_PERMISSIONS]: [COMPANY_PERMISSIONS.PAYMENT_REFUND] }),
        context,
      );
      inContext(companyUser, tenant([COMPANY_PERMISSIONS.CUSTOMER_READ]), () => {
        expect(() => guard.canActivate(ctx)).toThrow(PermissionDeniedError);
      });
    });

    it('defaults to ANY of the listed permissions', () => {
      const guard = new PermissionGuard(
        reflectorWith({
          [META_REQUIRED_PERMISSIONS]: [
            COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY,
            COMPANY_PERMISSIONS.APPOINTMENT_READ_OWN,
          ],
        }),
        context,
      );
      inContext(companyUser, tenant([COMPANY_PERMISSIONS.APPOINTMENT_READ_OWN]), () => {
        expect(guard.canActivate(ctx)).toBe(true);
      });
    });

    it('requires all of them in "all" mode', () => {
      const guard = new PermissionGuard(
        reflectorWith({
          [META_REQUIRED_PERMISSIONS]: [
            COMPANY_PERMISSIONS.CUSTOMER_READ,
            COMPANY_PERMISSIONS.CUSTOMER_EXPORT,
          ],
          [META_PERMISSION_MODE]: 'all',
        }),
        context,
      );
      inContext(companyUser, tenant([COMPANY_PERMISSIONS.CUSTOMER_READ]), () => {
        expect(() => guard.canActivate(ctx)).toThrow(PermissionDeniedError);
      });
    });

    it('surfaces a missing tenant as a wiring bug, not a permission denial', () => {
      // Important distinction: a 403 here would get "fixed" by widening
      // somebody's role. A 500 naming the missing guard gets fixed properly.
      const guard = new PermissionGuard(
        reflectorWith({ [META_REQUIRED_PERMISSIONS]: [COMPANY_PERMISSIONS.CUSTOMER_READ] }),
        context,
      );
      inContext(companyUser, null, () => {
        expect(() => guard.canActivate(ctx)).toThrow(MissingTenantContextError);
      });
    });
  });

  describe('platform permissions', () => {
    const operator = (permissions: string[]): Actor => ({
      kind: 'PLATFORM_USER',
      platformUserId: 'op',
      email: 'op@e.test',
      displayName: 'Op',
      sessionId: 's',
      platformPermissions: new Set(permissions),
    });

    it('refuses a company user on a platform route with a 404', () => {
      // 404, not 403: the existence of platform endpoints is not confirmed to
      // tenants.
      const guard = new PermissionGuard(
        reflectorWith({
          [META_REQUIRED_PLATFORM_PERMISSIONS]: [PLATFORM_PERMISSIONS.COMPANY_LIST],
        }),
        context,
      );
      inContext(companyUser, tenant([]), () => {
        const error = (() => {
          try {
            guard.canActivate(ctx);
          } catch (e) {
            return e;
          }
        })();
        expect(error).toBeInstanceOf(PlatformAccessRequiredError);
        expect((error as PlatformAccessRequiredError).status).toBe(404);
      });
    });

    it('allows an operator holding the permission', () => {
      const guard = new PermissionGuard(
        reflectorWith({
          [META_REQUIRED_PLATFORM_PERMISSIONS]: [PLATFORM_PERMISSIONS.COMPANY_LIST],
        }),
        context,
      );
      inContext(operator([PLATFORM_PERMISSIONS.COMPANY_LIST]), null, () => {
        expect(guard.canActivate(ctx)).toBe(true);
      });
    });

    it('a company permission never satisfies a platform requirement', () => {
      // The two catalogs are separate; there is no key a company role could
      // hold that would pass this check.
      const guard = new PermissionGuard(
        reflectorWith({
          [META_REQUIRED_PLATFORM_PERMISSIONS]: [PLATFORM_PERMISSIONS.COMPANY_DATA_READ],
        }),
        context,
      );
      inContext(operator([COMPANY_PERMISSIONS.CUSTOMER_READ]), null, () => {
        expect(() => guard.canActivate(ctx)).toThrow(PermissionDeniedError);
      });
    });
  });

  describe('read-only companies', () => {
    it('blocks a write route when the company is read-only', () => {
      const guard = new PermissionGuard(
        reflectorWith({
          [META_REQUIRES_WRITE]: true,
          [META_REQUIRED_PERMISSIONS]: [COMPANY_PERMISSIONS.APPOINTMENT_WRITE],
        }),
        context,
      );
      inContext(companyUser, tenant([COMPANY_PERMISSIONS.APPOINTMENT_WRITE], 'READ_ONLY'), () => {
        expect(() => guard.canActivate(ctx)).toThrow(TenantReadOnlyError);
      });
    });

    it('still allows reads', () => {
      const guard = new PermissionGuard(
        reflectorWith({ [META_REQUIRED_PERMISSIONS]: [COMPANY_PERMISSIONS.CUSTOMER_READ] }),
        context,
      );
      inContext(companyUser, tenant([COMPANY_PERMISSIONS.CUSTOMER_READ], 'READ_ONLY'), () => {
        expect(guard.canActivate(ctx)).toBe(true);
      });
    });
  });
});
