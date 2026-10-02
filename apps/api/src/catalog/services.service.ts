import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  AlreadyAssignedError,
  ConflictError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import type {
  AssignServiceBranchDto,
  AssignServiceEmployeeDto,
  CreateServiceDto,
  ServiceQueryDto,
  UpdateServiceDto,
} from './dto/catalog.dto';
import { EntitlementsService } from '../subscriptions/entitlements.service';

interface ServiceRow {
  id: string;
  companyId: string;
  name: string;
  code: string | null;
  deletedAt: Date | null;
}

@Injectable()
export class ServiceRepository extends TenantScopedRepository<ServiceRow> {
  protected readonly modelName = 'Service';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<ServiceRow> {
    return tx.service;
  }
}

/**
 * The catalogue: what a company sells, how long it takes, and what it needs.
 *
 * ===========================================================================
 * THE THREE FIELDS THE AVAILABILITY ENGINE WILL LIVE ON
 * ===========================================================================
 *
 * `durationMin`, `bufferBeforeMin`, `bufferAfterMin` — all integer minutes, so
 * the occupied window is arithmetic rather than parsing:
 *
 *     start - bufferBefore  …  start + duration + bufferAfter
 *
 * Nothing computes that yet. What matters now is that the data can support it,
 * which a human-readable duration could not.
 *
 * ===========================================================================
 * BOOKABLE IS NOT PUBLIC
 * ===========================================================================
 *
 *   status: ACTIVE          can be booked at all — by reception, by anyone
 *   isOnlineBookable: true  additionally visible on the public booking site
 *
 * An internal-only service (staff training, a supplier visit) is ACTIVE and not
 * online-bookable: reception can put it on a calendar, the public never sees
 * it. Two separate booleans would be one too many — these two columns already
 * express the distinction, and adding an `isPublic` alongside them would create
 * a third state nobody could describe.
 *
 * ===========================================================================
 * ONE JUNCTION TABLE, TWO DOORS
 * ===========================================================================
 *
 * `employee_service` is the same table the employees module writes through
 * (`/employees/:id/services`). This module's `/services/:id/employees` is the
 * other side of the same relationship, not a parallel one — assigning from
 * either direction produces the identical row, and a test asserts it.
 */
