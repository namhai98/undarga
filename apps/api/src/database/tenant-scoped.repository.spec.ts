import { MissingTenantContextError, ResourceNotFoundError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import type { TenantContext } from '../tenancy/context/context.types';
import { TenantScopedRepository, type PrismaDelegateLike } from './tenant-scoped.repository';
import type { TenantPrismaService, TenantTx } from './tenant-prisma.service';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';

interface Row {
  id: string;
  companyId: string;
  label?: string;
}

/**
 * A delegate that behaves like Prisma: it actually applies the `where` it is
 * given. That is the point — the tests assert on OUTCOMES (company B's row is
 * not returned) as well as on the emitted filter, so a repository that dropped
 * the tenant predicate would fail even if the call shape looked right.
 */
function fakeDelegate(rows: Row[]) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];

  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'deletedAt') return true;
      return (row as unknown as Record<string, unknown>)[key] === value;
    });

  const delegate: PrismaDelegateLike<Row> & { calls: typeof calls } = {
    calls,
    async findFirst(args) {
      const a = args as { where?: Record<string, unknown> };
      calls.push({ op: 'findFirst', args: a as Record<string, unknown> });
      return rows.find((r) => matches(r, a.where)) ?? null;
    },
    async findMany(args) {
      const a = args as { where?: Record<string, unknown> };
      calls.push({ op: 'findMany', args: a as Record<string, unknown> });
      return rows.filter((r) => matches(r, a.where));
    },
    async count(args) {
      const a = args as { where?: Record<string, unknown> };
      calls.push({ op: 'count', args: a as Record<string, unknown> });
      return rows.filter((r) => matches(r, a.where)).length;
    },
    async create(args) {
      const a = args as { data: Row };
      calls.push({ op: 'create', args: a as unknown as Record<string, unknown> });
      const created = { ...a.data, id: a.data.id ?? 'new-id' };
      rows.push(created);
      return created;
    },
    async update(args) {
      calls.push({ op: 'update', args: args as Record<string, unknown> });
      throw new Error('update() must not be used: it leaks existence through P2025');
    },
    async updateMany(args) {
      const a = args as { where?: Record<string, unknown>; data: Record<string, unknown> };
      calls.push({ op: 'updateMany', args: a as Record<string, unknown> });
      const hits = rows.filter((r) => matches(r, a.where));
      hits.forEach((r) => Object.assign(r, a.data));
      return { count: hits.length };
    },
    async delete(args) {
      calls.push({ op: 'delete', args: args as Record<string, unknown> });
      throw new Error('delete() must not be used: it leaks existence through P2025');
    },
    async deleteMany(args) {
      const a = args as { where?: Record<string, unknown> };
      calls.push({ op: 'deleteMany', args: a as Record<string, unknown> });
      const hits = rows.filter((r) => matches(r, a.where));
      hits.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { count: hits.length };
    },
  };

  return delegate;
}

class TestRepository extends TenantScopedRepository<Row> {
  protected readonly modelName = 'TestModel';

  constructor(
    db: TenantPrismaService,
    context: RequestContextService,
    private readonly del: PrismaDelegateLike<Row>,
  ) {
    super(db, context);
  }

  protected delegate(): PrismaDelegateLike<Row> {
    return this.del;
  }
}

function tenantFor(companyId: string): TenantContext {
  return {
    company: {
      id: companyId,
      slug: 'x',
      status: 'ACTIVE',
      operationalStatus: 'ACTIVE',
      defaultTimezoneName: 'UTC',
      currencyCode: 'MNT',
    },
    membership: null,
    permissions: new Set(),
    source: 'ACTIVE_COMPANY_CLAIM',
    viaPlatformAccess: false,
  };
}

