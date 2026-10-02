import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantTx } from '../database/tenant-prisma.service';
import {
  AnalyticsScopeService,
  appointmentFiltered,
  appointmentWhere,
  branchOn,
  eachDay,
  itemExists,
  itemWhere,
  money,
  rate,
  type ReportScope,
} from './analytics-scope';
import { AnalyticsRepository } from './analytics.service';
import type { ReportQueryDto } from './dto/analytics.dto';

/** Services drawn in the booking-trend chart. */
const TREND_SERVICES = 5;

interface StatusCounts {
  bookings: number;
  completed: number;
  cancelled: number;
  noShow: number;
}

/**
 * ===========================================================================
 * REPORTS
 * ===========================================================================
 *
 * Five reports — appointments, customers, services, promotions, gift cards —
 * over one filter shape (see AnalyticsScopeService).
 *
 * Every figure is a GROUP BY in PostgreSQL; nothing loads appointments or
 * customers to count them here. Breakdowns are paged with `limit`/`offset`
 * and carry `total` (the number of groups) so a table can page through them.
 * Names come from a JOIN in the same statement — no per-row lookups.
 *
 * No report returns a customer's name, email or phone. Customer figures are
 * counts; the only identifiers anywhere are ids of services, employees,
 * branches and promotions.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly scopes: AnalyticsScopeService,
  ) {}

  // ===========================================================================
  // Appointments
  // ===========================================================================

  async appointments(query: ReportQueryDto) {
    return this.repository.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);
      const where = appointmentWhere(scope);

      const [byStatus, byDayRows, byService, byEmployee, byBranch] = await Promise.all([
        tx.$queryRaw<Array<{ status: string; count: bigint; value: bigint }>>`
          SELECT a.status::text AS status,
                 COUNT(*)::bigint AS count,
                 COALESCE(SUM(a.total_minor) FILTER (WHERE a.status NOT IN ('CANCELLED')), 0)::bigint AS value
            FROM appointment a
           WHERE ${where}
           GROUP BY 1
        `,
        tx.$queryRaw<Array<{ day: string; status: string; count: bigint }>>`
          SELECT to_char((a.starts_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
                 a.status::text AS status,
                 COUNT(*)::bigint AS count
            FROM appointment a
           WHERE ${where}
           GROUP BY 1, 2
        `,
        this.itemBreakdown(tx, scope, 'service'),
        this.itemBreakdown(tx, scope, 'employee'),
        tx.$queryRaw<BreakdownRow[]>`
          SELECT a.branch_id AS id, b.name AS name,
                 COUNT(*)::bigint AS bookings,
                 COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::bigint AS completed,
                 COUNT(*) FILTER (WHERE a.status = 'CANCELLED')::bigint AS cancelled,
                 COUNT(*) FILTER (WHERE a.status = 'NO_SHOW')::bigint AS no_show,
                 COALESCE(SUM(a.total_minor) FILTER (WHERE a.status NOT IN ('CANCELLED')), 0)::bigint AS value,
                 COUNT(*) OVER ()::bigint AS groups
            FROM appointment a
            LEFT JOIN branch b ON b.company_id = a.company_id AND b.id = a.branch_id
           WHERE ${where}
           GROUP BY a.branch_id, b.name
           ORDER BY bookings DESC, b.name
           LIMIT ${scope.limit} OFFSET ${scope.offset}
        `,
      ]);

      const count = (status: string) =>
        Number(byStatus.find((r) => r.status === status)?.count ?? 0n);
      const total = byStatus.reduce((sum, r) => sum + Number(r.count), 0);
      const completed = count('COMPLETED');
      const cancelled = count('CANCELLED');
      const noShow = count('NO_SHOW');

      const days = new Map(
        eachDay(scope.fromDate, scope.toDate).map((date) => [
          date,
          { date, total: 0, completed: 0, cancelled: 0, noShow: 0, other: 0 },
        ]),
      );
      for (const row of byDayRows) {
        const day = days.get(row.day);
        if (!day) continue;
        const n = Number(row.count);
        day.total += n;
        if (row.status === 'COMPLETED') day.completed += n;
        else if (row.status === 'CANCELLED') day.cancelled += n;
        else if (row.status === 'NO_SHOW') day.noShow += n;
        else day.other += n;
      }

      return {
        ...header(scope),
        totals: {
          total,
          pending: count('PENDING'),
          confirmed: count('CONFIRMED'),
          checkedIn: count('CHECKED_IN'),
          inProgress: count('IN_PROGRESS'),
          completed,
          cancelled,
          noShow,
          completionRateBps: rate(completed, total),
          cancellationRateBps: rate(cancelled, total),
          noShowRateBps: rate(noShow, total),
          /** Booked value of everything not cancelled. Booked, not paid — see /reports/revenue. */
          bookedValueMinor: money(
            byStatus.reduce((sum, r) => sum + r.value, 0n),
            scope.canSeeMoney,
          ),
        },
        byDay: [...days.values()],
        byService: page(byService, scope),
        byEmployee: page(byEmployee, scope),
        byBranch: page(byBranch, scope),
      };
    });
  }

  // ===========================================================================
  // Customers
  // ===========================================================================

  /**
   * New, active and returning customers.
   *
   * Without appointment filters, "new" is every customer created in the range
   * and the running total starts from everybody who already existed. With a
   * branch, employee, service or status filter — or a caller confined to some
   * branches — "new" means created in the range AND booked in it matching the
   * filters, and the company-wide running total is not shown (it would not
   * respect the filter).
   */
  async customers(query: ReportQueryDto) {
    return this.repository.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);
      const filtered = appointmentFiltered(scope);
      const where = appointmentWhere(scope);
      // "Active" = booked something that was not cancelled, unless the caller
      // asked for particular statuses.
      const activeStatuses = scope.statusFiltered
        ? Prisma.empty
        : Prisma.sql`AND a.status <> 'CANCELLED'`;

      const [newRows, active, before] = await Promise.all([
        tx.$queryRaw<Array<{ day: string; count: bigint }>>`
          SELECT to_char((c.created_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
                 COUNT(*)::bigint AS count
            FROM company_customer c
           WHERE c.company_id = ${companyId}::uuid
             AND c.deleted_at IS NULL
             AND c.created_at >= ${scope.start}
             AND c.created_at <  ${scope.end}
             ${
               filtered
                 ? Prisma.sql`AND EXISTS (SELECT 1 FROM appointment a
                                            WHERE a.customer_id = c.id AND ${where})`
                 : Prisma.empty
             }
           GROUP BY 1
        `,
        tx.$queryRaw<Array<{ active: bigint; returning: bigint }>>`
          SELECT COUNT(DISTINCT a.customer_id)::bigint AS active,
                 COUNT(DISTINCT a.customer_id) FILTER (WHERE c.created_at < ${scope.start})::bigint AS returning
            FROM appointment a
            JOIN company_customer c ON c.company_id = a.company_id AND c.id = a.customer_id
           WHERE ${where} ${activeStatuses}
             AND c.deleted_at IS NULL
        `,
        filtered
          ? Promise.resolve(null)
          : tx.companyCustomer.count({
              where: { companyId, deletedAt: null, createdAt: { lt: scope.start } },
            }),
      ]);

      const perDay = new Map(newRows.map((r) => [r.day, Number(r.count)]));
      let running = before ?? 0;
      const byDay = eachDay(scope.fromDate, scope.toDate).map((date) => {
        const newCustomers = perDay.get(date) ?? 0;
        running += newCustomers;
        return { date, newCustomers, totalCustomers: before === null ? null : running };
      });
      const newCustomers = byDay.reduce((sum, d) => sum + d.newCustomers, 0);

      return {
        ...header(scope),
        filtered,
        totals: {
          newCustomers,
          activeCustomers: Number(active[0]?.active ?? 0n),
          returningCustomers: Number(active[0]?.returning ?? 0n),
          /** Everybody at the end of the range; null when filters make it meaningless. */
          totalCustomers: before === null ? null : before + newCustomers,
          startingTotal: before,
        },
        byDay,
      };
    });
  }

  // ===========================================================================
  // Services
  // ===========================================================================

  async services(query: ReportQueryDto) {
    return this.repository.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);

      const [ranked, totalRows] = await Promise.all([
        this.itemBreakdown(tx, scope, 'service'),
        tx.$queryRaw<Array<{ bookings: bigint }>>`
          SELECT COUNT(*)::bigint AS bookings
            FROM appointment_item i
            JOIN appointment a ON a.company_id = i.company_id AND a.id = i.appointment_id
           WHERE ${itemWhere(scope)}
        `,
      ]);
      const allBookings = Number(totalRows[0]?.bookings ?? 0n);

      // The trend follows the top services of the whole range, not of the
      // current page, so paging the table does not redraw the chart.
      const top = await tx.$queryRaw<Array<{ id: string; name: string | null }>>`
        SELECT i.service_id AS id, s.name AS name
          FROM appointment_item i
          JOIN appointment a ON a.company_id = i.company_id AND a.id = i.appointment_id
          LEFT JOIN service s ON s.company_id = i.company_id AND s.id = i.service_id
         WHERE ${itemWhere(scope)}
         GROUP BY i.service_id, s.name
         ORDER BY COUNT(*) DESC, s.name
         LIMIT ${TREND_SERVICES}
      `;

      const trendRows =
        top.length === 0
          ? []
          : await tx.$queryRaw<Array<{ day: string; id: string; count: bigint }>>`
              SELECT to_char((a.starts_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
                     i.service_id AS id,
                     COUNT(*)::bigint AS count
                FROM appointment_item i
                JOIN appointment a ON a.company_id = i.company_id AND a.id = i.appointment_id
               WHERE ${itemWhere(scope)}
                 AND i.service_id = ANY(${top.map((t) => t.id)}::uuid[])
               GROUP BY 1, 2
            `;

      const cells = new Map(trendRows.map((r) => [`${r.day}:${r.id}`, Number(r.count)]));
      const items = page(ranked, scope);

      return {
        ...header(scope),
        totals: { bookings: allBookings, services: items.total },
        items: {
          ...items,
          items: items.items.map((row) => ({ ...row, shareBps: rate(row.bookings, allBookings) })),
        },
        trend: {
          services: top.map((t) => ({ serviceId: t.id, name: t.name })),
          days: eachDay(scope.fromDate, scope.toDate).map((date) => ({
            date,
            counts: Object.fromEntries(top.map((t) => [t.id, cells.get(`${date}:${t.id}`) ?? 0])),
          })),
        },
      };
    });
  }

  // ===========================================================================
  // Promotions
  // ===========================================================================

  /**
   * Redemptions in the range, by when they were redeemed. Branch, employee,
   * service and status filters apply through the appointment each redemption
   * belongs to.
   */
  async promotions(query: ReportQueryDto) {
    return this.repository.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);
      const where = Prisma.sql`
            r.company_id = ${companyId}::uuid
        AND r.redeemed_at >= ${scope.start}
        AND r.redeemed_at <  ${scope.end}
        AND a.status::text = ANY(${scope.statuses}::text[])
        ${branchOn(scope, Prisma.sql`a.branch_id`)}
        ${itemExists(scope)}
      `;
      const from = Prisma.sql`
        FROM promotion_redemption r
        JOIN appointment a ON a.company_id = r.company_id AND a.id = r.appointment_id
      `;

      const [totals, byPromotion, byDayRows] = await Promise.all([
        tx.$queryRaw<
          Array<{ redemptions: bigint; discount: bigint; customers: bigint; promotions: bigint }>
        >`
          SELECT COUNT(*)::bigint AS redemptions,
                 COALESCE(SUM(r.discount_minor), 0)::bigint AS discount,
                 COUNT(DISTINCT r.customer_id)::bigint AS customers,
                 COUNT(DISTINCT r.promotion_id)::bigint AS promotions
            ${from}
           WHERE ${where}
        `,
        tx.$queryRaw<
          Array<{
            id: string;
            name: string | null;
            discount_type: string | null;
            status: string | null;
            max_redemptions: number | null;
            redeemed_count: number | null;
            redemptions: bigint;
            customers: bigint;
            discount: bigint;
            groups: bigint;
          }>
        >`
          SELECT r.promotion_id AS id, p.name, p.discount_type::text AS discount_type,
                 p.status::text AS status, p.max_redemptions, p.redeemed_count,
                 COUNT(*)::bigint AS redemptions,
                 COUNT(DISTINCT r.customer_id)::bigint AS customers,
                 COALESCE(SUM(r.discount_minor), 0)::bigint AS discount,
                 COUNT(*) OVER ()::bigint AS groups
            ${from}
            LEFT JOIN promotion p ON p.company_id = r.company_id AND p.id = r.promotion_id
           WHERE ${where}
           GROUP BY r.promotion_id, p.name, p.discount_type, p.status, p.max_redemptions, p.redeemed_count
           ORDER BY redemptions DESC, p.name
           LIMIT ${scope.limit} OFFSET ${scope.offset}
        `,
        tx.$queryRaw<Array<{ day: string; redemptions: bigint; discount: bigint }>>`
          SELECT to_char((r.redeemed_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
                 COUNT(*)::bigint AS redemptions,
                 COALESCE(SUM(r.discount_minor), 0)::bigint AS discount
            ${from}
           WHERE ${where}
           GROUP BY 1
        `,
      ]);

      const t = totals[0];
      const perDay = new Map(byDayRows.map((r) => [r.day, r]));

      return {
        ...header(scope),
        totals: {
          redemptions: Number(t?.redemptions ?? 0n),
          customers: Number(t?.customers ?? 0n),
          promotionsUsed: Number(t?.promotions ?? 0n),
          discountMinor: money(t?.discount, scope.canSeeMoney),
        },
        byPromotion: {
          items: byPromotion.map((row) => ({
            promotionId: row.id,
            name: row.name,
            discountType: row.discount_type,
            status: row.status,
            redemptions: Number(row.redemptions),
            customers: Number(row.customers),
            discountMinor: money(row.discount, scope.canSeeMoney),
            /** All-time usage against the cap, for context. */
            usage: { redeemed: row.redeemed_count ?? 0, limit: row.max_redemptions },
          })),
          total: Number(byPromotion[0]?.groups ?? 0n),
          limit: scope.limit,
          offset: scope.offset,
        },
        byDay: eachDay(scope.fromDate, scope.toDate).map((date) => {
          const row = perDay.get(date);
          return {
            date,
            redemptions: Number(row?.redemptions ?? 0n),
            discountMinor: money(row?.discount ?? 0n, scope.canSeeMoney),
          };
        }),
      };
    });
  }

  // ===========================================================================
  // Gift cards
  // ===========================================================================

  /**
   * Issued cards, the current state of every card, and redemption activity.
   *
   * Cards belong to the company, not to a branch, so the card inventory is
   * company-wide and is shown only to callers who are not confined to some
   * branches. Redemption activity follows the branch filter through the
   * appointment a redemption paid for; a redemption with no appointment is
   * company-level and excluded when a branch is chosen. Employee, service and
   * status filters do not apply to cards and are ignored here (`appliedFilters`
   * says so).
   */
  async giftCards(query: ReportQueryDto) {
    return this.repository.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);
      const showInventory = !scope.branchRestricted;
      const branchActivity =
        scope.branchIds === null
          ? Prisma.empty
          : Prisma.sql`AND a.branch_id = ANY(${scope.branchIds}::uuid[])`;

      const [issued, states, activity] = await Promise.all([
        showInventory
          ? tx.$queryRaw<Array<{ count: bigint; value: bigint }>>`
              SELECT COUNT(*)::bigint AS count,
                     COALESCE(SUM(g.initial_balance_minor), 0)::bigint AS value
                FROM gift_card g
               WHERE g.company_id = ${companyId}::uuid
                 AND g.issued_at >= ${scope.start}
                 AND g.issued_at <  ${scope.end}
            `
          : Promise.resolve(null),
        showInventory
          ? tx.$queryRaw<Array<{ status: string; count: bigint; balance: bigint }>>`
              SELECT CASE WHEN g.status = 'ACTIVE' AND g.expires_at IS NOT NULL AND g.expires_at <= now()
                          THEN 'EXPIRED' ELSE g.status::text END AS status,
                     COUNT(*)::bigint AS count,
                     COALESCE(SUM(g.current_balance_minor), 0)::bigint AS balance
                FROM gift_card g
               WHERE g.company_id = ${companyId}::uuid
               GROUP BY 1
            `
          : Promise.resolve(null),
        tx.$queryRaw<Array<{ day: string; type: string; count: bigint; amount: bigint }>>`
          SELECT to_char((t.occurred_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
                 t.type::text AS type,
                 COUNT(*)::bigint AS count,
                 COALESCE(SUM(abs(t.amount_minor)), 0)::bigint AS amount
            FROM gift_card_transaction t
            LEFT JOIN appointment a ON a.company_id = t.company_id AND a.id = t.appointment_id
           WHERE t.company_id = ${companyId}::uuid
             AND t.type IN ('REDEEM', 'REFUND')
             AND t.occurred_at >= ${scope.start}
             AND t.occurred_at <  ${scope.end}
             ${branchActivity}
           GROUP BY 1, 2
        `,
      ]);

      const state = (name: string) => states?.find((s) => s.status === name);
      const byStatus = (states ?? []).map((s) => ({
        status: s.status,
        count: Number(s.count),
        balanceMinor: money(s.balance, scope.canSeeMoney),
      }));

      const days = new Map(
        eachDay(scope.fromDate, scope.toDate).map((date) => [
          date,
          { date, redemptions: 0, redeemed: 0n, refunds: 0, refunded: 0n },
        ]),
      );
      for (const row of activity) {
        const day = days.get(row.day);
        if (!day) continue;
        if (row.type === 'REDEEM') {
          day.redemptions += Number(row.count);
          day.redeemed += row.amount;
        } else {
          day.refunds += Number(row.count);
          day.refunded += row.amount;
        }
      }
      const series = [...days.values()];

      return {
        ...header(scope),
        appliedFilters: {
          dateRange: true,
          branch: true,
          employee: false,
          service: false,
          status: false,
        },
        inventoryVisible: showInventory,
        issued: issued
          ? {
              count: Number(issued[0]?.count ?? 0n),
              initialValueMinor: money(issued[0]?.value, scope.canSeeMoney),
            }
          : null,
        cards: states
          ? {
              active: Number(state('ACTIVE')?.count ?? 0n),
              expired: Number(state('EXPIRED')?.count ?? 0n),
              depleted: Number(state('DEPLETED')?.count ?? 0n),
              disabled: Number(state('DISABLED')?.count ?? 0n),
              void: Number(state('VOID')?.count ?? 0n),
              /** What active, unexpired cards still hold — the outstanding liability. */
              outstandingBalanceMinor: money(state('ACTIVE')?.balance, scope.canSeeMoney),
              expiredBalanceMinor: money(state('EXPIRED')?.balance, scope.canSeeMoney),
              byStatus,
            }
          : null,
        redemptions: {
          totals: {
            redemptions: series.reduce((s, d) => s + d.redemptions, 0),
            redeemedMinor: money(
              series.reduce((s, d) => s + d.redeemed, 0n),
              scope.canSeeMoney,
            ),
            refunds: series.reduce((s, d) => s + d.refunds, 0),
            refundedMinor: money(
              series.reduce((s, d) => s + d.refunded, 0n),
              scope.canSeeMoney,
            ),
          },
          byDay: series.map((d) => ({
            date: d.date,
            redemptions: d.redemptions,
            redeemedMinor: money(d.redeemed, scope.canSeeMoney),
            refunds: d.refunds,
            refundedMinor: money(d.refunded, scope.canSeeMoney),
          })),
        },
      };
    });
  }

  // ---------------------------------------------------------------------------

  /** Line items grouped by service or employee, with names joined in and paged. */
  private itemBreakdown(tx: TenantTx, scope: ReportScope, by: 'service' | 'employee') {
    const where = itemWhere(scope);
    return by === 'service'
      ? tx.$queryRaw<BreakdownRow[]>`
          SELECT i.service_id AS id, s.name AS name,
                 ${breakdownColumns}
            FROM appointment_item i
            JOIN appointment a ON a.company_id = i.company_id AND a.id = i.appointment_id
            LEFT JOIN service s ON s.company_id = i.company_id AND s.id = i.service_id
           WHERE ${where}
           GROUP BY i.service_id, s.name
           ORDER BY bookings DESC, s.name
           LIMIT ${scope.limit} OFFSET ${scope.offset}
        `
      : tx.$queryRaw<BreakdownRow[]>`
          SELECT i.employee_id AS id, e.display_name AS name,
                 ${breakdownColumns}
            FROM appointment_item i
            JOIN appointment a ON a.company_id = i.company_id AND a.id = i.appointment_id
            LEFT JOIN employee e ON e.company_id = i.company_id AND e.id = i.employee_id
           WHERE ${where}
             -- A resource-only booking has no employee: not a row anyone can act on.
             AND i.employee_id IS NOT NULL
           GROUP BY i.employee_id, e.display_name
           ORDER BY bookings DESC, e.display_name
           LIMIT ${scope.limit} OFFSET ${scope.offset}
        `;
  }
}

