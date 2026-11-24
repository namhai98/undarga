import { Injectable } from '@nestjs/common';
import type { Prisma, TimeOffStatus } from '@prisma/client';
import { z } from 'zod';
import { employeeLockKey, lockKeys } from '../appointments/booking-locks';
import { AuditService } from '../audit/audit.service';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import {
  ConflictError,
  PermissionDeniedError,
  ResourceNotFoundError,
  TimeOffConflictError,
  ValidationFailedError,
} from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import { RequestContextService } from '../tenancy/context/request-context.service';

const instant = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO-8601 instant with an offset.' });
const TYPES = [
  'VACATION',
  'SICK',
  'PERSONAL',
  'UNPAID',
  'TRAINING',
  'PUBLIC_HOLIDAY',
  'OTHER',
] as const;
const MAX_DAYS = 366;

export const timeOffQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    /** Overlapping this window. */
    from: instant.optional(),
    to: instant.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type TimeOffQueryDto = z.infer<typeof timeOffQuerySchema>;

export const createTimeOffSchema = z
  .object({
    /** Omit to request time off for yourself (the staff profile linked to your login). */
    employeeId: z.string().uuid().optional(),
    type: z.enum(TYPES),
    startsAt: instant,
    endsAt: instant,
    isPaid: z.boolean().optional(),
    reason: z.string().trim().max(512).nullable().optional(),
    /** Record it even though it overlaps booked appointments (they are listed back). */
    allowConflicts: z.boolean().optional(),
  })
  .strict();
export type CreateTimeOffDto = z.infer<typeof createTimeOffSchema>;

export const updateTimeOffSchema = z
  .object({
    type: z.enum(TYPES).optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    isPaid: z.boolean().optional(),
    reason: z.string().trim().max(512).nullable().optional(),
    /** Approvers: APPROVED / REJECTED / CANCELLED. Requesters: CANCELLED (their own pending request). */
    status: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    rejectionReason: z.string().trim().max(512).nullable().optional(),
    allowConflicts: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).some((k) => k !== 'allowConflicts'),
    'Provide at least one change.',
  );
export type UpdateTimeOffDto = z.infer<typeof updateTimeOffSchema>;

interface TimeOffRow {
  id: string;
  companyId: string;
}

@Injectable()
export class TimeOffRepository extends TenantScopedRepository<TimeOffRow> {
  protected readonly modelName = 'EmployeeTimeOff';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<TimeOffRow> {
    return tx.employeeTimeOff;
  }
}

const SELECT = {
  id: true,
  employeeId: true,
  type: true,
  status: true,
  startsAt: true,
  endsAt: true,
  isPaid: true,
  reason: true,
  approvedAt: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
  employee: { select: { displayName: true } },
} as const satisfies Prisma.EmployeeTimeOffSelect;

type Row = Prisma.EmployeeTimeOffGetPayload<{ select: typeof SELECT }>;

/**
 * Employee time off: vacation, sick, personal leave and other unavailable
 * periods.
 *
 *   timeoff:approve   managers: anyone's time off, recorded as APPROVED;
 *                     approve / reject requests
 *   timeoff:request   employees: their own, recorded as PENDING until approved
 *
 * APPROVED time off is what the availability engine treats as unavailable
 * (it already reads employee_time_off), so it immediately removes those times
 * from every booking path. Approving time off over booked appointments is
 * refused with the appointments listed, unless confirmed with
 * `allowConflicts` — the appointments are never cancelled behind anyone's back.
 */
