import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import type {
  CreateServiceCategoryDto,
  UpdateServiceCategoryDto,
} from './dto/catalog.dto';

interface CategoryRow {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  deletedAt: Date | null;
}

@Injectable()
export class ServiceCategoryRepository extends TenantScopedRepository<CategoryRow> {
  protected readonly modelName = 'ServiceCategory';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<CategoryRow> {
    return tx.serviceCategory;
  }
}

/**
 * How a company organises its catalogue.
 *
 * ---------------------------------------------------------------------------
 * TWO LEVELS, NOT ARBITRARY DEPTH
 * ---------------------------------------------------------------------------
 *
 * The schema models a tree — `parent_id` is a self-relation — and the unique
 * index is `(company_id, parent_id, name)`, so `Hair > Colouring` and
 * `Nails > Colouring` can coexist. That is the point of the hierarchy.
 *
 * Depth is capped at two, which the database cannot express: a booking page
 * shows a list of groups with services under them, and a third level would
 * either be flattened by every consumer or render as something nobody designed.
 * Capping it here is cheaper than discovering it in the UI.
 *
 * Cycles are refused for the same reason a filesystem refuses them — a category
 * that is its own ancestor makes every recursive read non-terminating, and the
 * self-referencing foreign key will happily allow it.
 */
@Injectable()
export class ServiceCategoriesService {
  constructor(
    private readonly categories: ServiceCategoryRepository,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.categories.transaction(async (tx, companyId) => {
      const rows = await tx.serviceCategory.findMany({
        where: { companyId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          // The count a category list is actually for: "can I delete this?"
          _count: { select: { services: { where: { deletedAt: null } } } },
        },
      });

      return { items: rows.map(toCategoryResponse) };
    });
  }