@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    private readonly services: ServiceRepository,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Every filter is a SQL predicate.
   *
   * `branchId` and `employeeId` go through the join tables with `some`. Together
   * they are the intersection the availability engine will need — "which
   * services can be booked at this branch, by this person" — so the query is
   * already the right shape and the indexes that make it fast are the ones it
   * will use.
   */
  async list(query: ServiceQueryDto) {
    return this.services.transaction(async (tx, companyId) => {
      const where: Prisma.ServiceWhereInput = {
        companyId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.isOnlineBookable
          ? { isOnlineBookable: query.isOnlineBookable === 'true' }
          : {}),
        ...(query.branchId
          ? { branches: { some: { companyId, branchId: query.branchId } } }
          : {}),
        ...(query.employeeId
          ? { employees: { some: { companyId, employeeId: query.employeeId } } }
          : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { code: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.service.findMany({
          where,
          // `sortOrder` then name: sortOrder is what a company arranges its own
          // booking page by, and name is the tie-break so the output is stable
          // rather than whatever the planner returns.
          orderBy:
            query.sortBy === 'sortOrder'
              ? [{ sortOrder: query.sortOrder }, { name: 'asc' }]
              : { [query.sortBy]: query.sortOrder },
          skip: query.offset,
          take: query.limit,
          include: {
            category: { select: { id: true, name: true } },
            _count: { select: { branches: true, employees: true } },
          },
        }),
        tx.service.count({ where }),
      ]);

      return {
        items: rows.map(toServiceResponse),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async findById(serviceId: string) {
    return this.services.transaction(async (tx, companyId) => {
      const service = await tx.service.findFirst({
        where: { id: serviceId, companyId, deletedAt: null },
        include: {
          category: { select: { id: true, name: true, parentId: true } },
          branches: {
            select: {
              branchId: true,
              isAvailable: true,
              priceOverrideMinor: true,
              durationOverrideMin: true,
              branch: { select: { name: true, code: true } },
            },
          },
          employees: {
            select: {
              employeeId: true,
              durationOverrideMin: true,
              priceOverrideMinor: true,
              proficiency: true,
              employee: { select: { displayName: true, status: true } },
            },
          },
          resourceRequirements: {
            select: {
              resourceTypeId: true,
              quantity: true,
              resourceType: { select: { name: true, kind: true } },
            },
          },
        },
      });

      if (!service) throw new ResourceNotFoundError('Service', serviceId);
      return toServiceDetailResponse(service);
    });
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(input: CreateServiceDto) {
    const { branchIds, employeeIds, resourceRequirements, ...service } = input;

    const created = await this.services.transaction(async (tx, companyId) => {
      // Everything is validated BEFORE the service row exists, so a request
      // naming one foreign branch leaves nothing behind.
      const currencyCode = await this.resolveCurrency(tx, companyId, service.currencyCode);
      if (service.categoryId) await this.assertCategoryExists(tx, companyId, service.categoryId);
      if (service.code) await this.assertCodeAvailable(tx, companyId, service.code);
      if (branchIds?.length) await this.assertBranchesExist(tx, companyId, branchIds);
      if (employeeIds?.length) await this.assertEmployeesExist(tx, companyId, employeeIds);
      if (resourceRequirements?.length) {
        await this.assertResourceTypesExist(
          tx,
          companyId,
          resourceRequirements.map((r) => r.resourceTypeId),
        );
      }

      await this.entitlements.assertCanAdd(tx, companyId, 'SERVICE');

      let row;
      try {
        row = await tx.service.create({
          data: {
            ...service,
            companyId,
            currencyCode,
            priceMinor: BigInt(service.priceMinor),
            depositMinor: service.depositMinor == null ? null : BigInt(service.depositMinor),
          },
        });
      } catch (error) {
        throw mapDuplicateCode(error, service.code ?? '');
      }

      if (branchIds?.length) {
        await tx.serviceBranch.createMany({
          data: branchIds.map((branchId) => ({ companyId, serviceId: row.id, branchId })),
        });
      }

      if (employeeIds?.length) {
        await tx.employeeService.createMany({
          data: employeeIds.map((employeeId) => ({ companyId, serviceId: row.id, employeeId })),
        });
      }

      if (resourceRequirements?.length) {
        await tx.serviceResourceRequirement.createMany({
          data: resourceRequirements.map((r) => ({
            companyId,
            serviceId: row.id,
            resourceTypeId: r.resourceTypeId,
            quantity: r.quantity,
          })),
        });
      }

      return row;
    });

    await this.audit.record({
      action: 'service.created',
      resourceType: 'service',
      resourceId: created.id,
      after: {
        name: created.name,
        code: created.code,
        durationMin: created.durationMin,
        // Money as a string in the audit trail too — a BigInt has no JSON
        // representation and `Number()` would round it.
        priceMinor: created.priceMinor.toString(),
        currencyCode: created.currencyCode,
      },
    });

    this.logger.log(`Service ${created.name} created for company ${created.companyId}`);

    return this.findById(created.id);
  }

  async update(serviceId: string, input: UpdateServiceDto) {
    const { resourceRequirements, ...service } = input;

    const before = await this.services.transaction(async (tx, companyId) => {
      const before = await tx.service.findFirst({
        where: { id: serviceId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Service', serviceId);

      if (service.currencyCode) await this.resolveCurrency(tx, companyId, service.currencyCode);
      if (service.categoryId) await this.assertCategoryExists(tx, companyId, service.categoryId);
      if (service.code && service.code !== before.code) {
        await this.assertCodeAvailable(tx, companyId, service.code, serviceId);
      }

      // A deposit amount without the flag, or the flag without an amount,
      // checked against the MERGED state rather than the patch — a request
      // setting only one of them is the case the schema-level check cannot see.
      const requiresDeposit = service.requiresDeposit ?? before.requiresDeposit;
      const depositMinor =
        service.depositMinor === undefined
          ? before.depositMinor
          : service.depositMinor === null
            ? null
            : BigInt(service.depositMinor);

      if (requiresDeposit && !depositMinor) {
        throw new ValidationFailedError({
          depositMinor: 'A service that requires a deposit needs a deposit amount.',
        });
      }

      // Built explicitly and typed as the UNCHECKED variant. A spread of the
      // DTO resolves to Prisma's checked update input, where `currencyCode` and
      // `categoryId` are relation scalars it refuses — and it would also carry
      // the money fields through as strings.
      const { priceMinor: _price, depositMinor: _deposit, ...rest } = service;
      const data: Prisma.ServiceUncheckedUpdateManyInput = {
        ...rest,
        ...(service.priceMinor !== undefined ? { priceMinor: BigInt(service.priceMinor) } : {}),
        ...(service.depositMinor !== undefined ? { depositMinor } : {}),
      };

      try {
        const { count } = await tx.service.updateMany({
          where: { id: serviceId, companyId, deletedAt: null },
          data,
        });
        if (count === 0) throw new ResourceNotFoundError('Service', serviceId);
      } catch (error) {
        throw mapDuplicateCode(error, service.code ?? before.code ?? '');
      }

      if (resourceRequirements) {
        await this.assertResourceTypesExist(
          tx,
          companyId,
          resourceRequirements.map((r) => r.resourceTypeId),
        );
        // Replaced wholesale: requirements are read as a set — "a room and a
        // chair" is one decision — and patching them individually would leave
        // a service half-configured between calls.
        await tx.serviceResourceRequirement.deleteMany({ where: { companyId, serviceId } });
        if (resourceRequirements.length > 0) {
          await tx.serviceResourceRequirement.createMany({
            data: resourceRequirements.map((r) => ({
              companyId,
              serviceId,
              resourceTypeId: r.resourceTypeId,
              quantity: r.quantity,
            })),
          });
        }
      }

      return before;
    });

    await this.audit.record({
      action: 'service.updated',
      resourceType: 'service',
      resourceId: serviceId,
      before: {
        name: before.name,
        status: before.status,
        durationMin: before.durationMin,
        priceMinor: before.priceMinor.toString(),
      },
      after: { name: service.name, status: service.status, durationMin: service.durationMin },
    });

    return this.findById(serviceId);
  }

  /**
   * Soft delete.
   *
   * `appointment_item` references the service, and so do promotions and
   * waitlist entries. Removing the row would either fail on a foreign key or
   * cascade through booking history and the revenue attributed to it — so the
   * record stays, disappears from every list, and stops being bookable.
   *
   * `isOnlineBookable: false` alongside, so a public booking page cannot offer
   * a deleted service even if it forgets to filter on `deletedAt`. Belt and
   * braces on the one mistake customers would see.
   */
  async remove(serviceId: string) {
    const before = await this.services.transaction(async (tx, companyId) => {
      const before = await tx.service.findFirst({
        where: { id: serviceId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('Service', serviceId);

      await tx.service.updateMany({
        where: { id: serviceId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'ARCHIVED', isOnlineBookable: false },
      });

      return before;
    });

    await this.audit.record({
      action: 'service.deactivated',
      resourceType: 'service',
      resourceId: serviceId,
      before: { name: before.name, status: before.status },
    });
  }

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  async listBranches(serviceId: string) {
    return this.services.transaction(async (tx, companyId) => {
      await this.assertServiceExists(tx, companyId, serviceId);

      const rows = await tx.serviceBranch.findMany({
        where: { companyId, serviceId },
        include: { branch: { select: { id: true, code: true, name: true, status: true } } },
      });

      return {
        items: rows.map((r) => ({
          branchId: r.branchId,
          code: r.branch.code,
          name: r.branch.name,
          branchStatus: r.branch.status,
          isAvailable: r.isAvailable,
          priceOverrideMinor: r.priceOverrideMinor?.toString() ?? null,
          durationOverrideMin: r.durationOverrideMin,
        })),
      };
    });
  }

  async assignBranch(serviceId: string, input: AssignServiceBranchDto) {
    await this.services.transaction(async (tx, companyId) => {
      await this.assertServiceExists(tx, companyId, serviceId);
      await this.assertBranchesExist(tx, companyId, [input.branchId]);

      const existing = await tx.serviceBranch.findFirst({
        where: { companyId, serviceId, branchId: input.branchId },
      });
      if (existing) {
        throw new AlreadyAssignedError('That branch already offers this service.', {
          field: 'branchId',
        });
      }

      await tx.serviceBranch.create({
        data: {
          companyId,
          serviceId,
          branchId: input.branchId,
          isAvailable: input.isAvailable ?? true,
          priceOverrideMinor:
            input.priceOverrideMinor == null ? null : BigInt(input.priceOverrideMinor),
          durationOverrideMin: input.durationOverrideMin,
        },
      });
    });

    await this.audit.record({
      action: 'service.branch_assigned',
      resourceType: 'service_branch',
      resourceId: serviceId,
      after: { branchId: input.branchId },
    });

    return this.listBranches(serviceId);
  }

  async removeBranch(serviceId: string, branchId: string) {
    await this.services.transaction(async (tx, companyId) => {
      await this.assertServiceExists(tx, companyId, serviceId);

      const { count } = await tx.serviceBranch.deleteMany({
        where: { companyId, serviceId, branchId },
      });
      if (count === 0) throw new ResourceNotFoundError('ServiceBranch', branchId);
    });

    await this.audit.record({
      action: 'service.branch_removed',
      resourceType: 'service_branch',
      resourceId: serviceId,
      before: { branchId },
    });
  }

  // ---------------------------------------------------------------------------
  // Employees — the same rows the employees module writes
  // ---------------------------------------------------------------------------

  async listEmployees(serviceId: string) {
    return this.services.transaction(async (tx, companyId) => {
      await this.assertServiceExists(tx, companyId, serviceId);

      const rows = await tx.employeeService.findMany({
        where: { companyId, serviceId },
        include: {
          employee: {
            select: { id: true, displayName: true, status: true, isBookable: true },
          },
        },
      });

      return {
        items: rows.map((r) => ({
          employeeId: r.employeeId,
          displayName: r.employee.displayName,
          employeeStatus: r.employee.status,
          isBookable: r.employee.isBookable,
          durationOverrideMin: r.durationOverrideMin,
          priceOverrideMinor: r.priceOverrideMinor?.toString() ?? null,
          proficiency: r.proficiency,
        })),
      };
    });
  }

  /**
   * The other door onto `employee_service`.
   *
   * `/employees/:id/services` and `/services/:id/employees` write the same row
   * with the same composite primary key. There is deliberately no second
   * junction table: two would drift, and the availability engine would have to
   * pick a winner.
   */
  async assignEmployee(serviceId: string, input: AssignServiceEmployeeDto) {
    await this.services.transaction(async (tx, companyId) => {
      await this.assertServiceExists(tx, companyId, serviceId);
      await this.assertEmployeesExist(tx, companyId, [input.employeeId]);

      const existing = await tx.employeeService.findFirst({
        where: { companyId, serviceId, employeeId: input.employeeId },
      });
      if (existing) {
        throw new AlreadyAssignedError('That employee already provides this service.', {
          field: 'employeeId',
        });
      }

      await tx.employeeService.create({
        data: {
          companyId,
          serviceId,
          employeeId: input.employeeId,
          durationOverrideMin: input.durationOverrideMin,
          priceOverrideMinor:
            input.priceOverrideMinor == null ? null : BigInt(input.priceOverrideMinor),
          proficiency: input.proficiency,
        },
      });
    });

    await this.audit.record({
      action: 'service.employee_assigned',
      resourceType: 'employee_service',
      resourceId: serviceId,
      after: { employeeId: input.employeeId },
    });

    return this.listEmployees(serviceId);
  }

  async removeEmployee(serviceId: string, employeeId: string) {
    await this.services.transaction(async (tx, companyId) => {
      await this.assertServiceExists(tx, companyId, serviceId);

      const { count } = await tx.employeeService.deleteMany({
        where: { companyId, serviceId, employeeId },
      });
      if (count === 0) throw new ResourceNotFoundError('EmployeeService', employeeId);
    });

    await this.audit.record({
      action: 'service.employee_removed',
      resourceType: 'employee_service',
      resourceId: serviceId,
      before: { employeeId },
    });
  }

  // ---------------------------------------------------------------------------
  // Guards
  //
  // Each takes the resolved company from the transaction, never from a body, so
  // a cross-tenant id resolves to nothing and 404s rather than reaching a
  // foreign key and becoming a 500.
  // ---------------------------------------------------------------------------

  private async assertServiceExists(tx: TenantTx, companyId: string, serviceId: string) {
    const service = await tx.service.findFirst({
      where: { id: serviceId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!service) throw new ResourceNotFoundError('Service', serviceId);
  }

  private async assertCategoryExists(tx: TenantTx, companyId: string, categoryId: string) {
    const category = await tx.serviceCategory.findFirst({
      where: { id: categoryId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!category) throw new ResourceNotFoundError('ServiceCategory', categoryId);
  }

  private async assertBranchesExist(tx: TenantTx, companyId: string, branchIds: string[]) {
    const unique = [...new Set(branchIds)];
    const found = await tx.branch.findMany({
      where: { companyId, id: { in: unique }, deletedAt: null },
      select: { id: true },
    });

    const missing = unique.filter((id) => !found.some((b) => b.id === id));
    if (missing.length > 0) throw new ResourceNotFoundError('Branch', missing[0]);
  }

  private async assertEmployeesExist(tx: TenantTx, companyId: string, employeeIds: string[]) {
    const unique = [...new Set(employeeIds)];
    const found = await tx.employee.findMany({
      where: { companyId, id: { in: unique }, deletedAt: null },
      select: { id: true },
    });

    const missing = unique.filter((id) => !found.some((e) => e.id === id));
    if (missing.length > 0) throw new ResourceNotFoundError('Employee', missing[0]);
  }

  private async assertResourceTypesExist(tx: TenantTx, companyId: string, typeIds: string[]) {
    const unique = [...new Set(typeIds)];
    const found = await tx.resourceType.findMany({
      where: { companyId, id: { in: unique }, deletedAt: null },
      select: { id: true },
    });

    const missing = unique.filter((id) => !found.some((t) => t.id === id));
    if (missing.length > 0) throw new ResourceNotFoundError('ResourceType', missing[0]);
  }

  /**
   * Default the service currency to the company's.
   *
   * Almost every service should inherit it. An override is allowed because the
   * schema allows it and a cross-border company is real, but it is checked
   * against the currency table so an unknown code is a 400 naming the field
   * rather than an opaque foreign-key 500.
   */
  private async resolveCurrency(
    tx: TenantTx,
    companyId: string,
    supplied?: string,
  ): Promise<string> {
    if (!supplied) {
      const company = await tx.company.findFirstOrThrow({
        where: { id: companyId },
        select: { currencyCode: true },
      });
      return company.currencyCode;
    }

    const currency = await tx.currency.findUnique({ where: { code: supplied } });
    if (!currency) throw new ValidationFailedError({ currencyCode: 'Unknown currency code.' });

    return supplied;
  }

  private async assertCodeAvailable(
    tx: TenantTx,
    companyId: string,
    code: string,
    exceptServiceId?: string,
  ) {
    const clash = await tx.service.findFirst({
      where: {
        companyId,
        code,
        deletedAt: null,
        ...(exceptServiceId ? { id: { not: exceptServiceId } } : {}),
      },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictError(`Another service already uses the code "${code}".`, {
        field: 'code',
        serviceId: clash.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function mapDuplicateCode(error: unknown, code: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictError(`Another service already uses the code "${code}".`, { field: 'code' });
  }
  return error;
}

interface ServiceSummaryRow {
  id: string;
  name: string;
  code: string | null;
  categoryId: string | null;
  description: string | null;
  status: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  priceMinor: bigint;
  currencyCode: string;
  isOnlineBookable: boolean;
  requiresEmployee: boolean;
  requiresResource: boolean;
  requiresDeposit: boolean;
  depositMinor: bigint | null;
  color: string | null;
  sortOrder: number;
  category?: { id: string; name: string; parentId?: string | null } | null;
  _count?: { branches: number; employees: number };
}

/**
 * Money leaves as a STRING, always.
 *
 * The global BigInt serializer would do this anyway, but doing it here keeps
 * the declared response type honest — a caller reading the type sees a string
 * and will not reach for arithmetic on it.
 */
function toServiceResponse(service: ServiceSummaryRow) {
  return {
    id: service.id,
    name: service.name,
    code: service.code,
    categoryId: service.categoryId,
    categoryName: service.category?.name ?? null,
    description: service.description,
    status: service.status,
    durationMin: service.durationMin,
    bufferBeforeMin: service.bufferBeforeMin,
    bufferAfterMin: service.bufferAfterMin,
    /** The whole window the availability engine will reserve. */
    totalOccupiedMin: service.bufferBeforeMin + service.durationMin + service.bufferAfterMin,
    priceMinor: service.priceMinor.toString(),
    currencyCode: service.currencyCode,
    isOnlineBookable: service.isOnlineBookable,
    requiresEmployee: service.requiresEmployee,
    requiresResource: service.requiresResource,
    requiresDeposit: service.requiresDeposit,
    depositMinor: service.depositMinor?.toString() ?? null,
    color: service.color,
    sortOrder: service.sortOrder,
    branchCount: service._count?.branches ?? 0,
    employeeCount: service._count?.employees ?? 0,
    // `companyId` is omitted: the caller is already scoped to it, and echoing a
    // tenant key invites a client to start passing it back.
  };
}

interface ServiceDetailRow extends ServiceSummaryRow {
  branches?: Array<{
    branchId: string;
    isAvailable: boolean;
    priceOverrideMinor: bigint | null;
    durationOverrideMin: number | null;
    branch?: { name: string; code: string };
  }>;
  employees?: Array<{
    employeeId: string;
    durationOverrideMin: number | null;
    priceOverrideMinor: bigint | null;
    proficiency: number | null;
    employee?: { displayName: string; status: string };
  }>;
  resourceRequirements?: Array<{
    resourceTypeId: string;
    quantity: number;
    resourceType?: { name: string; kind: string };
  }>;
}

function toServiceDetailResponse(service: ServiceDetailRow) {
  return {
    ...toServiceResponse(service),
    category: service.category
      ? { id: service.category.id, name: service.category.name, parentId: service.category.parentId ?? null }
      : null,
    branches:
      service.branches?.map((b) => ({
        branchId: b.branchId,
        name: b.branch?.name ?? null,
        code: b.branch?.code ?? null,
        isAvailable: b.isAvailable,
        priceOverrideMinor: b.priceOverrideMinor?.toString() ?? null,
        durationOverrideMin: b.durationOverrideMin,
      })) ?? [],
    employees:
      service.employees?.map((e) => ({
        employeeId: e.employeeId,
        displayName: e.employee?.displayName ?? null,
        employeeStatus: e.employee?.status ?? null,
        durationOverrideMin: e.durationOverrideMin,
        priceOverrideMinor: e.priceOverrideMinor?.toString() ?? null,
        proficiency: e.proficiency,
      })) ?? [],
    /**
     * What the service needs, by TYPE rather than by specific resource — "a
     * treatment room", not "room 3". Which room is chosen is the availability
     * engine's decision at booking time.
     *
     * Empty until Resource Management exists; the relationship is here so it is
     * not bolted on afterwards.
     */
    resourceRequirements:
      service.resourceRequirements?.map((r) => ({
        resourceTypeId: r.resourceTypeId,
        name: r.resourceType?.name ?? null,
        kind: r.resourceType?.kind ?? null,
        quantity: r.quantity,
      })) ?? [],
  };
}
