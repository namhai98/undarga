import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequireAllPermissions, RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { RequireFeature } from '../subscriptions/feature.guard';
import { PromotionsService } from './promotions.service';
import {
  applyPromotionSchema,
  createPromotionSchema,
  promotionQuerySchema,
  quotePromotionSchema,
  updatePromotionSchema,
  validatePromotionSchema,
  type ApplyPromotionDto,
  type CreatePromotionDto,
  type PromotionQueryDto,
  type QuotePromotionDto,
  type UpdatePromotionDto,
  type ValidatePromotionDto,
} from './dto/promotion.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Discounts.
 *
 * ---------------------------------------------------------------------------
 * QUOTE THEN APPLY
 * ---------------------------------------------------------------------------
 *
 * `POST /quote` prices a promotion without committing it; `POST /apply` writes
 * the redemption and moves the appointment total. They share one evaluator, so
 * the number shown on the till screen is the number that gets charged — two
 * implementations of "20% off" is how a customer is quoted one price and
 * charged another.
 *
 * `quote` with no `promotionId` evaluates every auto-apply promotion and
 * returns the best one, which is what "automatic discount" means at a till.
 *
 * ---------------------------------------------------------------------------
 * DISCOUNTS ARE COMPUTED SERVER-SIDE, FULL STOP
 * ---------------------------------------------------------------------------
 *
 * No endpoint accepts a discount amount. The client names a promotion; the
 * server decides what it is worth. Percentages are basis points and the maths
 * is BigInt, so a total can never be pushed below zero by a rounding artefact.
 */
@ApiTags('promotions')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/promotions', version: '1' })
@RequireFeature('PROMOTIONS')
@AllowPlatformAccess()
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_READ)
  @ApiOperation({
    summary: 'List promotions',
    description: '`activeNow=true` narrows to what a till could actually use right now.',
  })
  async list(@Query(new ZodValidationPipe(promotionQuerySchema)) query: PromotionQueryDto) {
    return this.promotions.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a promotion',
    description:
      'Percentages are BASIS POINTS — 15% is 1500, never 0.15. Targeting by service, branch ' +
      'or employee is optional; an empty list means "anything". `FREE_SERVICE` is refused: it ' +
      'cannot be priced without recording which service is free, and the schema has nowhere ' +
      'to put that.',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — the shape must match the type.' })
  async create(@Body(new ZodValidationPipe(createPromotionSchema)) dto: CreatePromotionDto) {
    return this.promotions.create(dto);
  }

  @Post('quote')
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_READ)
  @HttpCode(200)
  @ApiOperation({
    summary: 'What would this take off?',
    description:
      'Prices a promotion against an appointment, or against a hypothetical `subtotalMinor` ' +
      'before one exists. Commits nothing. Omit `promotionId` to get the best automatic ' +
      'discount. An ineligible promotion returns `applicable: false` with a reason a customer ' +
      'can be shown, rather than an error.',
  })
  async quote(@Body(new ZodValidationPipe(quotePromotionSchema)) dto: QuotePromotionDto) {
    return this.promotions.quote(dto);
  }

  @Post('validate')
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_READ, COMPANY_PERMISSIONS.APPOINTMENT_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check a promotion code against a booking before it is made',
    description:
      'Send only ids and the code — never a price. The server prices the service (service, ' +
      'branch and employee overrides, the same rule the booking uses), checks every id against ' +
      'this company, and evaluates every rule: status, dates, usage limits, code limits, ' +
      'minimum spend, and service / branch / employee targeting. Returns `originalMinor`, ' +
      '`discountMinor` and `finalMinor` (never below zero). An unusable code answers 200 with ' +
      '`valid: false` and a `reason` a customer can be shown. Commits nothing — the booking ' +
      're-validates and consumes the usage atomically.',
  })
  @ApiResponse({ status: 200, description: 'The preview, valid or not.' })
  @ApiResponse({ status: 404, description: 'The branch, service, employee or customer is not in this company.' })
  async validate(@Body(new ZodValidationPipe(validatePromotionSchema)) dto: ValidatePromotionDto) {
    return this.promotions.validateCode(dto);
  }

  @Post('apply')
  // It rewrites an appointment's total, so it needs the right to edit
  // appointments — reading promotions alone is not enough.
  @RequireAllPermissions(COMPANY_PERMISSIONS.PROMOTION_READ, COMPANY_PERMISSIONS.APPOINTMENT_WRITE)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Commit a promotion to an appointment',
    description:
      'By `promotionId` or by `code` (a code-only promotion needs its code). One transaction: ' +
      'consumes the promotion and code usage counters with conditional UPDATEs, writes the ' +
      'redemption with a per-line allocation, records a booking-time snapshot on the items, ' +
      'and moves the appointment discount and total.',
  })
  @ApiResponse({ status: 409, description: 'CONFLICT — already applied, or the limit is reached.' })
  async apply(@Body(new ZodValidationPipe(applyPromotionSchema)) dto: ApplyPromotionDto) {
    return this.promotions.apply(dto);
  }

  @Get(':promotionId')
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_READ)
  @ApiOperation({ summary: 'One promotion, with its targeting and redemption count' })
  async find(@Param('promotionId', uuidParam) promotionId: string) {
    return this.promotions.findById(promotionId);
  }

  @Patch(':promotionId')
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update a promotion',
    description:
      'Supplying a targeting list replaces it wholesale — who a promotion applies to is read ' +
      'as a set, and patching members individually would leave it half-configured between two ' +
      'calls.',
  })
  async update(
    @Param('promotionId', uuidParam) promotionId: string,
    @Body(new ZodValidationPipe(updatePromotionSchema)) dto: UpdatePromotionDto,
  ) {
    return this.promotions.update(promotionId, dto);
  }

  @Delete(':promotionId')
  @RequirePermission(COMPANY_PERMISSIONS.PROMOTION_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Archive a promotion',
    description:
      'Soft delete. Redemptions reference it, and a receipt that cannot name the discount it ' +
      'applied is a receipt nobody can audit.',
  })
  async remove(@Param('promotionId', uuidParam) promotionId: string): Promise<void> {
    await this.promotions.remove(promotionId);
  }
}
