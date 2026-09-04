import {
  MembershipInactiveError,
  PlatformAccessRequiredError,
  TenantNotFoundError,
  TenantSuspendedError,
} from '../../common/errors';
import { COMPANY_PERMISSIONS, PLATFORM_PERMISSIONS } from '../../authz/permissions';
import type { AppConfig } from '../../config';
import type { TenantPrismaService } from '../../database/tenant-prisma.service';
import type { TenantDirectoryService } from '../directory/tenant-directory.service';
import { MembershipService } from './membership.service';
import type { Actor } from '../context/context.types';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';

const userA: Actor = {
  kind: 'COMPANY_USER',
  userAccountId: 'user-a',
  email: 'a@example.com',
  displayName: 'User A',
  sessionId: 'sess-a',
};

interface FakeRow {
  companyUserId: string;
  status: string;
  isOwner: boolean;
  roleKeys: string[];
  permissions: string[];
  branches: string[];
}

/**
 * A stand-in for the tenant connection.
 *
 * Records which company was set, so the tests can assert that the membership
 * lookup really did run inside the candidate's RLS scope rather than somewhere
 * broader.
 */
function fakeDb(memberships: Record<string, FakeRow | undefined>) {
  const scopesUsed: string[] = [];

  const db = {
    scopesUsed,
    runInCompany: async <T>(companyId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      scopesUsed.push(companyId);
      const key = companyId;
      const row = memberships[key];

      const tx = {
        companyUser: {
          findFirst: async () =>
            row ? { id: row.companyUserId, status: row.status, isOwner: row.isOwner } : null,
        },
        companyUserRole: {
          findMany: async () => (row ? row.roleKeys.map((k) => ({ roleId: `role-${k}` })) : []),
        },
        companyRole: {
          findMany: async () => (row ? row.roleKeys.map((k) => ({ key: k })) : []),
        },
        companyRolePermission: {
          findMany: async () => (row ? row.permissions.map((p) => ({ permissionKey: p })) : []),
        },
        companyUserBranch: {
          findMany: async () => (row ? row.branches.map((b) => ({ branchId: b })) : []),
        },
      };

      return fn(tx);
    },
  };

  return db as unknown as TenantPrismaService & { scopesUsed: string[] };
}

function fakeDirectory(companies: Record<string, { status: string; deletedAt?: Date | null }>) {
  return {
    getCompany: async (id: string) => {
      const c = companies[id];
      if (!c) return null;
      return {
        id,
        slug: id === COMPANY_A ? 'company-a' : 'company-b',
        status: c.status,
        defaultTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        deletedAt: c.deletedAt ?? null,
      };
    },
  } as unknown as TenantDirectoryService;
}

// Caching off, so each test observes a fresh lookup.
const config = { tenancy: { cacheTtlSeconds: 0 } } as AppConfig;