interface BreakdownRow {
  id: string;
  name: string | null;
  bookings: bigint;
  completed: bigint;
  cancelled: bigint;
  no_show: bigint;
  value: bigint;
  groups: bigint;
}

const breakdownColumns = Prisma.sql`
  COUNT(*)::bigint AS bookings,
  COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::bigint AS completed,
  COUNT(*) FILTER (WHERE a.status = 'CANCELLED')::bigint AS cancelled,
  COUNT(*) FILTER (WHERE a.status = 'NO_SHOW')::bigint AS no_show,
  COALESCE(SUM(i.total_minor) FILTER (WHERE a.status NOT IN ('CANCELLED')), 0)::bigint AS value,
  COUNT(*) OVER ()::bigint AS groups
`;

function page(rows: BreakdownRow[], scope: ReportScope) {
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      ...counts(row),
      bookedValueMinor: money(row.value, scope.canSeeMoney),
    })),
    total: Number(rows[0]?.groups ?? 0n),
    limit: scope.limit,
    offset: scope.offset,
  };
}

function counts(row: BreakdownRow): StatusCounts {
  return {
    bookings: Number(row.bookings),
    completed: Number(row.completed),
    cancelled: Number(row.cancelled),
    noShow: Number(row.no_show),
  };
}

function header(scope: ReportScope) {
  return {
    range: { from: scope.fromDate, to: scope.toDate, timezone: scope.timezone },
    filters: {
      branchIds: scope.branchIds,
      employeeId: scope.employeeId,
      serviceId: scope.serviceId,
      statuses: scope.statuses,
    },
    amountsVisible: scope.canSeeMoney,
  };
}