  async findById(categoryId: string) {
    return this.categories.transaction(async (tx, companyId) => {
      const category = await tx.serviceCategory.findFirst({
        where: { id: categoryId, companyId, deletedAt: null },
        include: {
          _count: { select: { services: { where: { deletedAt: null } } } },
          children: {
            where: { deletedAt: null },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, name: true, status: true, sortOrder: true },
          },
        },
      });

      if (!category) throw new ResourceNotFoundError('ServiceCategory', categoryId);

      return {
        ...toCategoryResponse(category),
        children: category.children,
      };
    });
  }

  async create(input: CreateServiceCategoryDto) {
    const created = await this.categories.transaction(async (tx, companyId) => {
      if (input.parentId) await this.assertParentUsable(tx, companyId, input.parentId);

      try {
        return await tx.serviceCategory.create({ data: { ...input, companyId } });
      } catch (error) {
        throw mapDuplicateName(error, input.name);
      }
    });

    await this.audit.record({
      action: 'service_category.created',
      resourceType: 'service_category',
      resourceId: created.id,
      after: { name: created.name, parentId: created.parentId },
    });

    return this.findById(created.id);
  }

  async update(categoryId: string, input: UpdateServiceCategoryDto) {
    const before = await this.categories.transaction(async (tx, companyId) => {
      const before = await tx.serviceCategory.findFirst({
        where: { id: categoryId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('ServiceCategory', categoryId);

      if (input.parentId !== undefined && input.parentId !== before.parentId) {
        if (input.parentId) {
          await this.assertParentUsable(tx, companyId, input.parentId, categoryId);
        } else {
          // Promoting a child to a root is fine — unless it has children of its
          // own, which would then sit at depth three.
          await this.assertNoChildren(tx, companyId, categoryId, 'promote');
        }
      }

      try {
        const { count } = await tx.serviceCategory.updateMany({
          where: { id: categoryId, companyId, deletedAt: null },
          data: input,
        });
        if (count === 0) throw new ResourceNotFoundError('ServiceCategory', categoryId);
      } catch (error) {
        throw mapDuplicateName(error, input.name ?? before.name);
      }

      return before;
    });

    await this.audit.record({
      action: 'service_category.updated',
      resourceType: 'service_category',
      resourceId: categoryId,
      before: { name: before.name, parentId: before.parentId, status: before.status },
      after: { name: input.name, parentId: input.parentId, status: input.status },
    });

    return this.findById(categoryId);
  }

  /**
   * Soft delete, and only when nothing depends on it.
   *
   * A category with live services or live children is refused rather than
   * cascaded. Cascading would silently orphan a price list — and because
   * `service.categoryId` is nullable, the failure mode is not a foreign-key
   * error but a catalogue that quietly loses its structure.
   *
   * Refusing with a count in `details` is what lets the UI say "move these 12
   * services first" instead of "cannot delete".
   */
  async remove(categoryId: string) {
    const before = await this.categories.transaction(async (tx, companyId) => {
      const before = await tx.serviceCategory.findFirst({
        where: { id: categoryId, companyId, deletedAt: null },
        include: { _count: { select: { services: { where: { deletedAt: null } } } } },
      });
      if (!before) throw new ResourceNotFoundError('ServiceCategory', categoryId);

      if (before._count.services > 0) {
        throw new ConflictError('Move or delete this category’s services first.', {
          field: 'categoryId',
          serviceCount: before._count.services,
        });
      }

      await this.assertNoChildren(tx, companyId, categoryId, 'delete');

      await tx.serviceCategory.updateMany({
        where: { id: categoryId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'ARCHIVED' },
      });

      return before;
    });

    await this.audit.record({
      action: 'service_category.deleted',
      resourceType: 'service_category',
      resourceId: categoryId,
      before: { name: before.name },
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * A usable parent is one that exists here, is itself a root, and is not the
   * category being moved.
   */
  private async assertParentUsable(
    tx: TenantTx,
    companyId: string,
    parentId: string,
    movingId?: string,
  ) {
    if (movingId && parentId === movingId) {
      throw new ValidationFailedError({ parentId: 'A category cannot be its own parent.' });
    }

    const parent = await tx.serviceCategory.findFirst({
      where: { id: parentId, companyId, deletedAt: null },
      select: { id: true, parentId: true },
    });

    // 404 rather than 400: a parent id belonging to another company must be
    // indistinguishable from one that does not exist.
    if (!parent) throw new ResourceNotFoundError('ServiceCategory', parentId);

    if (parent.parentId) {
      throw new ValidationFailedError({
        parentId: 'Categories nest one level deep. Choose a top-level category.',
      });
    }

    // Moving a category under its own descendant would make a cycle. With depth
    // capped at two, the only possible cycle is a direct swap, and the check
    // above already covers self-parenting — but the category being moved must
    // also not currently have children, or the result is depth three.
    if (movingId) await this.assertNoChildren(tx, companyId, movingId, 'nest');
  }

  private async assertNoChildren(
    tx: TenantTx,
    companyId: string,
    categoryId: string,
    reason: 'delete' | 'nest' | 'promote',
  ) {
    const children = await tx.serviceCategory.count({
      where: { companyId, parentId: categoryId, deletedAt: null },
    });

    if (children === 0) return;

    if (reason === 'delete') {
      throw new ConflictError('Move or delete this category’s sub-categories first.', {
        field: 'categoryId',
        childCount: children,
      });
    }

    throw new ValidationFailedError({
      parentId: 'This category has sub-categories, so it cannot itself be nested.',
    });
  }
}

function mapDuplicateName(error: unknown, name: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // The index is (company_id, parent_id, name), so the clash is only within
    // the same parent — which is what makes two "Colouring" categories legal.
    return new ConflictError(`A category called "${name}" already exists here.`, {
      field: 'name',
    });
  }
  return error;
}

function toCategoryResponse(category: {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  status: string;
  _count?: { services: number };
}) {
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    description: category.description,
    color: category.color,
    sortOrder: category.sortOrder,
    status: category.status,
    serviceCount: category._count?.services ?? 0,
  };
}
