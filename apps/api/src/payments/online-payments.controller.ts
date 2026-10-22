import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../auth/decorators/public.decorator';
import { PlatformOnly, RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS, PLATFORM_PERMISSIONS } from '../authz/permissions';
import { ResourceNotFoundError, TenantNotFoundError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { RequestContextService } from '../tenancy/context/request-context.service';
import {
  AllowPlatformAccess,
  CurrentCompanyId,
  RequiresWrite,
} from '../tenancy/decorators/tenant.decorators';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import type { RequestWithContext } from '../tenancy/guards/request-with-context';
import { MembershipService } from '../tenancy/membership/membership.service';
import {
  createOnlinePaymentSchema,
  payInvoiceSchema,
  platformPaymentQuerySchema,
  platformRefundSchema,
  publicCreatePaymentSchema,
  publicPaymentQuerySchema,
  refundOnlinePaymentSchema,
  simulatePaymentSchema,
  webhookEventQuerySchema,
  type CreateOnlinePaymentDto,
  type PayInvoiceDto,
  type PlatformPaymentQueryDto,
  type PlatformRefundDto,
  type PublicCreatePaymentDto,
  type PublicPaymentQueryDto,
  type RefundOnlinePaymentDto,
  type SimulatePaymentDto,
  type WebhookEventQueryDto,
} from './dto/online-payment.dto';
import { PaymentGateway } from './gateway/payment-gateway';
import { PaymentPlatformRepository } from './payment-platform.repository';
import { PaymentTransactionsService } from './payment-transactions.service';
import { PaymentWebhooksService } from './payment-webhooks.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const slugParam = new ZodValidationPipe(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/));

// =============================================================================
// Tenant: /payments
// =============================================================================

/**
 * Online payments for the active company (the token's company, or
 * `X-Company-Id`; TenantGuard verifies membership either way).
 *
 * A transaction id is only ever looked up inside the caller's company, so
 * another tenant's id is a 404. Appointment payments need `payment:*`, SaaS
 * invoice payments `settings:billing:*` — the service checks which, per row.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
@AllowPlatformAccess()
export class OnlinePaymentsController {
  constructor(
    private readonly transactions: PaymentTransactionsService,
    private readonly webhooks: PaymentWebhooksService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Start an online payment for an appointment',
    description:
      'Creates the payment at the configured provider and returns its checkout (QR, app links ' +
      'or a hosted page) for the customer. The appointment is NOT marked paid here: it is paid ' +
      'when the provider confirms, by webhook or by a server-side status check. ' +
      '`idempotencyKey` is required — a retry returns the same transaction — and only one ' +
      'open payment per appointment exists at a time.',
  })
  @ApiResponse({ status: 201, description: 'PENDING, with `checkout`.' })
  @ApiResponse({ status: 409, description: 'Nothing owed, or a cancelled appointment.' })
  @ApiResponse({ status: 502, description: 'PAYMENT_PROVIDER_ERROR.' })
  @ApiResponse({ status: 503, description: 'PAYMENTS_UNAVAILABLE — no provider configured.' })
  async create(
    @Body(new ZodValidationPipe(createOnlinePaymentSchema)) dto: CreateOnlinePaymentDto,
  ) {
    return this.transactions.createForAppointment(dto);
  }

  @Get(':transactionId')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_READ, COMPANY_PERMISSIONS.BILLING_READ)
  @ApiOperation({
    summary: 'One online payment, and its current status',
    description:
      'An open payment last checked more than 10 seconds ago is first re-checked with the ' +
      'provider, so polling this endpoint is how a client waits for the outcome.',
  })
  async find(@Param('transactionId', uuidParam) transactionId: string) {
    return this.transactions.get(transactionId);
  }

  @Post(':transactionId/refund')
  @HttpCode(200)
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_REFUND)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Refund an appointment’s online payment through its provider',
    description:
      'A separate permission from taking money. The provider is asked first; nothing is ' +
      'recorded as refunded unless it agrees. Some providers (QPay) refund whole payments only. ' +
      'SaaS subscription payments are refunded by the platform, not here.',
  })
  @ApiResponse({ status: 400, description: 'Not settled, or more than is refundable.' })
  @ApiResponse({
    status: 403,
    description: 'PERMISSION_DENIED — including a subscription payment.',
  })
  @ApiResponse({ status: 502, description: 'The provider declined; nothing was refunded.' })
  async refund(
    @Param('transactionId', uuidParam) transactionId: string,
    @Body(new ZodValidationPipe(refundOnlinePaymentSchema)) dto: RefundOnlinePaymentDto,
  ) {
    return this.transactions.refund(transactionId, dto);
  }

  @Post(':transactionId/cancel')
  @HttpCode(200)
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_WRITE, COMPANY_PERMISSIONS.BILLING_WRITE)
  @ApiOperation({
    summary: 'Abandon an unpaid checkout',
    description:
      'Not `@RequiresWrite`: a read-only (expired) company must still be able to manage the ' +
      'payment that would reactivate it. Money that arrives after cancelling is still booked.',
  })
  async cancel(@Param('transactionId', uuidParam) transactionId: string) {
    return this.transactions.cancel(transactionId);
  }

  @Post(':transactionId/simulate')
  @HttpCode(200)
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_WRITE, COMPANY_PERMISSIONS.BILLING_WRITE)
  @ApiOperation({
    summary: 'Development: complete a mock payment',
    description:
      'Only for `PAYMENT_PROVIDER=mock`, which is refused in production. Sends the signed ' +
      'webhook the mock gateway would send, through the real webhook handler.',
  })
  async simulate(
    @Param('transactionId', uuidParam) transactionId: string,
    @Body(new ZodValidationPipe(simulatePaymentSchema)) dto: SimulatePaymentDto,
  ) {
    const companyId = this.context.requireCompanyId('simulate a payment');
    const webhook = await this.transactions.simulateOutcome(companyId, transactionId, dto.outcome);
    await this.webhooks.handle('mock', {
      headers: webhook.headers,
      query: {},
      rawBody: Buffer.from(webhook.rawBody),
      body: JSON.parse(webhook.rawBody) as unknown,
    });
    return this.transactions.get(transactionId);
  }
}

// =============================================================================
// Tenant: paying a SaaS invoice
// =============================================================================

@ApiTags('subscriptions')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId', version: '1' })
export class InvoicePaymentsController {
  constructor(private readonly transactions: PaymentTransactionsService) {}

  @Post('billing/:invoiceId/pay')
  @RequirePermission(COMPANY_PERMISSIONS.BILLING_WRITE)
  @ApiOperation({
    summary: 'Pay a subscription invoice online',
    description:
      'Starts an online payment for what is still owed on an OPEN invoice — a renewal, or the ' +
      'invoice issued on a plan change. When the provider confirms, the invoice is PAID and a ' +
      'past-due or expired subscription is ACTIVE again. Not `@RequiresWrite`: an expired ' +
      'company must be able to pay to recover. A failed attempt is counted on the invoice; ' +
      'the subscription itself moves only as the sweep says (docs/SUBSCRIPTIONS.md).',
  })
  @ApiResponse({ status: 409, description: 'The invoice is not open, or nothing is owed.' })
  async pay(
    @CurrentCompanyId() _companyId: string,
    @Param('invoiceId', uuidParam) invoiceId: string,
    @Body(new ZodValidationPipe(payInvoiceSchema)) dto: PayInvoiceDto,
  ) {
    return this.transactions.createForInvoice(invoiceId, dto.idempotencyKey);
  }
}

// =============================================================================
// Public: the anonymous booker
// =============================================================================

/**
 * The booker pays from the confirmation page. The `paymentToken` issued with
 * the booking is the only way in: signed, expiring, bound to one appointment
 * of one company. No login, and nothing here can read another booking.
 */
@ApiTags('public booking')
@Controller({ path: 'public/companies/:companySlug/payments', version: '1' })
@Public()
export class PublicPaymentsController {
  constructor(
    private readonly transactions: PaymentTransactionsService,
    private readonly webhooks: PaymentWebhooksService,
    private readonly directory: TenantDirectoryService,
    private readonly memberships: MembershipService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Pay for a booking',
    description:
      'The amount is decided by the server — what is owed, or the company’s deposit — never ' +
      'by the request. Returns the checkout and a transaction id to poll.',
  })
  @ApiResponse({ status: 404, description: 'Unknown company, or an invalid or expired token.' })
  async create(
    @Param('companySlug', slugParam) slug: string,
    @Body(new ZodValidationPipe(publicCreatePaymentSchema)) dto: PublicCreatePaymentDto,
  ) {
    return this.inCompany(slug, (companyId) =>
      this.transactions.createPublic(companyId, dto.paymentToken, dto.idempotencyKey),
    );
  }

  @Get(':transactionId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Status of a booking payment (poll this)' })
  async find(
    @Param('companySlug', slugParam) slug: string,
    @Param('transactionId', uuidParam) transactionId: string,
    @Query(new ZodValidationPipe(publicPaymentQuerySchema)) query: PublicPaymentQueryDto,
  ) {
    return this.inCompany(slug, (companyId) =>
      this.transactions.getPublic(companyId, transactionId, query.token),
    );
  }

  @Post(':transactionId/simulate')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Development: complete a mock booking payment (PAYMENT_PROVIDER=mock)' })
  async simulate(
    @Param('companySlug', slugParam) slug: string,
    @Param('transactionId', uuidParam) transactionId: string,
    @Body(new ZodValidationPipe(simulatePaymentSchema)) dto: SimulatePaymentDto,
  ) {
    if (!dto.token) throw new ResourceNotFoundError('PaymentLink');
    return this.inCompany(slug, async (companyId) => {
      const webhook = await this.transactions.simulateOutcome(
        companyId,
        transactionId,
        dto.outcome,
        {
          token: dto.token,
        },
      );
      await this.webhooks.handle('mock', {
        headers: webhook.headers,
        query: {},
        rawBody: Buffer.from(webhook.rawBody),
        body: JSON.parse(webhook.rawBody) as unknown,
      });
      return this.transactions.getPublic(companyId, transactionId, dto.token!);
    });
  }

  /** Same entry as public booking: only a live (ACTIVE) company answers. */
  private async inCompany<T>(slug: string, fn: (companyId: string) => Promise<T>): Promise<T> {
    const companyId = await this.directory.findCompanyIdBySlug(slug);
    if (!companyId) throw new TenantNotFoundError();
    const tenant = await this.memberships.authorizePublic(companyId);
    return this.context.runAsSystem(
      'public-payment',
      tenant,
      () => fn(companyId),
      this.context.requestId,
    );
  }
}

