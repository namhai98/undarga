import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import {
  PlatformAccessNotTargetedError,
  TenantNotFoundError,
  TenantUnresolvedError,
  UnauthenticatedError,
} from '../../common/errors';
import {
  META_ALLOW_PLATFORM_ACCESS,
  META_IS_PUBLIC,
  META_NO_TENANT,
  META_PLATFORM_ONLY,
} from '../../common/decorators/metadata';
import { RequestContextService } from '../context/request-context.service';
import type { Actor, TenantContext } from '../context/context.types';
import type { MembershipService } from '../membership/membership.service';
import type { TenantResolverChain } from '../resolvers/tenant-resolver.chain';
import type { TenantResolutionInput } from '../resolvers/tenant-resolver.types';
import { TenantGuard } from './tenant.guard';
import { REQUEST_CONTEXT_KEY } from './request-with-context';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';

const userA: Actor = {
  kind: 'COMPANY_USER',
  userAccountId: 'user-a',
  email: 'a@example.com',
  displayName: 'A',
  sessionId: 's',
};

const operator: Actor = {
  kind: 'PLATFORM_USER',
  platformUserId: 'op-1',
  email: 'ops@platform.test',
  displayName: 'Ops',
  sessionId: 's',
  platformPermissions: new Set(['platform:company:data:read']),
};

function tenantFor(companyId: string, viaPlatformAccess = false): TenantContext {
  return {
    company: {
      id: companyId,
      slug: 'x',
      status: 'ACTIVE',
      operationalStatus: 'ACTIVE',
      defaultTimezoneName: 'UTC',
      currencyCode: 'MNT',
    },
    membership: viaPlatformAccess
      ? null
      : {
          companyUserId: 'cu',
          userAccountId: 'user-a',
          isOwner: false,
          roleKeys: [],
          branchScope: null,
        },
    permissions: new Set(),
    source: 'ROUTE_PARAM',
    viaPlatformAccess,
  };
}

