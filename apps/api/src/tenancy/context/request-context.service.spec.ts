import { MissingTenantContextError, UnauthenticatedError } from '../../common/errors';
import { RequestContextService } from './request-context.service';
import type { Actor, RequestContext, TenantContext } from './context.types';

const companyUser: Actor = {
  kind: 'COMPANY_USER',
  userAccountId: 'user-a',
  email: 'a@example.com',
  displayName: 'User A',
  sessionId: 'session-a',
};

function tenantFor(companyId: string, slug = companyId): TenantContext {
  return {
    company: {
      id: companyId,
      slug,
      status: 'ACTIVE',
      operationalStatus: 'ACTIVE',
      defaultTimezoneName: 'Asia/Ulaanbaatar',
      currencyCode: 'MNT',
    },
    membership: {
      companyUserId: `cu-${companyId}`,
      userAccountId: 'user-a',
      isOwner: false,
      roleKeys: ['RECEPTIONIST'],
      branchScope: null,
    },
    permissions: new Set(['customer:read']),
    source: 'ACTIVE_COMPANY_CLAIM',
    viaPlatformAccess: false,
  };
}

function contextFor(actor: Actor = companyUser): RequestContext {
  return {
    requestId: 'req-1',
    actor,
    tenant: null,
    startedAt: new Date(),
  };
}

describe('RequestContextService', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  describe('the no-silent-fallback invariant', () => {
    // This is the behaviour the whole design rests on: code that needs a
    // company either gets one or the request fails. There must be no path that
    // returns "no tenant, carry on" to a caller that was about to build a query.
    it('throws rather than returning null when no context has been entered', () => {
      expect(() => service.requireTenant('read customers')).toThrow(MissingTenantContextError);
      expect(() => service.requireCompanyId()).toThrow(MissingTenantContextError);
    });

    it('throws when a context exists but no tenant has been attached', () => {
      service.run(contextFor(), () => {
        expect(() => service.requireTenant()).toThrow(MissingTenantContextError);
      });
    });

    it('names the operation in the error so the missing guard is findable', () => {
      try {
        service.requireTenant('AppointmentRepository.findMany');
        fail('expected requireTenant to throw');
      } catch (error) {
        expect((error as Error).message).toContain('AppointmentRepository.findMany');
        expect((error as Error).message).toContain('TenantGuard');
      }
    });

    it('exposes tenantOrNull for the few callers that legitimately branch on it', () => {
      expect(service.tenantOrNull()).toBeNull();
    });
  });

  describe('actor', () => {
    it('requires an actor', () => {
      expect(() => service.requireActor()).toThrow(UnauthenticatedError);
    });

    it('is replaced in place by attachActor', () => {
      service.run(contextFor({ kind: 'SYSTEM', name: 'anonymous' }), () => {
        expect(service.actor).toEqual({ kind: 'SYSTEM', name: 'anonymous' });
        service.attachActor(companyUser);
        expect(service.requireActor()).toBe(companyUser);
      });
    });
  });

  describe('attachTenant', () => {
    it('makes the tenant visible to everything downstream', () => {
      service.run(contextFor(), () => {
        service.attachTenant(tenantFor('company-a'));
        expect(service.requireCompanyId()).toBe('company-a');
        expect(service.hasPermission('customer:read')).toBe(true);
        expect(service.hasPermission('payment:refund')).toBe(false);
      });
    });

    it('refuses to switch company mid-request', () => {
      // A request that changes tenant halfway is either a bug or an attack.
      // There is no legitimate case, so it fails loudly.
      service.run(contextFor(), () => {
        service.attachTenant(tenantFor('company-a'));
        expect(() => service.attachTenant(tenantFor('company-b'))).toThrow(
          MissingTenantContextError,
        );
        expect(service.requireCompanyId()).toBe('company-a');
      });
    });

    it('is idempotent for the same company', () => {
      service.run(contextFor(), () => {
        service.attachTenant(tenantFor('company-a'));
        expect(() => service.attachTenant(tenantFor('company-a'))).not.toThrow();
      });
    });

    it('throws outside any context', () => {
      expect(() => service.attachTenant(tenantFor('company-a'))).toThrow(MissingTenantContextError);
    });
  });

  describe('async isolation', () => {
    // The property that makes AsyncLocalStorage safe here: two requests in
    // flight must never see each other's company, however they interleave.
    it('keeps concurrent flows separate', async () => {
      const observed: string[] = [];

      // `run` returns whatever the callback returns — here a promise. It is
      // settled through the enclosing `resolve`, so the return value is
      // deliberately discarded rather than awaited.
      const flow = (companyId: string, delay: number) =>
        new Promise<void>((resolve, reject) => {
          void service.run(contextFor(), async () => {
            try {
              service.attachTenant(tenantFor(companyId));
              await new Promise((r) => setTimeout(r, delay));
              observed.push(`${companyId}:${service.requireCompanyId()}`);
              resolve();
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        });

      await Promise.all([flow('company-a', 20), flow('company-b', 5), flow('company-c', 10)]);

      // Each flow must have seen its own company, whatever the completion order.
      expect(observed.sort()).toEqual([
        'company-a:company-a',
        'company-b:company-b',
        'company-c:company-c',
      ]);
    });

    it('does not leak the tenant out of run()', async () => {
      await new Promise<void>((resolve) => {
        service.run(contextFor(), () => {
          service.attachTenant(tenantFor('company-a'));
          resolve();
        });
      });

      expect(() => service.requireTenant()).toThrow(MissingTenantContextError);
    });
  });

  describe('runAsSystem', () => {
    it('gives background work a company without an HTTP request', () => {
      service.runAsSystem('reminder-dispatch', tenantFor('company-a'), () => {
        expect(service.requireCompanyId()).toBe('company-a');
        expect(service.requireActor()).toEqual({ kind: 'SYSTEM', name: 'reminder-dispatch' });
      });
    });

    it('supports a null tenant for genuinely platform-wide work', () => {
      service.runAsSystem('nightly-reconciliation', null, () => {
        expect(service.tenantOrNull()).toBeNull();
        expect(() => service.requireTenant()).toThrow(MissingTenantContextError);
      });
    });
  });
});
