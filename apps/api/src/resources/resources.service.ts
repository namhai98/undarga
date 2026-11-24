import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { lockKeys, resourceLockKey } from '../appointments/booking-locks';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { RequestContextService } from '../tenancy/context/request-context.service';

const uuid = z.string().uuid();
const instant = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO-8601 instant with an offset.' });
const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00.');
const KINDS = [
  'ROOM',
  'CHAIR',
  'EQUIPMENT',
  'MEETING_ROOM',
  'TREATMENT_ROOM',
  'SERVICE_BAY',
  'OTHER',
] as const;

export const createResourceTypeSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9_-]{2,48}$/, 'Lowercase letters, digits, - and _.'),
    name: z.string().trim().min(1).max(96),
    kind: z.enum(KINDS),
    description: z.string().trim().max(512).nullable().optional(),
  })
  .strict();
export const updateResourceTypeSchema = createResourceTypeSchema
  .omit({ key: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field.');

export const createResourceSchema = z
  .object({
    branchId: uuid,
    resourceTypeId: uuid,
    name: z.string().trim().min(1).max(128),
    code: z.string().trim().max(24).nullable().optional(),
    status: z.enum(['ACTIVE', 'OUT_OF_SERVICE', 'INACTIVE']).optional(),
    isBookable: z.boolean().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export const updateResourceSchema = createResourceSchema
  .omit({ branchId: true, resourceTypeId: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field.');

export const resourceQuerySchema = z
  .object({
    branchId: uuid.optional(),
    resourceTypeId: uuid.optional(),
    status: z.enum(['ACTIVE', 'OUT_OF_SERVICE', 'INACTIVE']).optional(),
  })
  .strict();

/** Replaces every window. `[]` = follow the branch's opening hours. */
export const putAvailabilitySchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            dayOfWeek: z.number().int().min(0).max(6),
            startsAt: timeOfDay,
            endsAt: timeOfDay,
          })
          .strict()
          .refine((r) => r.endsAt > r.startsAt, {
            message: 'The end must be after the start.',
            path: ['endsAt'],
          }),
      )
      .max(28),
  })
  .strict();

export const createUnavailabilitySchema = z
  .object({
    startsAt: instant,
    endsAt: instant,
    reason: z.enum(['MAINTENANCE', 'OUT_OF_SERVICE', 'RESERVED', 'OTHER']).default('OTHER'),
    note: z.string().trim().max(512).nullable().optional(),
    /** Record it even though it overlaps booked appointments (they are listed back). */
    allowConflicts: z.boolean().optional(),
  })
  .strict();

export type CreateResourceTypeDto = z.infer<typeof createResourceTypeSchema>;
export type UpdateResourceTypeDto = z.infer<typeof updateResourceTypeSchema>;
export type CreateResourceDto = z.infer<typeof createResourceSchema>;
export type UpdateResourceDto = z.infer<typeof updateResourceSchema>;
export type ResourceQueryDto = z.infer<typeof resourceQuerySchema>;
export type PutAvailabilityDto = z.infer<typeof putAvailabilitySchema>;
export type CreateUnavailabilityDto = z.infer<typeof createUnavailabilitySchema>;

interface Row {
  id: string;
  companyId: string;
}

@Injectable()
export class ResourceRepository extends TenantScopedRepository<Row> {
  protected readonly modelName = 'Resource';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<Row> {
    return tx.resource;
  }
}

/**
 * Rooms, chairs and equipment, and when they can be booked.
 *
 * A resource is exclusive: the database's exclusion constraint lets one
 * booking hold it at a time. Capacity is modelled as several resources of one
 * type — a service needing "a treatment room" takes any free one of the type,
 * and needing two takes two (service_resource_requirement.quantity).
 *
 * Availability, read by the same availability engine that books staff:
 *   weekly windows   when it may be used (none = the branch's hours)
 *   unavailable      maintenance, out of service, held — refused over
 *                    booked appointments unless confirmed
 */
@Injectable()
export class ResourcesService {
  constructor(
    private readonly resources: ResourceRepository,
    private readonly entitlements: EntitlementsService,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- types
  listTypes() {
    return this.resources.transaction((tx, companyId) =>
      tx.resourceType.findMany({
        where: { companyId, deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, key: true, name: true, kind: true, description: true },
      }),
    );
  }

  async createType(input: CreateResourceTypeDto) {
    const row = await this.resources.transaction(async (tx, companyId) => {
      const taken = await tx.resourceType.count({
        where: { companyId, key: input.key, deletedAt: null },
      });
      if (taken)
        throw new ConflictError(`A resource type "${input.key}" already exists.`, { field: 'key' });
      return tx.resourceType.create({
        data: {
          companyId,
          key: input.key,
          name: input.name,
          kind: input.kind,
          description: input.description ?? null,
        },
        select: { id: true, key: true, name: true, kind: true, description: true },
      });
    });
    await this.audit.record({
      action: 'resource_type.created',
      resourceType: 'resource_type',
      resourceId: row.id,
      after: row,
    });
    return row;
  }

  async updateType(id: string, input: UpdateResourceTypeDto) {
    return this.resources.transaction(async (tx, companyId) => {
      const { count } = await tx.resourceType.updateMany({
        where: { id, companyId, deletedAt: null },
        data: { ...input, ...(input.kind ? { kind: input.kind } : {}) },
      });
      if (!count) throw new ResourceNotFoundError('ResourceType', id);
      return tx.resourceType.findFirstOrThrow({
        where: { id, companyId },
        select: { id: true, key: true, name: true, kind: true, description: true },
      });
    });
  }

  // ---------------------------------------------------------------- resources
  list(query: ResourceQueryDto) {
    return this.resources.transaction(async (tx, companyId) => {
      const rows = await tx.resource.findMany({
        where: {
          companyId,
          deletedAt: null,
          ...(query.branchId ? { branchId: query.branchId } : {}),
          ...(query.resourceTypeId ? { resourceTypeId: query.resourceTypeId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: RESOURCE_SELECT,
      });
      return { items: rows.map(toResource), total: rows.length };
    });
  }

  find(id: string) {
    return this.resources.transaction(async (tx, companyId) =>
      toResource(await this.load(tx, companyId, id)),
    );
  }

  async create(input: CreateResourceDto) {
    const row = await this.resources.transaction(async (tx, companyId) => {
      const [branch, type] = await Promise.all([
        tx.branch.findFirst({
          where: { id: input.branchId, companyId, deletedAt: null },
          select: { id: true },
        }),
        tx.resourceType.findFirst({
          where: { id: input.resourceTypeId, companyId, deletedAt: null },
          select: { id: true },
        }),
      ]);
      if (!branch) throw new ResourceNotFoundError('Branch', input.branchId);
      if (!type) throw new ResourceNotFoundError('ResourceType', input.resourceTypeId);
      await this.entitlements.assertCanAdd(tx, companyId, 'RESOURCE');
      return tx.resource.create({
        data: {
          companyId,
          branchId: input.branchId,
          resourceTypeId: input.resourceTypeId,
          name: input.name,
          code: input.code ?? null,
          status: input.status ?? 'ACTIVE',
          isBookable: input.isBookable ?? true,
          notes: input.notes ?? null,
        },
        select: RESOURCE_SELECT,
      });
    });
    await this.audit.record({
      action: 'resource.created',
      resourceType: 'resource',
      resourceId: row.id,
      after: { name: row.name, branchId: row.branchId },
    });
    return toResource(row);
  }

  async update(id: string, input: UpdateResourceDto) {
    const row = await this.resources.transaction(async (tx, companyId) => {
      const { count } = await tx.resource.updateMany({
        where: { id, companyId, deletedAt: null },
        data: { ...input, ...(input.status ? { status: input.status } : {}) },
      });
      if (!count) throw new ResourceNotFoundError('Resource', id);
      return this.load(tx, companyId, id);
    });
    await this.audit.record({
      action: 'resource.updated',
      resourceType: 'resource',
      resourceId: id,
      after: input,
    });
    return toResource(row);
  }

  /** Soft delete: its past reservations stay intact. */
  async remove(id: string) {
    await this.resources.transaction(async (tx, companyId) => {
      const upcoming = await tx.appointmentResource.count({
        where: { companyId, resourceId: id, blocksCalendar: true, endsAt: { gt: new Date() } },
      });
      if (upcoming) {
        throw new ConflictError(
          'This resource has upcoming bookings. Move them first, or mark it out of service.',
          { upcoming },
        );
      }
      const { count } = await tx.resource.updateMany({
        where: { id, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'INACTIVE' },
      });
      if (!count) throw new ResourceNotFoundError('Resource', id);
    });
    await this.audit.record({
      action: 'resource.deleted',
      resourceType: 'resource',
      resourceId: id,
    });
    return { deleted: true };
  }

  // ---------------------------------------------------------------- availability
  async putAvailability(id: string, input: PutAvailabilityDto) {
    const rules = await this.resources.transaction(async (tx, companyId) => {
      await this.load(tx, companyId, id);
      await tx.resourceAvailabilityRule.deleteMany({ where: { companyId, resourceId: id } });
      if (input.rules.length) {
        await tx.resourceAvailabilityRule.createMany({
          data: input.rules.map((r) => ({
            companyId,
            resourceId: id,
            dayOfWeek: r.dayOfWeek,
            startsAt: wallTime(r.startsAt),
            endsAt: wallTime(r.endsAt),
          })),
        });
      }
      return this.rules(tx, companyId, id);
    });
    await this.audit.record({
      action: 'resource.availability_updated',
      resourceType: 'resource',
      resourceId: id,
      after: { rules },
    });
    return { rules };
  }

  getAvailability(id: string) {
    return this.resources.transaction(async (tx, companyId) => {
      await this.load(tx, companyId, id);
      return { rules: await this.rules(tx, companyId, id) };
    });
  }

  listUnavailability(id: string) {
    return this.resources.transaction(async (tx, companyId) => {
      await this.load(tx, companyId, id);
      const rows = await tx.resourceUnavailability.findMany({
        where: {
          companyId,
          resourceId: id,
          endsAt: { gt: new Date(Date.now() - 30 * 86_400_000) },
        },
        orderBy: { startsAt: 'asc' },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          reason: true,
          note: true,
          createdAt: true,
        },
      });
      return { items: rows };
    });
  }

  async addUnavailability(id: string, input: z.infer<typeof createUnavailabilitySchema>) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (!(endsAt > startsAt))
      throw new ValidationFailedError({ endsAt: 'The end must be after the start.' });
    const actor = this.context.requireActor();
    const result = await this.resources.transaction(async (tx, companyId) => {
      await this.load(tx, companyId, id);
      // Serialise with bookings of this resource (same lock as the booking path).
      await lockKeys(tx, [resourceLockKey(companyId, id)]);
      const booked = await tx.appointmentResource.findMany({
        where: {
          companyId,
          resourceId: id,
          blocksCalendar: true,
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        take: 50,
        select: {
          startsAt: true,
          appointmentItem: {
            select: { appointment: { select: { id: true, appointmentNumber: true } } },
          },
        },
      });
      const conflicts = booked.map((b) => ({
        appointmentId: b.appointmentItem.appointment.id,
        appointmentNumber: b.appointmentItem.appointment.appointmentNumber,
        startsAt: b.startsAt,
      }));
      if (conflicts.length && !input.allowConflicts) {
        throw new ConflictError(
          'This period overlaps booked appointments. Move them first, or confirm to record it anyway.',
          { appointments: conflicts },
        );
      }
      const row = await tx.resourceUnavailability.create({
        data: {
          companyId,
          resourceId: id,
          startsAt,
          endsAt,
          reason: input.reason,
          note: input.note ?? null,
          createdByType: actor.kind === 'PLATFORM_USER' ? 'PLATFORM_USER' : 'COMPANY_USER',
          createdById: this.context.membership()?.companyUserId ?? null,
        },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          reason: true,
          note: true,
          createdAt: true,
        },
      });
      return { row, conflicts };
    });
    await this.audit.record({
      action: 'resource.unavailability_added',
      resourceType: 'resource',
      resourceId: id,
      after: {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: input.reason,
      },
    });
    return { ...result.row, conflicts: result.conflicts };
  }

  async removeUnavailability(id: string, unavailabilityId: string) {
    await this.resources.transaction(async (tx, companyId) => {
      const { count } = await tx.resourceUnavailability.deleteMany({
        where: { id: unavailabilityId, companyId, resourceId: id },
      });
      if (!count) throw new ResourceNotFoundError('ResourceUnavailability', unavailabilityId);
    });
    await this.audit.record({
      action: 'resource.unavailability_removed',
      resourceType: 'resource',
      resourceId: id,
      metadata: { unavailabilityId },
    });
    return { deleted: true };
  }

  // ----------------------------------------------------------------
  private async load(tx: TenantTx, companyId: string, id: string) {
    const row = await tx.resource.findFirst({
      where: { id, companyId, deletedAt: null },
      select: RESOURCE_SELECT,
    });
    if (!row) throw new ResourceNotFoundError('Resource', id);
    return row;
  }

  private async rules(tx: TenantTx, companyId: string, id: string) {
    const rows = await tx.resourceAvailabilityRule.findMany({
      where: { companyId, resourceId: id },
      orderBy: [{ dayOfWeek: 'asc' }, { startsAt: 'asc' }],
      select: { dayOfWeek: true, startsAt: true, endsAt: true },
    });
    return rows.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startsAt: hhmm(r.startsAt),
      endsAt: hhmm(r.endsAt),
    }));
  }
}

const RESOURCE_SELECT = {
  id: true,
  branchId: true,
  resourceTypeId: true,
  name: true,
  code: true,
  status: true,
  isBookable: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  resourceType: { select: { name: true, kind: true } },
} as const satisfies Prisma.ResourceSelect;

function toResource(row: Prisma.ResourceGetPayload<{ select: typeof RESOURCE_SELECT }>) {
  return {
    id: row.id,
    branchId: row.branchId,
    resourceTypeId: row.resourceTypeId,
    resourceTypeName: row.resourceType.name,
    kind: row.resourceType.kind,
    name: row.name,
    code: row.code,
    status: row.status,
    isBookable: row.isBookable,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function wallTime(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}