function executionContext(request: Record<string, unknown> = {}): ExecutionContext {
  const req = {
    params: {},
    query: {},
    headers: {},
    path: '/api/v1/appointments',
    method: 'GET',
    ...request,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

/** Reflector stub returning fixed metadata for the route under test. */
function reflectorWith(meta: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => meta[key],
  } as unknown as Reflector;
}

describe('TenantGuard', () => {
  let context: RequestContextService;

  const build = (
    meta: Record<string, unknown>,
    resolve: TenantResolverChain['resolve'],
    authorize: MembershipService['authorize'],
  ) =>
    new TenantGuard(
      reflectorWith(meta),
      { resolve } as unknown as TenantResolverChain,
      { authorize } as unknown as MembershipService,
      context,
    );

  const withActor = <T>(actor: Actor | null, fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      context.run(
        {
          requestId: 'r',
          actor: actor ?? { kind: 'SYSTEM', name: 'anonymous' },
          tenant: null,
          startedAt: new Date(),
        },
        () => void fn().then(resolve, reject),
      );
    });

  beforeEach(() => {
    context = new RequestContextService();
  });

  describe('opt-outs', () => {
    it.each([
      ['public', { [META_IS_PUBLIC]: true }],
      ['no-tenant', { [META_NO_TENANT]: true }],
      ['platform-only', { [META_PLATFORM_ONLY]: true }],
    ])('skips resolution for a %s route', async (_label, meta) => {
      const resolve = jest.fn();
      const guard = build(meta, resolve as never, jest.fn() as never);

      await expect(guard.canActivate(executionContext())).resolves.toBe(true);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe('deny by default', () => {
    // A route with no decorators is company-scoped. Forgetting a decorator must
    // make an endpoint unreachable, never unscoped.
    it('requires authentication on an undecorated route', async () => {
      const guard = build({}, jest.fn() as never, jest.fn() as never);
      await withActor(null, async () => {
        await expect(guard.canActivate(executionContext())).rejects.toThrow(UnauthenticatedError);
      });
    });

    it('fails when nothing resolves a company', async () => {
      const guard = build({}, (async () => null) as never, jest.fn() as never);
      await withActor(userA, async () => {
        await expect(guard.canActivate(executionContext())).rejects.toThrow(TenantUnresolvedError);
      });
    });
  });

  describe('the nested-resource attack', () => {
    // GET /api/v1/companies/<company-B>/appointments as a company A user.
    // The guard reads the id happily — reading it is not the vulnerability.
    // The defence is that it goes to MembershipService, which finds nothing.
    it('reads a foreign companyId from the route and then refuses it', async () => {
      const authorize = jest.fn(async () => {
        throw new TenantNotFoundError();
      });
      const guard = build(
        {},
        (async () => ({
          companyId: COMPANY_B,
          source: 'ROUTE_PARAM' as const,
          explicit: true,
          matchedBy: ['route-param'],
        })) as never,
        authorize as never,
      );

      await withActor(userA, async () => {
        const error = await guard
          .canActivate(executionContext({ params: { companyId: COMPANY_B } }))
          .catch((e) => e);

        expect(error).toBeInstanceOf(TenantNotFoundError);
        expect((error as TenantNotFoundError).status).toBe(404);
        // Resolution happened; authorization is what said no.
        expect(authorize).toHaveBeenCalledWith(userA, COMPANY_B, 'ROUTE_PARAM');
      });
    });

    it('leaves no tenant attached when authorization fails', async () => {
      const guard = build(
        {},
        (async () => ({
          companyId: COMPANY_B,
          source: 'ROUTE_PARAM' as const,
          explicit: true,
          matchedBy: [],
        })) as never,
        (async () => {
          throw new TenantNotFoundError();
        }) as never,
      );

      await withActor(userA, async () => {
        await guard.canActivate(executionContext()).catch(() => undefined);
        expect(context.tenantOrNull()).toBeNull();
      });
    });
  });

  describe('happy path', () => {
    it('attaches the authorised tenant to the context and the request', async () => {
      const guard = build(
        {},
        (async () => ({
          companyId: COMPANY_A,
          source: 'ACTIVE_COMPANY_CLAIM' as const,
          explicit: false,
          matchedBy: ['active-company-claim'],
        })) as never,
        (async () => tenantFor(COMPANY_A)) as never,
      );

      await withActor(userA, async () => {
        const ctx = executionContext();
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(context.requireCompanyId()).toBe(COMPANY_A);

        const request = ctx.switchToHttp().getRequest() as Record<string, unknown>;
        expect((request[REQUEST_CONTEXT_KEY] as { tenant: TenantContext }).tenant.company.id).toBe(
          COMPANY_A,
        );
      });
    });

    it('passes the verified active company to the resolver chain, not a header', async () => {
      const resolve = jest.fn(async (_input: TenantResolutionInput) => ({
        companyId: COMPANY_A,
        source: 'ACTIVE_COMPANY_CLAIM' as const,
        explicit: false,
        matchedBy: [],
      }));
      const guard = build({}, resolve as never, (async () => tenantFor(COMPANY_A)) as never);

      await withActor(userA, async () => {
        await guard.canActivate(
          executionContext({
            verifiedActiveCompanyId: COMPANY_A,
            headers: { 'x-internal-active-company': COMPANY_B },
          }),
        );
      });

      expect(resolve.mock.calls[0]?.[0]).toMatchObject({ activeCompanyId: COMPANY_A });
    });
  });

  describe('platform operators', () => {
    it('refuses a platform token on an ordinary company route', async () => {
      // Cross-company reach is opt-in per endpoint, so it is greppable rather
      // than emergent.
      const guard = build({}, jest.fn() as never, jest.fn() as never);
      await withActor(operator, async () => {
        await expect(guard.canActivate(executionContext())).rejects.toThrow(
          PlatformAccessNotTargetedError,
        );
      });
    });

    it('refuses an operator who did not name a company explicitly', async () => {
      const guard = build(
        { [META_ALLOW_PLATFORM_ACCESS]: true },
        (async () => ({
          companyId: COMPANY_A,
          source: 'ACTIVE_COMPANY_CLAIM' as const,
          explicit: false,
          matchedBy: [],
        })) as never,
        jest.fn() as never,
      );

      await withActor(operator, async () => {
        await expect(guard.canActivate(executionContext())).rejects.toThrow(
          PlatformAccessNotTargetedError,
        );
      });
    });

    it('allows an explicitly targeted operator on an opted-in route', async () => {
      const guard = build(
        { [META_ALLOW_PLATFORM_ACCESS]: true },
        (async () => ({
          companyId: COMPANY_A,
          source: 'HEADER' as const,
          explicit: true,
          matchedBy: ['header'],
        })) as never,
        (async () => tenantFor(COMPANY_A, true)) as never,
      );

      await withActor(operator, async () => {
        await expect(
          guard.canActivate(executionContext({ headers: { 'x-company-id': COMPANY_A } })),
        ).resolves.toBe(true);
        expect(context.isPlatformAccess).toBe(true);
        expect(context.membership()).toBeNull();
      });
    });
  });
});
