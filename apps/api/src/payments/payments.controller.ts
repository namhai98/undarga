import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { PaymentsService } from './payments.service';
import {
  createPaymentSchema,
  paymentQuerySchema,
  refundPaymentSchema,
  type CreatePaymentDto,
  type PaymentQueryDto,
  type RefundPaymentDto,
} from './dto/payment.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Money in and money back out.
 *
 * ---------------------------------------------------------------------------
 * METHOD, PURPOSE, AMOUNT AND DIRECTION ARE FOUR DIFFERENT THINGS
 * ---------------------------------------------------------------------------
 *
 * The brief lists CASH, CARD, BANK, ONLINE, GIFT_CARD, DEPOSIT, PARTIAL and
 * REFUND as if they were one enum. They are four:
 *
 *   `method`    how the money moved      CASH · CARD · BANK_TRANSFER · ONLINE · GIFT_CARD
 *   `purpose`   what it was for          BOOKING · DEPOSIT · BALANCE · NO_SHOW_FEE · TIP
 *   PARTIAL     a property of the amount any payment smaller than the balance
 *   REFUND      the opposite direction   its own table and its own endpoint
 *
 * A deposit paid in cash is `method: CASH, purpose: DEPOSIT`. Collapsing that
 * into `method: DEPOSIT` loses the fact that it was cash — and the end-of-day
 * drawer count is exactly that fact.
 *
 * ---------------------------------------------------------------------------
 * PARTIAL PAYMENT NEEDS NO SPECIAL ENDPOINT
 * ---------------------------------------------------------------------------
 *
 * Pay less than the balance and the appointment becomes `PARTIALLY_PAID`. Pay
 * the rest later, in a different method if you like, and it becomes `PAID`.
 * `GET /appointments/:id/balance` recomputes what is left FROM THE PAYMENTS
 * rather than from a cached column, so the number is checkable.
 *
 * ---------------------------------------------------------------------------
 * NO REAL GATEWAY
 * ---------------------------------------------------------------------------
 *
 * `ONLINE` is served by a deterministic mock: an amount whose minor units end
 * in 13 declines, `metadata.simulate: "pending"` stays pending. Real gateways
 * implement `PaymentProvider` and slot into the registry.
 */
@ApiTags('payments')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId', version: '1' })
@AllowPlatformAccess()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_READ)
  @ApiOperation({
    summary: 'List payments',
    description:
      'Filterable by appointment, customer, branch, method, status and date range. The ' +
      'response carries a `summary` with collected, refunded and net totals for the WHOLE ' +
      'filter, not just the page — that is the number the person on this screen wants.',
  })
  async list(@Query(new ZodValidationPipe(paymentQuerySchema)) query: PaymentQueryDto) {
    return this.payments.list(query);
  }

  @Post('payments')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Take a payment',
    description:
      'One transaction covers the payment row, any gift-card redemption, the double-entry ' +
      'ledger and the appointment’s paid total. Send an `idempotencyKey` from any client that ' +
      'can retry: the column is globally unique, so a double-submitted checkout returns the ' +
      'existing payment instead of charging twice.',
  })
  @ApiResponse({ status: 201, description: 'Recorded. Check `status` — ONLINE may be PENDING.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — including an unusable gift card.' })
  @ApiResponse({ status: 404, description: 'The appointment, customer or branch is not yours.' })
  async create(@Body(new ZodValidationPipe(createPaymentSchema)) dto: CreatePaymentDto) {
    return this.payments.create(dto);
  }

  @Get('payments/:paymentId')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_READ)
  @ApiOperation({ summary: 'One payment, with its refunds' })
  async find(@Param('paymentId', uuidParam) paymentId: string) {
    return this.payments.findById(paymentId);
  }

  @Post('payments/:paymentId/refund')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_REFUND)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Refund a payment, in whole or in part',
    description:
      'A separate permission from taking money — the person at the till and the person who ' +
      'can hand it back are usually different people. Omit `amountMinor` to refund everything ' +
      'still refundable. `destination: GIFT_CARD` credits stored value instead of moving cash, ' +
      'and is the only way to reverse a gift-card payment.',
  })
  @ApiResponse({ status: 400, description: 'More than is left, or the payment never settled.' })
  async refund(
    @Param('paymentId', uuidParam) paymentId: string,
    @Body(new ZodValidationPipe(refundPaymentSchema)) dto: RefundPaymentDto,
  ) {
    return this.payments.refund(paymentId, dto);
  }

  @Get('appointments/:appointmentId/balance')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_READ)
  @ApiOperation({
    summary: 'What is still owed on an appointment',
    description:
      'Recomputed from the payments table rather than read from the appointment’s cached ' +
      '`paidMinor` — the cache is what this endpoint exists to double-check. Overpayment ' +
      'reports an outstanding balance of zero, never a negative one.',
  })
  async balance(@Param('appointmentId', uuidParam) appointmentId: string) {
    return this.payments.appointmentBalance(appointmentId);
  }
}