describe('TenantScopedRepository', () => {
  let context: RequestContextService;
  let db: TenantPrismaService;
  let delegate: ReturnType<typeof fakeDelegate>;
  let repo: TestRepository;

  const seed = (): Row[] => [
    { id: 'row-a1', companyId: COMPANY_A, label: 'A one' },
    { id: 'row-a2', companyId: COMPANY_A, label: 'A two' },
    { id: 'row-b1', companyId: COMPANY_B, label: 'B one' },
  ];

  beforeEach(() => {
    context = new RequestContextService();
    db = {
      run: <T>(fn: (tx: TenantTx) => Promise<T>) => fn({} as TenantTx),
    } as unknown as TenantPrismaService;
    delegate = fakeDelegate(seed());
    repo = new TestRepository(db, context, delegate);
  });

  const asCompanyA = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      context.run(
        { requestId: 'r', actor: { kind: 'SYSTEM', name: 't' }, tenant: null, startedAt: new Date() },
        () => {
          context.attachTenant(tenantFor(COMPANY_A));
          fn().then(resolve, reject);
        },
      );
    });

  describe('without a tenant context', () => {
    it('refuses every operation rather than running unscoped', async () => {
      await expect(repo.findMany()).rejects.toThrow(MissingTenantContextError);
      await expect(repo.findById('row-a1')).rejects.toThrow(MissingTenantContextError);
      await expect(repo.create({ label: 'x' })).rejects.toThrow(MissingTenantContextError);
      await expect(repo.deleteById('row-a1')).rejects.toThrow(MissingTenantContextError);
      expect(delegate.calls).toHaveLength(0);
    });
  });

  describe('cross-company read', () => {
    it('returns only this company rows from findMany', async () => {
      const rows = await asCompanyA(() => repo.findMany());
      expect(rows.map((r) => r.id)).toEqual(['row-a1', 'row-a2']);
    });

    it('always puts companyId in the emitted filter', async () => {
      await asCompanyA(() => repo.findMany({ label: 'A one' }));
      expect(delegate.calls[0]?.args.where).toEqual({ label: 'A one', companyId: COMPANY_A });
    });

    it('cannot be tricked into widening by a caller-supplied companyId', async () => {
      // companyId is merged last, so a caller passing their own is overwritten.
      await asCompanyA(() => repo.findMany({ companyId: COMPANY_B } as never));
      expect((delegate.calls[0]?.args.where as Record<string, unknown>).companyId).toBe(COMPANY_A);
    });

    it('returns null for another company id', async () => {
      await expect(asCompanyA(() => repo.findById('row-b1'))).resolves.toBeNull();
    });

    it('raises a plain 404 from requireById for another company id', async () => {
      const error = await asCompanyA(() => repo.requireById('row-b1')).catch((e) => e);
      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).status).toBe(404);
      // Identical to a genuinely missing row: no existence oracle.
      const missing = await asCompanyA(() => repo.requireById('no-such-row')).catch((e) => e);
      expect((error as Error).message).toBe((missing as Error).message);
    });
  });

  describe('cross-company update', () => {
    it('does not modify another company row', async () => {
      const result = await asCompanyA(() => repo.updateById('row-b1', { label: 'hijacked' }));
      expect(result).toBeNull();
      expect(delegate.calls.some((c) => c.op === 'update')).toBe(false);
      // The fake throws if `update` is used, so reaching here also proves the
      // repository used updateMany — see the class comment on why that matters.
    });

    it('updates a row that does belong to this company', async () => {
      const result = await asCompanyA(() => repo.updateById('row-a1', { label: 'renamed' }));
      expect(result?.label).toBe('renamed');
    });

    it('strips companyId from the update payload', async () => {
      await asCompanyA(() => repo.updateById('row-a1', { companyId: COMPANY_B, label: 'x' }));
      const call = delegate.calls.find((c) => c.op === 'updateMany');
      expect(call?.args.data).toEqual({ label: 'x' });
    });

    it('raises 404 from requireUpdateById for another company row', async () => {
      await expect(asCompanyA(() => repo.requireUpdateById('row-b1', { label: 'x' }))).rejects.toThrow(
        ResourceNotFoundError,
      );
    });
  });

  describe('cross-company delete', () => {
    it('does not remove another company row', async () => {
      const deleted = await asCompanyA(() => repo.deleteById('row-b1'));
      expect(deleted).toBe(false);
      expect(delegate.calls.some((c) => c.op === 'delete')).toBe(false);
    });

    it('removes a row that does belong to this company', async () => {
      await expect(asCompanyA(() => repo.deleteById('row-a1'))).resolves.toBe(true);
    });

    it('raises 404 from requireDeleteById for another company row', async () => {
      await expect(asCompanyA(() => repo.requireDeleteById('row-b1'))).rejects.toThrow(
        ResourceNotFoundError,
      );
    });
  });

  describe('create', () => {
    it('stamps the current company', async () => {
      await asCompanyA(() => repo.create({ label: 'fresh' }));
      const call = delegate.calls.find((c) => c.op === 'create');
      expect((call?.args.data as Row).companyId).toBe(COMPANY_A);
    });

    it('overrides a caller-supplied company', async () => {
      await asCompanyA(() => repo.create({ label: 'fresh', companyId: COMPANY_B }));
      const call = delegate.calls.find((c) => c.op === 'create');
      expect((call?.args.data as Row).companyId).toBe(COMPANY_A);
    });
  });

  describe('count and exists', () => {
    it('counts only this company', async () => {
      await expect(asCompanyA(() => repo.count())).resolves.toBe(2);
    });

    it('reports another company row as non-existent', async () => {
      await expect(asCompanyA(() => repo.exists('row-b1'))).resolves.toBe(false);
    });
  });
});
