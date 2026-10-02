import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { BranchOutOfScopeError, ResourceNotFoundError } from '../common/errors';
import type { TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { REPORT_STATUSES, type ReportQueryDto, type ReportStatus } from './dto/analytics.dto';

/**
 * Everything a report query needs to know about WHO is asking and WHAT they
 * asked for, resolved once and validated against the tenant.
 */
export interface ReportScope {
  readonly companyId: string;
  /** The company's IANA zone. Days are bucketed and ranges bounded in it. */
  readonly timezone: string;
  readonly fromDate: string;
  readonly toDate: string;
  /** [start, end) as instants: local midnight of `from` to local midnight after `to`. */
  readonly start: Date;
  readonly end: Date;
  /**
   * null = every branch. An array (possibly EMPTY) = only these — either the
   * one branch asked for, or the caller's branch scope. Empty means the caller
   * may see no branch at all, and every figure is zero rather than everything.
   */
  readonly branchIds: string[] | null;
  /** True when the caller is confined to some branches by their membership. */
  readonly branchRestricted: boolean;
  readonly employeeId: string | null;
  readonly serviceId: string | null;
  readonly statuses: ReportStatus[];
  readonly statusFiltered: boolean;
  /** Money needs `report:revenue:read`; counts need only `report:read`. */
  readonly canSeeMoney: boolean;
  readonly limit: number;
  readonly offset: number;
}

/**
 * ===========================================================================
 * FILTERS THAT RESPECT WHO IS ASKING
 * ===========================================================================
 *
 *   - Tenant: every id in the query is looked up inside this company. Another
 *     company's branch, employee or service is a 404 — indistinguishable from
 *     one that does not exist — never a silently empty report.
 *
 *   - Branch scope: a member confined to some branches
 *     (`company_user_branch`) sees only those. Naming a branch outside the
 *     scope is a 404; naming none means "all of MY branches", never "all".
 *
 *   - Money: amounts are included only for `report:revenue:read`. Without it
 *     the same report comes back with counts and `amountsVisible: false` —
 *     explicit, so a screen can say why a column is missing.
 *
 *   - Time: `from`/`to` are calendar days in the company's timezone. A salon in
 *     Ulaanbaatar asking for "Monday" gets its Monday, not UTC's.
 */
@Injectable()
export class AnalyticsScopeService {
  constructor(private readonly context: RequestContextService) {}

  get canSeeMoney(): boolean {
    return this.context.hasPermission(COMPANY_PERMISSIONS.REPORT_REVENUE_READ);
  }

  get timezone(): string {
    return this.context.requireCompany('analytics').defaultTimezoneName;
  }

  /** The caller's branch scope applied to an optional explicit branch. */
  async branchIds(tx: TenantTx, companyId: string, branchId: string | undefined) {
    const scope = this.context.membership()?.branchScope ?? null;
    if (branchId) {
      if (scope && !scope.includes(branchId)) throw new BranchOutOfScopeError();
      const branch = await tx.branch.findFirst({
        where: { id: branchId, companyId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw new ResourceNotFoundError('Branch', branchId);
      return { branchIds: [branchId], branchRestricted: scope !== null };
    }
    return { branchIds: scope ? [...scope] : null, branchRestricted: scope !== null };
  }

  async resolve(tx: TenantTx, companyId: string, query: ReportQueryDto): Promise<ReportScope> {
    const timezone = this.timezone;
    const { branchIds, branchRestricted } = await this.branchIds(tx, companyId, query.branchId);

    if (query.employeeId) {
      const employee = await tx.employee.findFirst({
        where: { id: query.employeeId, companyId },
        select: { id: true },
      });
      if (!employee) throw new ResourceNotFoundError('Employee', query.employeeId);
    }
    if (query.serviceId) {
      const service = await tx.service.findFirst({
        where: { id: query.serviceId, companyId },
        select: { id: true },
      });
      if (!service) throw new ResourceNotFoundError('Service', query.serviceId);
    }

    const statuses = query.status
      ? [...new Set(query.status.split(',').map((s) => s.trim() as ReportStatus))]
      : [...REPORT_STATUSES];

    const { start, end } = await localRange(tx, query.from, query.to, timezone);

    return {
      companyId,
      timezone,
      fromDate: query.from,
      toDate: query.to,
      start,
      end,
      branchIds,
      branchRestricted,
      employeeId: query.employeeId ?? null,
      serviceId: query.serviceId ?? null,
      statuses,
      statusFiltered: Boolean(query.status),
      canSeeMoney: this.canSeeMoney,
      limit: query.limit,
      offset: query.offset,
    };
  }
}

/**
 * Local midnight of `from` to local midnight after `to`, as instants. Postgres
 * does the zone arithmetic — it knows every DST rule, and doing it here means
 * the bounds and the day buckets can never disagree.
 */
export async function localRange(tx: TenantTx, from: string, to: string, timezone: string) {
  const rows = await tx.$queryRaw<Array<{ start: Date; end: Date }>>`
    SELECT (${from}::date)::timestamp AT TIME ZONE ${timezone}       AS "start",
           ((${to}::date) + 1)::timestamp AT TIME ZONE ${timezone}   AS "end"
  `;
  const row = rows[0]!;
  return { start: new Date(row.start), end: new Date(row.end) };
}

/** Today's date in a zone, as `YYYY-MM-DD`. */
export async function localToday(tx: TenantTx, timezone: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ day: string }>>`
    SELECT to_char((now() AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day
  `;
  return rows[0]!.day;
}

// ---------------------------------------------------------------------------
// SQL fragments. Every value is a bound parameter; only fixed identifiers are
// written into the text.
// ---------------------------------------------------------------------------

/** Conditions on `appointment a` for a scope: company, range, status, branch, employee/service. */
export function appointmentWhere(scope: ReportScope): Prisma.Sql {
  return Prisma.sql`
        a.company_id = ${scope.companyId}::uuid
    AND a.starts_at >= ${scope.start}
    AND a.starts_at <  ${scope.end}
    AND a.status::text = ANY(${scope.statuses}::text[])
    ${branchOn(scope, Prisma.sql`a.branch_id`)}
    ${itemExists(scope)}
  `;
}

/**
 * Conditions on `appointment_item i JOIN appointment a` for item-level
 * breakdowns: the employee/service filters apply to the item itself.
 */
export function itemWhere(scope: ReportScope): Prisma.Sql {
  return Prisma.sql`
        i.company_id = ${scope.companyId}::uuid
    AND a.starts_at >= ${scope.start}
    AND a.starts_at <  ${scope.end}
    AND a.status::text = ANY(${scope.statuses}::text[])
    ${branchOn(scope, Prisma.sql`a.branch_id`)}
    ${scope.employeeId ? Prisma.sql`AND i.employee_id = ${scope.employeeId}::uuid` : Prisma.empty}
    ${scope.serviceId ? Prisma.sql`AND i.service_id = ${scope.serviceId}::uuid` : Prisma.empty}
  `;
}

export function branchOn(scope: ReportScope, column: Prisma.Sql): Prisma.Sql {
  return scope.branchIds === null
    ? Prisma.empty
    : Prisma.sql`AND ${column} = ANY(${scope.branchIds}::uuid[])`;
}

/** The appointment has a line item for the filtered employee and/or service. */
export function itemExists(scope: ReportScope, appointment = Prisma.sql`a`): Prisma.Sql {
  if (!scope.employeeId && !scope.serviceId) return Prisma.empty;
  return Prisma.sql`
    AND EXISTS (
      SELECT 1 FROM appointment_item fi
       WHERE fi.company_id = ${appointment}.company_id
         AND fi.appointment_id = ${appointment}.id
         ${scope.employeeId ? Prisma.sql`AND fi.employee_id = ${scope.employeeId}::uuid` : Prisma.empty}
         ${scope.serviceId ? Prisma.sql`AND fi.service_id = ${scope.serviceId}::uuid` : Prisma.empty}
    )`;
}

/** True when any filter narrows WHICH appointments count (not just when). */
export function appointmentFiltered(scope: ReportScope): boolean {
  return (
    scope.branchIds !== null || Boolean(scope.employeeId || scope.serviceId) || scope.statusFiltered
  );
}

/** Every date from `from` to `to` inclusive — for zero-filling a series. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Basis points, integer. 12.5% is 1250. */
export function rate(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000);
}

/** A money figure, or null when the caller may not see money. */
export function money(value: bigint | null | undefined, visible: boolean): string | null {
  return visible ? (value ?? 0n).toString() : null;
}