describe('MembershipService', () => {
  describe('company users', () => {
    it('grants access to a company the user belongs to', async () => {
      const service = new MembershipService(
        fakeDb({
          [COMPANY_A]: {
            companyUserId: 'cu-a',
            status: 'ACTIVE',
            isOwner: false,
            roleKeys: ['RECEPTIONIST'],
            permissions: [COMPANY_PERMISSIONS.CUSTOMER_READ],
            branches: [],
          },
        }),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const tenant = await service.authorize(userA, COMPANY_A, 'ACTIVE_COMPANY_CLAIM');

      expect(tenant.company.id).toBe(COMPANY_A);
      expect(tenant.membership?.companyUserId).toBe('cu-a');
      expect(tenant.permissions.has(COMPANY_PERMISSIONS.CUSTOMER_READ)).toBe(true);
      expect(tenant.viaPlatformAccess).toBe(false);
    });

    // The single most important assertion in this file. "No such company" and
    // "not your company" MUST be the same error, or any id becomes an existence
    // oracle — and UUIDv7 ids also encode a creation timestamp.
    it('returns the SAME error for a company that does not exist and one the user is not in', async () => {
      const service = new MembershipService(
        fakeDb({
          [COMPANY_A]: {
            companyUserId: 'cu-a',
            status: 'ACTIVE',
            isOwner: false,
            roleKeys: [],
            permissions: [],
            branches: [],
          },
        }),
        fakeDirectory({
          [COMPANY_A]: { status: 'ACTIVE' },
          [COMPANY_B]: { status: 'ACTIVE' },
        }),
        config,
      );

      const notAMember = await service
        .authorize(userA, COMPANY_B, 'ROUTE_PARAM')
        .catch((e: unknown) => e);
      const doesNotExist = await service
        .authorize(userA, '018f0000-0000-7000-8000-0000000000ff', 'ROUTE_PARAM')
        .catch((e: unknown) => e);

      expect(notAMember).toBeInstanceOf(TenantNotFoundError);
      expect(doesNotExist).toBeInstanceOf(TenantNotFoundError);
      expect((notAMember as TenantNotFoundError).status).toBe(404);
      expect((notAMember as TenantNotFoundError).message).toBe(
        (doesNotExist as TenantNotFoundError).message,
      );
    });

    it('runs the membership lookup inside the candidate company scope', async () => {
      // Not incidental: doing this check on the BYPASSRLS connection would mean
      // the authorization decision is made outside the mechanism that enforces
      // authorization. Scoping it means a broken RLS policy fails closed.
      const db = fakeDb({});
      const service = new MembershipService(
        db,
        fakeDirectory({ [COMPANY_B]: { status: 'ACTIVE' } }),
        config,
      );

      await expect(service.authorize(userA, COMPANY_B, 'ROUTE_PARAM')).rejects.toThrow(
        TenantNotFoundError,
      );
      expect(db.scopesUsed).toEqual([COMPANY_B]);
    });

    it('reports an inactive membership distinctly', async () => {
      // Safe to be specific: the user knows they were invited to this company,
      // so saying the invitation is pending leaks nothing.
      const service = new MembershipService(
        fakeDb({
          [COMPANY_A]: {
            companyUserId: 'cu-a',
            status: 'INVITED',
            isOwner: false,
            roleKeys: [],
            permissions: [],
            branches: [],
          },
        }),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      await expect(service.authorize(userA, COMPANY_A, 'ROUTE_PARAM')).rejects.toThrow(
        MembershipInactiveError,
      );
    });

    it('grants an owner the whole catalog regardless of stored role rows', async () => {
      const service = new MembershipService(
        fakeDb({
          [COMPANY_A]: {
            companyUserId: 'cu-a',
            status: 'ACTIVE',
            isOwner: true,
            roleKeys: [],
            permissions: [],
            branches: [],
          },
        }),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const tenant = await service.authorize(userA, COMPANY_A, 'ROUTE_PARAM');
      expect(tenant.permissions.has(COMPANY_PERMISSIONS.PAYMENT_REFUND)).toBe(true);
      expect(tenant.permissions.has(COMPANY_PERMISSIONS.BILLING_WRITE)).toBe(true);
    });

    it('distinguishes "all branches" from "no branches"', async () => {
      const service = new MembershipService(
        fakeDb({
          [COMPANY_A]: {
            companyUserId: 'cu-a',
            status: 'ACTIVE',
            isOwner: false,
            roleKeys: [],
            permissions: [],
            branches: [],
          },
        }),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const tenant = await service.authorize(userA, COMPANY_A, 'ROUTE_PARAM');
      // null is the wildcard; an empty array would mean "scoped to nothing".
      expect(tenant.membership?.branchScope).toBeNull();
    });

    it('refuses a suspended company, but only after membership is proven', async () => {
      const service = new MembershipService(
        fakeDb({
          [COMPANY_A]: {
            companyUserId: 'cu-a',
            status: 'ACTIVE',
            isOwner: false,
            roleKeys: [],
            permissions: [],
            branches: [],
          },
        }),
        fakeDirectory({ [COMPANY_A]: { status: 'SUSPENDED' } }),
        config,
      );

      await expect(service.authorize(userA, COMPANY_A, 'ROUTE_PARAM')).rejects.toThrow(
        TenantSuspendedError,
      );
    });

    it('treats a soft-deleted company as absent', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE', deletedAt: new Date() } }),
        config,
      );

      await expect(service.authorize(userA, COMPANY_A, 'ROUTE_PARAM')).rejects.toThrow(
        TenantNotFoundError,
      );
    });
  });

  describe('platform operators', () => {
    const operator = (
      permissions: string[],
      impersonation?: Actor['kind'] extends never ? never : unknown,
    ): Actor =>
      ({
        kind: 'PLATFORM_USER',
        platformUserId: 'op-1',
        email: 'ops@platform.test',
        displayName: 'Operator',
        sessionId: 'sess-op',
        platformPermissions: new Set(permissions),
        ...(impersonation ? { impersonation } : {}),
      }) as Actor;

    it('is refused without an explicit platform data permission', async () => {
      // No company role can ever contain a platform:* key, so a company OWNER
      // cannot reach this branch by escalating inside their tenant.
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      await expect(
        service.authorize(operator([PLATFORM_PERMISSIONS.COMPANY_LIST]), COMPANY_A, 'HEADER'),
      ).rejects.toThrow(PlatformAccessRequiredError);
    });

    it('grants read-only company permissions with data:read', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const tenant = await service.authorize(
        operator([PLATFORM_PERMISSIONS.COMPANY_DATA_READ]),
        COMPANY_A,
        'HEADER',
      );

      expect(tenant.viaPlatformAccess).toBe(true);
      expect(tenant.membership).toBeNull();
      expect(tenant.permissions.has(COMPANY_PERMISSIONS.CUSTOMER_READ)).toBe(true);
      expect(tenant.permissions.has(COMPANY_PERMISSIONS.PAYMENT_REFUND)).toBe(false);
    });

    it('grants write access only with data:write', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const tenant = await service.authorize(
        operator([PLATFORM_PERMISSIONS.COMPANY_DATA_READ, PLATFORM_PERMISSIONS.COMPANY_DATA_WRITE]),
        COMPANY_A,
        'HEADER',
      );

      expect(tenant.permissions.has(COMPANY_PERMISSIONS.PAYMENT_REFUND)).toBe(true);
    });

    it('confines an operator holding an impersonation grant to that grant company', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({
          [COMPANY_A]: { status: 'ACTIVE' },
          [COMPANY_B]: { status: 'ACTIVE' },
        }),
        config,
      );

      const withGrant = operator([PLATFORM_PERMISSIONS.COMPANY_DATA_READ], {
        grantId: 'grant-1',
        companyId: COMPANY_A,
        allowWrites: false,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.authorize(withGrant, COMPANY_A, 'HEADER')).resolves.toBeDefined();
      // A grant narrows; it never widens.
      await expect(service.authorize(withGrant, COMPANY_B, 'HEADER')).rejects.toThrow(
        TenantNotFoundError,
      );
    });

    it('refuses an expired impersonation grant', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const expired = operator([PLATFORM_PERMISSIONS.COMPANY_DATA_READ], {
        grantId: 'grant-1',
        companyId: COMPANY_A,
        allowWrites: true,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.authorize(expired, COMPANY_A, 'HEADER')).rejects.toThrow(
        PlatformAccessRequiredError,
      );
    });

    it('downgrades to read-only when the grant forbids writes', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_A]: { status: 'ACTIVE' } }),
        config,
      );

      const readOnlyGrant = operator(
        [PLATFORM_PERMISSIONS.COMPANY_DATA_READ, PLATFORM_PERMISSIONS.COMPANY_DATA_WRITE],
        {
          grantId: 'grant-1',
          companyId: COMPANY_A,
          allowWrites: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
      );

      const tenant = await service.authorize(readOnlyGrant, COMPANY_A, 'HEADER');
      expect(tenant.permissions.has(COMPANY_PERMISSIONS.PAYMENT_REFUND)).toBe(false);
    });
  });

  describe('customers', () => {
    it('rejects a customer token presented against another company', async () => {
      const service = new MembershipService(
        fakeDb({}),
        fakeDirectory({ [COMPANY_B]: { status: 'ACTIVE' } }),
        config,
      );

      const customer: Actor = {
        kind: 'CUSTOMER',
        customerIdentityId: 'ident-1',
        companyCustomerId: 'cc-1',
        companyId: COMPANY_A,
      };

      await expect(service.authorize(customer, COMPANY_B, 'ROUTE_PARAM')).rejects.toThrow(
        TenantNotFoundError,
      );
    });
  });
});