@Injectable()
export class TimeOffService {
  constructor(
    private readonly timeOff: TimeOffRepository,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async list(query: TimeOffQueryDto) {
    return this.timeOff.transaction(async (tx, companyId) => {
      const scope = await this.scope(tx, companyId);
      if (scope.kind === 'own' && !scope.employeeId)
        return { items: [], total: 0, limit: query.limit, offset: query.offset };
      const employeeId = scope.kind === 'own' ? scope.employeeId! : query.employeeId;
      const where: Prisma.EmployeeTimeOffWhereInput = {
        companyId,
        ...(employeeId ? { employeeId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.to ? { startsAt: { lt: new Date(query.to) } } : {}),
        ...(query.from ? { endsAt: { gt: new Date(query.from) } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.employeeTimeOff.findMany({
          where,
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          skip: query.offset,
          take: query.limit,
          select: SELECT,
        }),
        tx.employeeTimeOff.count({ where }),
      ]);
      return { items: rows.map(toResponse), total, limit: query.limit, offset: query.offset };
    });
  }

  async create(input: CreateTimeOffDto) {
    const { startsAt, endsAt } = period(input.startsAt, input.endsAt);
    const result = await this.timeOff.transaction(async (tx, companyId) => {
      const scope = await this.scope(tx, companyId);
      const employeeId = input.employeeId ?? scope.employeeId;
      if (!employeeId) {
        throw new ValidationFailedError({
          employeeId:
            scope.kind === 'any'
              ? 'Choose the staff member.'
              : 'Your login is not linked to a staff profile, so you cannot request time off.',
        });
      }
      await this.employee(tx, companyId, employeeId);
      if (scope.kind === 'own' && scope.employeeId !== employeeId) {
        throw new PermissionDeniedError([COMPANY_PERMISSIONS.TIME_OFF_APPROVE]);
      }
      const approved = scope.kind === 'any';
      const conflicts = approved
        ? await this.conflicts(tx, companyId, employeeId, startsAt, endsAt)
        : [];
      if (conflicts.length && !input.allowConflicts) throw new TimeOffConflictError(conflicts);

      const row = await tx.employeeTimeOff.create({
        data: {
          companyId,
          employeeId,
          type: input.type,
          status: approved ? 'APPROVED' : 'PENDING',
          startsAt,
          endsAt,
          isPaid: input.isPaid ?? input.type !== 'UNPAID',
          reason: input.reason ?? null,
          ...(approved
            ? {
                approvedAt: new Date(),
                approvedByCompanyUserId: this.context.membership()?.companyUserId ?? null,
              }
            : {}),
        },
        select: SELECT,
      });
      return { row, conflicts };
    });
    await this.audit.record({
      action: 'time_off.created',
      resourceType: 'employee_time_off',
      resourceId: result.row.id,
      after: auditable(result.row),
      ...(result.conflicts.length
        ? { metadata: { overlapsAppointments: result.conflicts.length } }
        : {}),
    });
    return { ...toResponse(result.row), conflicts: result.conflicts };
  }

  async update(id: string, input: UpdateTimeOffDto) {
    const result = await this.timeOff.transaction(async (tx, companyId) => {
      const scope = await this.scope(tx, companyId);
      const before = await tx.employeeTimeOff.findFirst({
        where: { id, companyId },
        select: SELECT,
      });
      if (!before) throw new ResourceNotFoundError('TimeOff', id);

      if (scope.kind === 'own') {
        // A requester changes only their own pending request, and may withdraw it.
        if (scope.employeeId !== before.employeeId) throw new ResourceNotFoundError('TimeOff', id);
        if (before.status !== 'PENDING') {
          throw new ConflictError('Only a pending request can be changed. Ask a manager.', {
            status: before.status,
          });
        }
        if (input.status && input.status !== 'CANCELLED') {
          throw new PermissionDeniedError([COMPANY_PERMISSIONS.TIME_OFF_APPROVE]);
        }
      }
      if (input.status) assertTransition(before.status, input.status);
      if (before.status === 'CANCELLED' || before.status === 'REJECTED') {
        throw new ConflictError('This time off is closed.', { status: before.status });
      }

      const { startsAt, endsAt } = period(
        input.startsAt ?? before.startsAt.toISOString(),
        input.endsAt ?? before.endsAt.toISOString(),
      );
      const willBeApproved = (input.status ?? before.status) === 'APPROVED';
      const conflicts = willBeApproved
        ? await this.conflicts(tx, companyId, before.employeeId, startsAt, endsAt)
        : [];
      if (conflicts.length && !input.allowConflicts) throw new TimeOffConflictError(conflicts);

      // Compare-and-swap on the row as read. Two managers approving and
      // rejecting at once both read PENDING; the second write must fail, not
      // vanish while still being reported and audited as done.
      const { count } = await tx.employeeTimeOff.updateMany({
        where: { id, companyId, status: before.status, updatedAt: before.updatedAt },
        data: {
          ...(input.type ? { type: input.type } : {}),
          ...(input.startsAt || input.endsAt ? { startsAt, endsAt } : {}),
          ...(input.isPaid !== undefined ? { isPaid: input.isPaid } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.status ? { status: input.status as TimeOffStatus } : {}),
          ...(input.status === 'APPROVED'
            ? {
                approvedAt: new Date(),
                approvedByCompanyUserId: this.context.membership()?.companyUserId ?? null,
              }
            : {}),
          ...(input.status === 'REJECTED'
            ? { rejectionReason: input.rejectionReason ?? null }
            : {}),
        },
      });
      if (count === 0) {
        throw new ConflictError('This time off was changed by someone else. Reload and retry.');
      }
      const after = await tx.employeeTimeOff.findFirstOrThrow({
        where: { id, companyId },
        select: SELECT,
      });
      return { before, after, conflicts };
    });
    await this.audit.record({
      action: input.status ? `time_off.${input.status.toLowerCase()}` : 'time_off.updated',
      resourceType: 'employee_time_off',
      resourceId: id,
      before: auditable(result.before),
      after: auditable(result.after),
    });
    return { ...toResponse(result.after), conflicts: result.conflicts };
  }

  /** DELETE = cancel. The record stays, as history. */
  remove(id: string) {
    return this.update(id, { status: 'CANCELLED' });
  }

  // ===========================================================================

  /** `any`: timeoff:approve. `own`: timeoff:request, for the employee linked to you. */
  private async scope(tx: TenantTx, companyId: string) {
    if (this.context.hasPermission(COMPANY_PERMISSIONS.TIME_OFF_APPROVE))
      return { kind: 'any' as const, employeeId: null };
    const actor = this.context.actor;
    const employee =
      actor?.kind === 'COMPANY_USER'
        ? await tx.employee.findFirst({
            where: { companyId, userAccountId: actor.userAccountId, deletedAt: null },
            select: { id: true },
          })
        : null;
    return { kind: 'own' as const, employeeId: employee?.id ?? null };
  }

  private async employee(tx: TenantTx, companyId: string, employeeId: string) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new ResourceNotFoundError('Employee', employeeId);
  }

  /** Booked appointments the employee has in the period. */
  private async conflicts(
    tx: TenantTx,
    companyId: string,
    employeeId: string,
    startsAt: Date,
    endsAt: Date,
  ) {
    // The lock bookings take for this employee: a booking in flight either
    // commits first (and is listed below) or waits and then sees this time off.
    await lockKeys(tx, [employeeLockKey(companyId, employeeId)]);
    const items = await tx.appointmentItem.findMany({
      where: {
        companyId,
        employeeId,
        blocksCalendar: true,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      select: {
        startsAt: true,
        endsAt: true,
        appointment: { select: { id: true, appointmentNumber: true } },
      },
    });
    return items.map((i) => ({
      appointmentId: i.appointment.id,
      appointmentNumber: i.appointment.appointmentNumber,
      startsAt: i.startsAt,
      endsAt: i.endsAt,
    }));
  }
}

function period(from: string, to: string) {
  const startsAt = new Date(from);
  const endsAt = new Date(to);
  if (!(endsAt > startsAt))
    throw new ValidationFailedError({ endsAt: 'The end must be after the start.' });
  if (endsAt.getTime() - startsAt.getTime() > MAX_DAYS * 86_400_000) {
    throw new ValidationFailedError({ endsAt: `Time off can be at most ${MAX_DAYS} days long.` });
  }
  return { startsAt, endsAt };
}

const TRANSITIONS: Record<string, readonly string[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
};

function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new ConflictError(
      `Time off that is ${from.toLowerCase()} cannot become ${to.toLowerCase()}.`,
      { from, to },
    );
  }
}

function toResponse(row: Row) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employee.displayName,
    type: row.type,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isPaid: row.isPaid,
    reason: row.reason,
    approvedAt: row.approvedAt,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function auditable(row: Row) {
  return {
    employeeId: row.employeeId,
    type: row.type,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  };
}
