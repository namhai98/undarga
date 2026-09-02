import { ResourceNotFoundError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import type { TenantPrismaService, TenantTx } from './tenant-prisma.service';

/**
 * The structural shape of a Prisma model delegate. Declared here rather than
 * imported so the base class does not need the generated client's exact types,
 * which keeps it testable with a plain fake.
 */
export interface PrismaDelegateLike<TRecord> {
  findFirst(args: unknown): Promise<TRecord | null>;
  findMany(args: unknown): Promise<TRecord[]>;
  create(args: unknown): Promise<TRecord>;
  update(args: unknown): Promise<TRecord>;
  updateMany(args: unknown): Promise<{ count: number }>;
  delete(args: unknown): Promise<TRecord>;
  deleteMany(args: unknown): Promise<{ count: number }>;
  count(args: unknown): Promise<number>;
}

export interface ListOptions {
  skip?: number;
  take?: number;
  orderBy?: unknown;
  include?: unknown;
  select?: unknown;
}

/**
 * Base class for every company-owned repository.
 *
 * ---------------------------------------------------------------------------
 * THE ONE IDEA
 * ---------------------------------------------------------------------------
 *
 * `companyId` comes from the request context and is merged into every filter
 * here, in one place. Subclasses cannot forget it, because they never write it.
 *
 * That makes the four cross-tenant attacks structurally uninteresting:
 *
 *   READ    findById('other-companys-uuid') -> findFirst({ companyId: mine,
 *           id: theirs }) -> null -> 404.
 *   UPDATE  updateById(...) -> updateMany({ companyId: mine, id: theirs })
 *           -> count 0 -> 404. Note updateMany, not update: `update` on a
 *           where-unique that matches another tenant would throw a Prisma
 *           P2025 whose message differs from a genuine miss, which is an
 *           existence oracle. A count of zero looks identical either way.
 *   DELETE  same shape as update.
 *   ENUMERATE  knowing the uuid changes nothing; the companyId predicate is
 *           always ANDed, and RLS refuses the row underneath regardless.
 *
 * ---------------------------------------------------------------------------
 * WHY A BASE CLASS AND NOT JUST THE PRISMA EXTENSION
 * ---------------------------------------------------------------------------
 *
 * The extension refuses unscoped queries; it does not write correct ones. This
 * class is what makes the correct thing also the easy thing, so developers are
 * not fighting the assertion all day. The two are complementary: the repository
 * is the paved road, the extension is the guard rail beside it, and RLS is the
 * ditch beyond that.
 */
export abstract class TenantScopedRepository<TRecord extends { id: string }> {
  protected constructor(
    protected readonly db: TenantPrismaService,
    protected readonly context: RequestContextService,
  ) {}

  /** Prisma model name, used in not-found errors and diagnostics. */
  protected abstract readonly modelName: string;

  /** The delegate for this model on a given transaction client. */
  protected abstract delegate(tx: TenantTx): PrismaDelegateLike<TRecord>;

  /**
   * The company this repository is bound to for the current unit of work.
   * Throws when there is no tenant context — never returns a wildcard.
   */
  protected get companyId(): string {
    return this.context.requireCompanyId(`${this.modelName} repository`);
  }

  /** Merge the tenant predicate into a caller-supplied filter. */
  protected scoped(where: Record<string, unknown> = {}): Record<string, unknown> {
    // companyId last so a caller cannot override it by passing their own.
    return { ...where, companyId: this.companyId };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findById(id: string, options: ListOptions = {}): Promise<TRecord | null> {
    return this.db.run(
      (tx) =>
        this.delegate(tx).findFirst({
          where: this.scoped({ id }),
          ...pick(options, ['include', 'select']),
        }),
      `${this.modelName}.findById`,
    );
  }

  /** Same as findById, but a miss is a 404 rather than a null to forget about. */
  async requireById(id: string, options: ListOptions = {}): Promise<TRecord> {
    const found = await this.findById(id, options);
    if (!found) {
      throw new ResourceNotFoundError(this.modelName, id);
    }
    return found;
  }

  async findMany(
    where: Record<string, unknown> = {},
    options: ListOptions = {},
  ): Promise<TRecord[]> {
    return this.db.run(
      (tx) =>
        this.delegate(tx).findMany({
          where: this.scoped(where),
          ...pick(options, ['skip', 'take', 'orderBy', 'include', 'select']),
        }),
      `${this.modelName}.findMany`,
    );
  }

  async findFirst(
    where: Record<string, unknown> = {},
    options: ListOptions = {},
  ): Promise<TRecord | null> {
    return this.db.run(
      (tx) =>
        this.delegate(tx).findFirst({
          where: this.scoped(where),
          ...pick(options, ['orderBy', 'include', 'select']),
        }),
      `${this.modelName}.findFirst`,
    );
  }

  async count(where: Record<string, unknown> = {}): Promise<number> {
    return this.db.run(
      (tx) => this.delegate(tx).count({ where: this.scoped(where) }),
      `${this.modelName}.count`,
    );
  }

  async exists(id: string): Promise<boolean> {
    return (await this.count({ id })) > 0;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * `companyId` is supplied here, not by the caller — which is why the input
   * type omits it. A caller that passes one has it overwritten rather than
   * honoured.
   */
  async create(data: Record<string, unknown>): Promise<TRecord> {
    return this.db.run(
      (tx) => this.delegate(tx).create({ data: { ...data, companyId: this.companyId } }),
      `${this.modelName}.create`,
    );
  }

  /**
   * Returns null when nothing matched, which covers both "no such row" and
   * "belongs to another company" with an identical response. Callers wanting a
   * 404 should use `requireUpdateById`.
   */
  async updateById(id: string, data: Record<string, unknown>): Promise<TRecord | null> {
    return this.db.run(async (tx) => {
      const delegate = this.delegate(tx);
      // updateMany, then re-read: a single `update` would leak existence
      // through the shape of its error. See the class comment.
      const { count } = await delegate.updateMany({
        where: this.scoped({ id }),
        data: stripTenantKeys(data),
      });
      if (count === 0) return null;
      return delegate.findFirst({ where: this.scoped({ id }) });
    }, `${this.modelName}.updateById`);
  }

  async requireUpdateById(id: string, data: Record<string, unknown>): Promise<TRecord> {
    const updated = await this.updateById(id, data);
    if (!updated) {
      throw new ResourceNotFoundError(this.modelName, id);
    }
    return updated;
  }

  /** @returns whether a row was actually removed. */
  async deleteById(id: string): Promise<boolean> {
    return this.db.run(async (tx) => {
      const { count } = await this.delegate(tx).deleteMany({ where: this.scoped({ id }) });
      return count > 0;
    }, `${this.modelName}.deleteById`);
  }

  async requireDeleteById(id: string): Promise<void> {
    if (!(await this.deleteById(id))) {
      throw new ResourceNotFoundError(this.modelName, id);
    }
  }

  /** Soft delete for models that carry `deletedAt`. */
  async softDeleteById(id: string): Promise<boolean> {
    return this.db.run(async (tx) => {
      const { count } = await this.delegate(tx).updateMany({
        where: this.scoped({ id, deletedAt: null }),
        data: { deletedAt: new Date() },
      });
      return count > 0;
    }, `${this.modelName}.softDeleteById`);
  }

  // -------------------------------------------------------------------------
  // Composing
  // -------------------------------------------------------------------------

  /**
   * Run several operations in one transaction with one tenant context.
   *
   * Use this when a use case touches more than one repository: without it each
   * call opens its own transaction, and a failure halfway leaves the first
   * write committed.
   */
  async transaction<T>(fn: (tx: TenantTx, companyId: string) => Promise<T>): Promise<T> {
    const companyId = this.companyId;
    return this.db.run((tx) => fn(tx, companyId), `${this.modelName}.transaction`);
  }
}

/**
 * Strip fields that would move a row between tenants. Reassigning `companyId`
 * is never a legitimate update — a row belongs to the company it was created
 * for, and "moving" one means creating it again on the other side.
 */
function stripTenantKeys(data: Record<string, unknown>): Record<string, unknown> {
  const { companyId: _companyId, company: _company, id: _id, ...rest } = data;
  return rest;
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
