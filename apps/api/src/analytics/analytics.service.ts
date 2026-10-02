import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import {
  AnalyticsScopeService,
  localRange,
  localToday,
  money,
  type ReportScope,
} from './analytics-scope';
import type { DashboardQueryDto, ReportQueryDto } from './dto/analytics.dto';

interface AppointmentRow {
  id: string;
  companyId: string;
  status: string;
}

@Injectable()
export class AnalyticsRepository extends TenantScopedRepository<AppointmentRow> {
  protected readonly modelName = 'Appointment';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<AppointmentRow> {
    return tx.appointment;
  }
}

/** Real bookings. HOLD and EXPIRED are seats the booking page held briefly. */
const REAL = { notIn: ['HOLD', 'EXPIRED'] as Array<'HOLD' | 'EXPIRED'> };
const DAY_MS = 24 * 60 * 60_000;
const UPCOMING_DAYS = 7;

/**
 * The dashboard, and the two money reports (revenue, payment methods).
 *
 * ===========================================================================
 * AGGREGATE IN SQL, ALWAYS
 * ===========================================================================
 *
 * Every figure is a `groupBy`, an `aggregate`, a `count` or a GROUP BY in raw
 * SQL. Nothing loads rows to reduce them in JavaScript. The indexes are listed
 * in migration `20260930090000_report_indexes` and the schema.
 *
 * ===========================================================================
 * COUNTS FOR `report:read`, MONEY FOR `report:revenue:read`
 * ===========================================================================
 *
 * The dashboard is for anybody who may read reports. Money on it — revenue,
 * outstanding balances, discount given, gift-card balances — appears only for
 * `report:revenue:read`; otherwise those fields are null and `restricted`
 * lists what was withheld, so the screen can say so rather than show zeros.
 *
 * Revenue means SETTLED PAYMENTS, net of refunds — what was taken — not
 * appointment totals, which include bookings nobody paid for.
 *
 * ===========================================================================
 * SCOPE
 * ===========================================================================
 *
 * "Today" is the company's today, in its timezone. A branch filter, or the
 * caller's branch scope, narrows every figure consistently.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly appointments: AnalyticsRepository,
    private readonly scopes: AnalyticsScopeService,
  ) {}

  async dashboard(query: DashboardQueryDto) {
    return this.appointments.transaction(async (tx, companyId) => {
      const timezone = this.scopes.timezone;
      const canSeeMoney = this.scopes.canSeeMoney;
      const { branchIds, branchRestricted } = await this.scopes.branchIds(
        tx,
        companyId,
        query.branchId,
      );
      const date = query.date ?? (await localToday(tx, timezone));
      const { start, end } = await localRange(tx, date, date, timezone);
      const windowDays = query.popularWindowDays ?? 30;
      const windowStart = new Date(end.getTime() - windowDays * DAY_MS);
      const now = new Date();

      const branch = branchIds === null ? {} : { branchId: { in: branchIds } };
      const viaAppointment =
        branchIds === null ? {} : { appointment: { branchId: { in: branchIds } } };
      // A new customer "belongs" to a branch when they have booked there.
      const customerBranch =
        branchIds === null ? {} : { appointments: { some: { branchId: { in: branchIds } } } };

      const [
        todayByStatus,
        upcoming,
        newToday,
        newInWindow,
        popular,
        promotions,
        topPromotion,
        activeCards,
        issuedInWindow,
        redemptions,
      ] = await Promise.all([
        tx.appointment.groupBy({
          by: ['status'],
          where: { companyId, ...branch, status: REAL, startsAt: { gte: start, lt: end } },
          _count: { _all: true },
        }),
        tx.appointment.count({
          where: {
            companyId,
            ...branch,
            status: { in: ['PENDING', 'CONFIRMED'] },
            startsAt: { gte: now, lt: new Date(now.getTime() + UPCOMING_DAYS * DAY_MS) },
          },
        }),
        tx.companyCustomer.count({
          where: {
            companyId,
            deletedAt: null,
            createdAt: { gte: start, lt: end },
            ...customerBranch,
          },
        }),
        tx.companyCustomer.count({
          where: {
            companyId,
            deletedAt: null,
            createdAt: { gte: windowStart, lt: end },
            ...customerBranch,
          },
        }),
        tx.appointmentItem.groupBy({
          by: ['serviceId'],
          where: {
            companyId,
            ...branch,
            status: { notIn: ['HOLD', 'EXPIRED', 'CANCELLED'] },
            startsAt: { gte: windowStart, lt: end },
          },
          _count: { _all: true },
          _sum: { totalMinor: true },
          orderBy: { _count: { serviceId: 'desc' } },
          take: 5,
        }),
        tx.promotionRedemption.aggregate({
          where: { companyId, redeemedAt: { gte: windowStart, lt: end }, ...viaAppointment },
          _count: { _all: true },
          _sum: { discountMinor: true },
        }),
        tx.promotionRedemption.groupBy({
          by: ['promotionId'],
          where: { companyId, redeemedAt: { gte: windowStart, lt: end }, ...viaAppointment },
          _count: { _all: true },
          orderBy: { _count: { promotionId: 'desc' } },
          take: 1,
        }),
        // Card inventory is company-wide; a branch-confined caller does not see it.
        branchRestricted
          ? Promise.resolve(null)
          : tx.giftCard.aggregate({
              where: {
                companyId,
                status: 'ACTIVE',
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
              _count: { _all: true },
              _sum: { currentBalanceMinor: true },
            }),
        branchRestricted
          ? Promise.resolve(null)
          : tx.giftCard.count({ where: { companyId, issuedAt: { gte: windowStart, lt: end } } }),
        tx.giftCardTransaction.aggregate({
          where: {
            companyId,
            type: 'REDEEM',
            occurredAt: { gte: windowStart, lt: end },
            ...viaAppointment,
          },
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
      ]);

      const [serviceNames, promotionName, revenue] = await Promise.all([
        this.nameServices(
          tx,
          companyId,
          popular.map((row) => row.serviceId),
        ),
        topPromotion[0]
          ? tx.promotion.findFirst({
              where: { companyId, id: topPromotion[0].promotionId },
              select: { name: true },
            })
          : Promise.resolve(null),
        canSeeMoney
          ? this.revenueToday(tx, companyId, branchIds, start, end)
          : Promise.resolve(null),
      ]);

      const count = (status: string) =>
        todayByStatus.find((r) => r.status === status)?._count._all ?? 0;
      const restricted = [
        ...(canSeeMoney ? [] : ['revenue', 'amounts']),
        ...(branchRestricted ? ['giftCardInventory'] : []),
      ];

      return {
        date,
        timezone,
        branchId: query.branchId ?? null,
        windowDays,
        restricted,
        amountsVisible: canSeeMoney,

        appointments: {
          today: todayByStatus.reduce((sum, r) => sum + r._count._all, 0),
          byStatus: Object.fromEntries(todayByStatus.map((r) => [r.status, r._count._all])),
          completed: count('COMPLETED'),
          cancelled: count('CANCELLED'),
          noShow: count('NO_SHOW'),
          /** Pending or confirmed, starting within the next seven days. */
          upcoming,
          upcomingDays: UPCOMING_DAYS,
        },

        customers: { newToday, newInWindow },

        popularServices: popular.map((row) => ({
          serviceId: row.serviceId,
          name: serviceNames.get(row.serviceId) ?? null,
          bookings: row._count._all,
          bookedValueMinor: money(row._sum.totalMinor, canSeeMoney),
        })),

        promotions: {
          redemptions: promotions._count._all,
          discountMinor: money(promotions._sum.discountMinor, canSeeMoney),
          topPromotion: topPromotion[0]
            ? {
                promotionId: topPromotion[0].promotionId,
                name: promotionName?.name ?? null,
                redemptions: topPromotion[0]._count._all,
              }
            : null,
        },

        giftCards: {
          activeCards: activeCards?._count._all ?? null,
          issuedInWindow: issuedInWindow,
          redemptions: redemptions._count._all,
          redeemedMinor: money(
            redemptions._sum.amountMinor === null ? 0n : -redemptions._sum.amountMinor,
            canSeeMoney,
          ),
          /** Kept under its old name too: the outstanding stored-value liability. */
          outstandingLiabilityMinor: activeCards
            ? money(activeCards._sum.currentBalanceMinor, canSeeMoney)
            : null,
        },

        /** Settled payments net of refunds, today. Null without `report:revenue:read`. */
        revenue: revenue?.revenue ?? null,
        /** Booked but not collected. Null without `report:revenue:read`. */
        outstanding: revenue?.outstanding ?? null,
      };
    });
  }

  /** Revenue by day, net of refunds. `report:revenue:read`. */
  async revenueByDate(query: ReportQueryDto) {
    return this.appointments.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);

      const rows = await tx.$queryRaw<
        Array<{ day: string; collected: bigint; refunded: bigint; payments: bigint }>
      >`
        SELECT to_char((p.created_at AT TIME ZONE ${scope.timezone})::date, 'YYYY-MM-DD') AS day,
               COALESCE(SUM(p.amount_minor), 0)::bigint     AS collected,
               COALESCE(SUM(p.refunded_minor), 0)::bigint   AS refunded,
               COUNT(*)::bigint                             AS payments
          FROM payment p
         WHERE p.company_id = ${companyId}::uuid
           AND p.status = 'SUCCEEDED'
           AND p.created_at >= ${scope.start}
           AND p.created_at <  ${scope.end}
           ${paymentBranch(scope)}
         GROUP BY 1
         ORDER BY 1
      `;

      return {
        from: scope.fromDate,
        to: scope.toDate,
        timezone: scope.timezone,
        items: rows.map((row) => ({
          date: row.day,
          collectedMinor: row.collected.toString(),
          refundedMinor: row.refunded.toString(),
          netMinor: (row.collected - row.refunded).toString(),
          paymentCount: Number(row.payments),
        })),
        totals: {
          collectedMinor: rows.reduce((s, r) => s + r.collected, 0n).toString(),
          refundedMinor: rows.reduce((s, r) => s + r.refunded, 0n).toString(),
          netMinor: rows.reduce((s, r) => s + r.collected - r.refunded, 0n).toString(),
        },
      };
    });
  }

  /** What people paid with — the end-of-day reconciliation sheet. `report:revenue:read`. */
  async paymentMethodSummary(query: ReportQueryDto) {
    return this.appointments.transaction(async (tx, companyId) => {
      const scope = await this.scopes.resolve(tx, companyId, query);

      const rows = await tx.payment.groupBy({
        by: ['method'],
        where: {
          companyId,
          status: 'SUCCEEDED',
          createdAt: { gte: scope.start, lt: scope.end },
          ...(scope.branchIds === null ? {} : { branchId: { in: scope.branchIds } }),
        },
        _count: { _all: true },
        _sum: { amountMinor: true, refundedMinor: true, feeMinor: true },
      });

      return {
        from: scope.fromDate,
        to: scope.toDate,
        timezone: scope.timezone,
        items: rows.map((row) => ({
          method: row.method,
          count: row._count._all,
          collectedMinor: (row._sum.amountMinor ?? 0n).toString(),
          refundedMinor: (row._sum.refundedMinor ?? 0n).toString(),
          feesMinor: (row._sum.feeMinor ?? 0n).toString(),
          netMinor: ((row._sum.amountMinor ?? 0n) - (row._sum.refundedMinor ?? 0n)).toString(),
        })),
        totals: {
          collectedMinor: rows.reduce((s, r) => s + (r._sum.amountMinor ?? 0n), 0n).toString(),
          refundedMinor: rows.reduce((s, r) => s + (r._sum.refundedMinor ?? 0n), 0n).toString(),
          feesMinor: rows.reduce((s, r) => s + (r._sum.feeMinor ?? 0n), 0n).toString(),
        },
      };
    });
  }

  // ---------------------------------------------------------------------------

  private async revenueToday(
    tx: TenantTx,
    companyId: string,
    branchIds: string[] | null,
    start: Date,
    end: Date,
  ) {
    const branch = branchIds === null ? {} : { branchId: { in: branchIds } };
    const [payments, owed] = await Promise.all([
      tx.payment.aggregate({
        where: { companyId, ...branch, status: 'SUCCEEDED', createdAt: { gte: start, lt: end } },
        _sum: { amountMinor: true, refundedMinor: true },
        _count: { _all: true },
      }),
      // Booked but not collected. Excludes cancellations, which are not owed.
      tx.appointment.aggregate({
        where: {
          companyId,
          ...branch,
          status: { notIn: ['CANCELLED', 'EXPIRED', 'NO_SHOW', 'HOLD'] },
          paymentStatus: { in: ['UNPAID', 'PARTIALLY_PAID', 'DEPOSIT_PAID'] },
        },
        _sum: { totalMinor: true, paidMinor: true },
        _count: { _all: true },
      }),
    ]);
    const collected = payments._sum.amountMinor ?? 0n;
    const refunded = payments._sum.refundedMinor ?? 0n;
    const owedTotal = owed._sum.totalMinor ?? 0n;
    const owedPaid = owed._sum.paidMinor ?? 0n;
    return {
      revenue: {
        collectedMinor: collected.toString(),
        refundedMinor: refunded.toString(),
        netMinor: (collected - refunded).toString(),
        paymentCount: payments._count._all,
      },
      outstanding: {
        // Clamped: an overpaid booking must not subtract from what is owed.
        amountMinor: (owedTotal - owedPaid > 0n ? owedTotal - owedPaid : 0n).toString(),
        appointmentCount: owed._count._all,
      },
    };
  }

  private async nameServices(tx: TenantTx, companyId: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const services = await tx.service.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(services.map((s) => [s.id, s.name]));
  }
}

function paymentBranch(scope: ReportScope): Prisma.Sql {
  return scope.branchIds === null
    ? Prisma.empty
    : Prisma.sql`AND p.branch_id = ANY(${scope.branchIds}::uuid[])`;
}