// =============================================================================
// Webhooks
// =============================================================================

/**
 * Provider deliveries. Public — a provider has no token — so every one is
 * verified before anything is read from it (PaymentWebhooksService). The
 * configured provider is also reachable at the bare `/payments/webhook`.
 */
@ApiTags('payments')
@Controller({ path: 'payments/webhook', version: '1' })
@Public()
export class PaymentWebhooksController {
  constructor(
    private readonly webhooks: PaymentWebhooksService,
    private readonly gateway: PaymentGateway,
  ) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: 'Webhook for the configured provider' })
  @ApiResponse({ status: 200, description: 'Accepted (processed, duplicate, or nothing to do).' })
  @ApiResponse({ status: 401, description: 'WEBHOOK_SIGNATURE_INVALID — rejected and recorded.' })
  async receiveDefault(@Req() request: RequestWithContext) {
    return this.webhooks.handle(this.gateway.active().name, toWebhookRequest(request));
  }

  @Post(':provider')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Webhook for a named provider',
    description:
      'Verified, recorded and deduplicated; the payment’s state is then read back from the ' +
      'provider, server to server. Nothing in the body is trusted for state.',
  })
  @ApiResponse({ status: 401, description: 'WEBHOOK_SIGNATURE_INVALID — rejected and recorded.' })
  async receive(@Param('provider') provider: string, @Req() request: RequestWithContext) {
    return this.webhooks.handle(provider, toWebhookRequest(request));
  }

  /** QPay's callback may arrive as a GET; it is verified exactly the same way. */
  @Get(':provider')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: 'Webhook for a named provider (GET callbacks)' })
  async receiveGet(@Param('provider') provider: string, @Req() request: RequestWithContext) {
    return this.webhooks.handle(provider, toWebhookRequest(request));
  }
}

