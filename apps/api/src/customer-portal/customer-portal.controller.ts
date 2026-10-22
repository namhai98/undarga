import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public, Realm } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { readCookie } from '../auth/session-cookie.service';
import { UnauthenticatedError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { AppConfig } from '../config';
import { isCustomerActor, type Actor } from '../tenancy/context/context.types';
import { NoTenant, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { CustomerAuthService, type CustomerSessionTokens } from './customer-auth.service';
import { CustomerPortalService } from './customer-portal.service';
import {
  appointmentListSchema,
  customerCancelSchema,
  customerRescheduleSchema,
  pageSchema,
  requestCodeSchema,
  rescheduleOptionsSchema,
  updateProfileSchema,
  verifyCodeSchema,
  type AppointmentListDto,
  type CustomerCancelDto,
  type CustomerRescheduleDto,
  type PageDto,
  type RequestCodeDto,
  type RescheduleOptionsDto,
  type UpdateProfileDto,
  type VerifyCodeDto,
} from './dto/customer-portal.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const slugParam = new ZodValidationPipe(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/));

const REFRESH_COOKIE = 'undarga_crt';

// =============================================================================
// Sign-in
// =============================================================================

/**
 * Customer sign-in, per company: `/customer/auth/:companySlug/…`.
 *
 * The refresh cookie is HttpOnly and scoped to that path, so a browser can be
 * signed in to two businesses' portals at once without either overwriting the
 * other, and the cookie is never sent anywhere else.
 */
@ApiTags('customer portal')
@ApiParam({ name: 'companySlug', description: 'The business, as in its public booking link.' })
@Controller({ path: 'customer/auth/:companySlug', version: '1' })
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly config: AppConfig,
  ) {}

  @Post('request-code')
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Email a sign-in code',
    description:
      'Sends a 6-digit code to this address if the business has a customer with it. The ' +
      'answer is the same either way, so the endpoint cannot be used to find out who is a ' +
      'customer. Codes expire in 10 minutes; a new one voids the last.',
  })
  @ApiResponse({ status: 202, description: '`{ sent: true, expiresInSeconds }` — always.' })
  @ApiResponse({ status: 404, description: 'No live business with that slug.' })
  async requestCode(
    @Param('companySlug', slugParam) slug: string,
    @Body(new ZodValidationPipe(requestCodeSchema)) dto: RequestCodeDto,
  ) {
    return this.auth.requestCode(slug, dto.email);
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Exchange the code for a session',
    description:
      'Returns a customer access token (refused by every staff and platform route) and sets ' +
      'the refresh cookie. Five wrong guesses burn the code.',
  })
  @ApiResponse({ status: 401, description: 'SIGN_IN_CODE_INVALID — wrong, expired or used up.' })
  async verify(
    @Param('companySlug', slugParam) slug: string,
    @Body(new ZodValidationPipe(verifyCodeSchema)) dto: VerifyCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.verify(slug, dto.email, dto.code, meta(req));
    return this.respond(res, slug, tokens);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rotate the session',
    description: 'Reads the refresh cookie. A token used twice revokes the whole session family.',
  })
  @ApiResponse({ status: 401, description: 'No session, expired, or REFRESH_TOKEN_REUSED.' })
  async refresh(
    @Param('companySlug', slugParam) slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const tokens = await this.auth.refresh(slug, readCookie(req, REFRESH_COOKIE), meta(req));
      return this.respond(res, slug, tokens);
    } catch (error) {
      this.clear(res, slug);
      throw error;
    }
  }

  @Post('logout')
  @Realm('customer')
  @NoTenant()
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out: this session ends now, not when its token expires' })
  async logout(
    @Param('companySlug', slugParam) slug: string,
    @CurrentUser() actor: Actor | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!actor || !isCustomerActor(actor)) throw new UnauthenticatedError();
    await this.auth.logout(actor);
    this.clear(res, slug);
  }

  // ---------------------------------------------------------------------------

  private respond(res: Response, slug: string, tokens: CustomerSessionTokens) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.app.isProduction,
      path: this.cookiePath(slug),
      maxAge: this.config.auth.refreshTokenTtlDays * 86_400_000,
    });
    // The refresh token travels only in the cookie.
    return {
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      expiresIn: tokens.expiresIn,
    };
  }

  private clear(res: Response, slug: string) {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.app.isProduction,
      path: this.cookiePath(slug),
    });
  }

  private cookiePath(slug: string) {
    return `/${this.config.app.apiPrefix}/v1/customer/auth/${slug}`;
  }
}

function meta(req: Request) {
  return {
    ipAddress: req.ip,
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  };
}

