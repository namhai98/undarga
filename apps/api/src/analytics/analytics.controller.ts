import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess } from '../tenancy/decorators/tenant.decorators';
import { AnalyticsService } from './analytics.service';
import { ReportsService } from './reports.service';
import {
  dashboardQuerySchema,
  reportQuerySchema,
  type DashboardQueryDto,
  type ReportQueryDto,
} from './dto/analytics.dto';

const dashboardQuery = new ZodValidationPipe(dashboardQuerySchema);
const reportQuery = new ZodValidationPipe(reportQuerySchema);

const FILTERS =
  'Filters: `from`/`to` (YYYY-MM-DD, inclusive, in the company’s timezone, at most a year), ' +
  '`branchId`, `employeeId`, `serviceId`, `status` (comma-separated), `limit`/`offset` for the ' +
  'breakdown tables. Ids from another company are 404; a branch outside the caller’s branch ' +
  'scope is 404, and with no branch named a branch-confined caller sees only their branches. ' +
  'Money fields are null unless the caller holds `report:revenue:read` (`amountsVisible`).';

/**
 * Numbers about the business.
 *
 * ---------------------------------------------------------------------------
 * TWO PERMISSIONS
 * ---------------------------------------------------------------------------
 *
 * `report:read` covers volume — appointments, customers, services, promotion
 * use, gift-card activity — and opens the dashboard. `report:revenue:read`
 * adds the money: amounts on the same screens, plus the revenue and
 * payment-method reports. A branch manager is routinely given the first and
 * not the second; the dashboard then says which figures it is withholding.
 *
 * Every figure is aggregated in PostgreSQL. No endpoint returns a customer's
 * name or contact details.
 */
@ApiTags('analytics')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId', version: '1' })
@AllowPlatformAccess()
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly reports: ReportsService,
  ) {}

  @Get('dashboard')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'The morning screen',
    description:
      'Today (in the company’s timezone): appointments by status, completed, cancelled, no-show; ' +
      'upcoming in the next 7 days; new customers; popular services, promotion use and gift-card ' +
      'activity over the last `popularWindowDays` (30). Revenue, outstanding and every amount are ' +
      'included only with `report:revenue:read`; `restricted` lists what was withheld.',
  })
  @ApiResponse({
    status: 404,
    description: 'A branch outside this company or the caller’s branch scope.',
  })
  async dashboard(@Query(dashboardQuery) query: DashboardQueryDto) {
    return this.analytics.dashboard(query);
  }

  @Get('reports/appointments')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'Appointments: totals, by day, by service, by employee, by branch',
    description: `Totals by status with completion / cancellation / no-show rates (basis points). ${FILTERS}`,
  })
  async appointments(@Query(reportQuery) query: ReportQueryDto) {
    return this.reports.appointments(query);
  }

  @Get('reports/customers')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'Customers: new by day, active, returning, growth',
    description:
      'Counts only — never names or contact details. With appointment filters, “new” means ' +
      `created in the range and booked in it matching the filters. ${FILTERS}`,
  })
  async customers(@Query(reportQuery) query: ReportQueryDto) {
    return this.reports.customers(query);
  }

  @Get('reports/services')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'Services: most booked, booking count, trends',
    description: `Grouped on appointment LINE ITEMS. The trend covers the top five services of the range. ${FILTERS}`,
  })
  async services(@Query(reportQuery) query: ReportQueryDto) {
    return this.reports.services(query);
  }

  @Get('reports/promotions')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'Promotions: usage, discount given, usage by promotion',
    description: `By redemption date; other filters apply through the redeemed appointment. ${FILTERS}`,
  })
  async promotions(@Query(reportQuery) query: ReportQueryDto) {
    return this.reports.promotions(query);
  }

  @Get('reports/gift-cards')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'Gift cards: issued, active/expired, balances, redemption activity',
    description:
      'Card inventory is company-wide and omitted for branch-confined callers; redemption ' +
      'activity follows the branch filter through the redeemed appointment. Employee, service ' +
      `and status filters do not apply (see \`appliedFilters\`). ${FILTERS}`,
  })
  async giftCards(@Query(reportQuery) query: ReportQueryDto) {
    return this.reports.giftCards(query);
  }

  @Get('reports/revenue')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_REVENUE_READ)
  @ApiOperation({ summary: 'Revenue by day, net of refunds (settled payments)' })
  async revenue(@Query(reportQuery) query: ReportQueryDto) {
    return this.analytics.revenueByDate(query);
  }

  @Get('reports/payment-methods')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_REVENUE_READ)
  @ApiOperation({
    summary: 'What people paid with',
    description:
      'The end-of-day reconciliation sheet: per method, collected, refunded, fees and net.',
  })
  async paymentMethods(@Query(reportQuery) query: ReportQueryDto) {
    return this.analytics.paymentMethodSummary(query);
  }
}
