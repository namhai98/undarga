import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PlatformOnly, RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS, PLATFORM_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess } from '../tenancy/decorators/tenant.decorators';
import {
  cancelSubscriptionSchema,
  changePlanSchema,
  extendSubscriptionSchema,
  invoiceQuerySchema,
  startTrialSchema,
  type CancelSubscriptionDto,
  type ChangePlanDto,
  type ExtendSubscriptionDto,
  type InvoiceQueryDto,
  type StartTrialDto,
} from './dto/subscription.dto';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionsService } from './subscriptions.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * A company's own subscription and billing.
 *
 * Reading needs `settings:billing:read`; changing the plan, cancelling and
 * reactivating need `settings:billing:write`, which by default only the owner
 * holds. None of these routes is marked `@RequiresWrite`: a company whose
 * subscription expired is read-only everywhere else, and these are how it gets
 * back out.
 */
@ApiTags('subscription')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId', version: '1' })
@AllowPlatformAccess()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('subscription')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_READ)
  @ApiOperation({
    summary: 'Current plan, status, trial, usage against limits, and the plans available',
    description:
      'Status is the EFFECTIVE status (a trial that has ended reads EXPIRED even before the ' +
      'nightly sweep). `subscription` is null for a company provisioned before billing existed; ' +
      'such a company is unrestricted until it starts a trial or picks a plan. Usage may be up ' +
      'to a minute old; limits are enforced live when things are created.',
  })
  async get() {
    return this.subscriptions.overview();
  }

  @Post('subscription/start-trial')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_WRITE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the company’s one free trial of a plan' })
  @ApiResponse({ status: 409, description: 'The company already has a subscription.' })
  async startTrial(@Body(new ZodValidationPipe(startTrialSchema)) dto: StartTrialDto) {
    return this.subscriptions.startTrial(dto.planKey);
  }

  @Post('subscription/change-plan')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Move to another plan (or commit to the trial plan)',
    description:
      'Takes effect now and starts a new billing period with an OPEN invoice (none for a free ' +
      'plan). Unpaid invoices for the replaced plan are voided; there is no proration yet. A ' +
      'downgrade below current usage is refused with 403 PLAN_LIMIT_EXCEEDED listing each limit.',
  })
  @ApiResponse({
    status: 403,
    description: 'PLAN_LIMIT_EXCEEDED — current usage exceeds the target plan.',
  })
  @ApiResponse({
    status: 409,
    description: 'Same plan, or a cancelled subscription (reactivate first).',
  })
  async changePlan(@Body(new ZodValidationPipe(changePlanSchema)) dto: ChangePlanDto) {
    return this.subscriptions.changePlan(dto.planKey);
  }

  @Post('subscription/cancel')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel at the end of the current period',
    description:
      'Access continues until the period (or trial) ends; then the company is read-only. No data is deleted.',
  })
  async cancel(@Body(new ZodValidationPipe(cancelSubscriptionSchema)) dto: CancelSubscriptionDto) {
    return this.subscriptions.cancel(dto.reason);
  }

  @Post('subscription/reactivate')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Undo a cancellation, or renew an expired subscription',
    description:
      'Cancelled: back to where it was. Expired: a new period on the same plan, invoiced.',
  })
  async reactivate() {
    return this.subscriptions.reactivate();
  }

  @Get('billing')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_READ)
  @ApiOperation({ summary: 'Billing history: the company’s subscription invoices, newest first' })
  async invoices(@Query(new ZodValidationPipe(invoiceQuerySchema)) query: InvoiceQueryDto) {
    return this.subscriptions.invoices(query);
  }

  @Get('billing/:invoiceId')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_READ)
  @ApiOperation({ summary: 'One invoice' })
  async invoice(@Param('invoiceId', uuidParam) invoiceId: string) {
    return this.subscriptions.invoice(invoiceId);
  }
}

/**
 * Operator-only subscription operations. `platform:billing:manage`, platform
 * tokens only; the route parameter is `:id` so no tenant is ever resolved
 * from it (see PlatformCompaniesController).
 */
@ApiTags('platform')
@Controller({ path: 'platform', version: '1' })
export class PlatformSubscriptionsController {
  constructor(private readonly lifecycle: SubscriptionLifecycleService) {}

  @Post('companies/:id/subscription/extend')
  @PlatformOnly(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Give a company more days (an expired one becomes active for that long)',
  })
  async extend(
    @Param('id', uuidParam) companyId: string,
    @Body(new ZodValidationPipe(extendSubscriptionSchema)) dto: ExtendSubscriptionDto,
  ) {
    return this.lifecycle.extend(companyId, dto.days, dto.reason);
  }

  @Post('companies/:id/billing/:invoiceId/mark-paid')
  @PlatformOnly(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record an invoice as paid outside any payment provider',
    description:
      'The seam a payment provider’s webhook will use. Reactivates a past-due or expired subscription.',
  })
  async markPaid(
    @Param('id', uuidParam) companyId: string,
    @Param('invoiceId', uuidParam) invoiceId: string,
    @Body(
      new ZodValidationPipe(z.object({ reference: z.string().trim().min(3).max(128) }).strict()),
    )
    dto: { reference: string },
  ) {
    return this.lifecycle.markPaid(companyId, invoiceId, dto.reference);
  }

  @Post('subscriptions/sweep')
  @PlatformOnly(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the expiry / renewal sweep now (it also runs on a timer)' })
  async sweep() {
    return this.lifecycle.sweep();
  }
}