function toWebhookRequest(request: RequestWithContext & { rawBody?: Buffer }) {
  return {
    headers: request.headers,
    query: request.query as Record<string, unknown>,
    rawBody: request.rawBody ?? null,
    body: request.body as unknown,
  };
}

// =============================================================================
// Platform
// =============================================================================

/**
 * The operator's view of online payments, under `platform:billing:manage` —
 * the permission that already governs SaaS billing. Appointment payments are
 * listed by amount and status only; their customers are tenant data, reached
 * (if at all) through the company routes with `platform:company:data:read`.
 */
@ApiTags('platform')
@Controller({ path: 'platform/payments', version: '1' })
export class PlatformPaymentsController {
  constructor(
    private readonly repository: PaymentPlatformRepository,
    private readonly transactions: PaymentTransactionsService,
  ) {}

  @Get()
  @PlatformOnly(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  @ApiOperation({ summary: 'Online payments across every company' })
  async list(
    @Query(new ZodValidationPipe(platformPaymentQuerySchema)) query: PlatformPaymentQueryDto,
  ) {
    return this.repository.listTransactions(query);
  }

  @Get('webhook-events')
  @PlatformOnly(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  @ApiOperation({
    summary: 'Webhook deliveries, for debugging',
    description: 'Including REJECTED ones. Payloads are not returned here.',
  })
  async webhookEvents(
    @Query(new ZodValidationPipe(webhookEventQuerySchema)) query: WebhookEventQueryDto,
  ) {
    return this.repository.listWebhookEvents(query);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @PlatformOnly(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  @ApiOperation({
    summary: 'Refund a SaaS subscription payment',
    description:
      'Whole payments only, through the provider that took it, with a reason on the audit ' +
      'trail. The invoice stays PAID and the subscription is not changed.',
  })
  async refund(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(platformRefundSchema)) dto: PlatformRefundDto,
  ) {
    const found = await this.repository.findTransactionCompany(id);
    if (!found) throw new ResourceNotFoundError('PaymentTransaction', id);
    return this.transactions.refundSubscription(found.companyId, id, dto.reason);
  }
}