// =============================================================================
// The portal
// =============================================================================

/**
 * `/customer/…` — customer tokens only (`@Realm('customer')`); staff and
 * operator tokens are refused at the audience check. The company is the
 * token's own (TenantGuard verifies it is live); the customer is the token's
 * own. Nothing in a path or body selects either.
 */
@ApiTags('customer portal')
@Controller({ path: 'customer', version: '1' })
@Realm('customer')
export class CustomerPortalController {
  constructor(private readonly portal: CustomerPortalService) {}

  @Get('me')
  @ApiOperation({ summary: 'My profile at this business' })
  @ApiResponse({
    status: 401,
    description: 'Not signed in, another realm, or the record was blocked or removed.',
  })
  async me() {
    return this.portal.profile();
  }

  @Patch('me')
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update my name, phone or language',
    description: 'Email is the sign-in address and is changed by the business, not here.',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — including unknown fields.' })
  @ApiResponse({
    status: 409,
    description: 'CONFLICT — that phone belongs to another customer here.',
  })
  async updateMe(@Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto) {
    return this.portal.updateProfile(dto);
  }

  @Get('appointments')
  @ApiOperation({
    summary: 'My appointments: upcoming, past or cancelled',
    description: 'Paginated.',
  })
  async appointments(
    @Query(new ZodValidationPipe(appointmentListSchema)) query: AppointmentListDto,
  ) {
    return this.portal.listAppointments(query);
  }

  @Get('appointments/:appointmentId')
  @ApiOperation({
    summary: 'One of my appointments',
    description:
      'Service, branch, staff member, time, price and discounts, payment summary — and ' +
      '`actions`: whether it can be cancelled or rescheduled online, and if not, why.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not found — including another customer’s appointment.',
  })
  async appointment(@Param('appointmentId', uuidParam) appointmentId: string) {
    return this.portal.appointment(appointmentId);
  }

  @Post('appointments/:appointmentId/cancel')
  @HttpCode(200)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Cancel my appointment',
    description:
      'Allowed only while the business permits online cancellation, before its deadline ' +
      '(cancellation window), and while no online payment is in flight. Refunds of anything ' +
      'already paid are handled by the business.',
  })
  @ApiResponse({
    status: 409,
    description: 'CUSTOMER_ACTION_NOT_ALLOWED — `details.reason` says why.',
  })
  async cancel(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(customerCancelSchema)) dto: CustomerCancelDto,
  ) {
    return this.portal.cancel(appointmentId, dto);
  }

  @Get('appointments/:appointmentId/reschedule-options')
  @ApiOperation({
    summary: 'Times this appointment can move to, on one day',
    description: 'As public booking offers them: same service, branch and staff member.',
  })
  async rescheduleOptions(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Query(new ZodValidationPipe(rescheduleOptionsSchema)) query: RescheduleOptionsDto,
  ) {
    return this.portal.rescheduleOptions(appointmentId, query.date);
  }

  @Post('appointments/:appointmentId/reschedule')
  @HttpCode(200)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Move my appointment to another time',
    description:
      'The same rules as cancelling, plus: a paid booking is moved by the business. The new ' +
      'time must be one public booking offers; the existing engine re-checks it under lock.',
  })
  @ApiResponse({
    status: 409,
    description: 'CUSTOMER_ACTION_NOT_ALLOWED, or SLOT_UNAVAILABLE / SLOT_TAKEN.',
  })
  async reschedule(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(customerRescheduleSchema)) dto: CustomerRescheduleDto,
  ) {
    return this.portal.reschedule(appointmentId, dto);
  }

  @Get('payments')
  @ApiOperation({
    summary: 'My payments',
    description: 'Amounts, methods, statuses and refunds. No provider references or fees.',
  })
  async payments(@Query(new ZodValidationPipe(pageSchema)) query: PageDto) {
    return this.portal.payments(query);
  }

  @Get('gift-cards')
  @ApiOperation({
    summary: 'My gift cards',
    description:
      'Cards I hold (with balance) and cards I bought for someone else (without their balance). ' +
      'Only the last four characters of a code are ever shown.',
  })
  async giftCards() {
    return this.portal.giftCards();
  }

  @Get('gift-cards/:giftCardId/transactions')
  @ApiOperation({ summary: 'A gift card’s history — for the card’s holder only' })
  @ApiResponse({ status: 404, description: 'Not found — including a card held by someone else.' })
  async giftCardTransactions(
    @Param('giftCardId', uuidParam) giftCardId: string,
    @Query(new ZodValidationPipe(pageSchema)) query: PageDto,
  ) {
    return this.portal.giftCardTransactions(giftCardId, query);
  }
}
