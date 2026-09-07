import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UnauthenticatedError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { isCompanyUser, type Actor } from '../tenancy/context/context.types';
import { AccountService } from './account.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { SessionCookieService } from './session-cookie.service';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  requestEmailVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type ChangePasswordDto,
  type ForgotPasswordDto,
  type RequestEmailVerificationDto,
  type ResetPasswordDto,
  type VerifyEmailDto,
} from './dto/account.dto';

/**
 * The same answer whether or not the account exists.
 *
 * Returned by both `forgot-password` and `resend-verification`. Deliberately
 * phrased in the conditional: it is true either way, and it gives an attacker
 * enumerating addresses nothing to sort on.
 */
const NEUTRAL_ACKNOWLEDGEMENT = {
  message: 'If an account exists for that address, we have sent a link to it.',
};

/**
 * Account lifecycle: verifying an address, recovering a forgotten password,
 * changing a known one, ending sessions.
 *
 * ---------------------------------------------------------------------------
 * ALL TOKENS TRAVEL IN THE BODY
 * ---------------------------------------------------------------------------
 *
 * Never `POST /reset-password/{token}`. A URL is the least private part of a
 * request: it is written to access logs, proxy logs, browser history and the
 * `Referer` header of every subsequent request from the page. A credential that
 * takes over an account should not be recorded in four places on the way in.
 *
 * The link a user clicks is a FRONTEND url carrying `?token=…`, which the web
 * app reads and posts here.
 *
 * ---------------------------------------------------------------------------
 * RATE LIMITS
 * ---------------------------------------------------------------------------
 *
 * Every route here is throttled, and the numbers are deliberately low. These
 * are the endpoints that send mail to an address the caller chose, so an
 * unthrottled one is a spam cannon aimed at strangers, and the ones that accept
 * a token are the endpoints worth guessing at.
 *
 * The limiter is per-IP and per-replica (in-memory storage). AccountService
 * applies a second, per-ACCOUNT ceiling, because an attacker with many IPs
 * defeats the first and not the second.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
@NoTenant()
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly cookies: SessionCookieService,
  ) {}

  // ---------------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------------

  @Post('resend-verification')
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send a fresh email-verification link',
    description:
      'Always answers 202 with the same body, whether or not the address has an account — ' +
      'otherwise this endpoint is an account-enumeration oracle.',
  })
  @ApiResponse({ status: 202, description: 'Acknowledged. Reveals nothing about the account.' })
  @ApiResponse({ status: 429, description: 'Rate limited.' })
  async resendVerification(
    @Body(new ZodValidationPipe(requestEmailVerificationSchema))
    dto: RequestEmailVerificationDto,
  ) {
    await this.account.requestEmailVerification(dto.email);
    return NEUTRAL_ACKNOWLEDGEMENT;
  }

  @Post('verify-email')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confirm an email address',
    description:
      'Consumes the token. Unlike the request side this DOES report failure: the caller holds ' +
      'a token rather than guessing an address, so there is nothing to enumerate.',
  })
  @ApiResponse({ status: 200, description: 'Verified.' })
  @ApiResponse({ status: 400, description: 'ACCOUNT_TOKEN_INVALID — unknown or already used.' })
  @ApiResponse({ status: 410, description: 'ACCOUNT_TOKEN_EXPIRED.' })
  async verifyEmail(@Body(new ZodValidationPipe(verifyEmailSchema)) dto: VerifyEmailDto) {
    return this.account.verifyEmail(dto.token);
  }

  // ---------------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------------

  @Post('forgot-password')
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a password-reset link',
    description:
      'Always answers 202 with the same body. An endpoint that answered differently for a ' +
      'known address would hand an attacker the exact input list for credential stuffing.',
  })
  @ApiResponse({ status: 202, description: 'Acknowledged. Reveals nothing about the account.' })
  @ApiResponse({ status: 429, description: 'Rate limited.' })
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) dto: ForgotPasswordDto,
  ) {
    await this.account.requestPasswordReset(dto.email);
    return NEUTRAL_ACKNOWLEDGEMENT;
  }

  @Post('reset-password')
  @Public()
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Set a new password from a reset link',
    description:
      'Consumes the token and revokes EVERY session for the account, including any an ' +
      'attacker holds — resetting the credential while leaving its sessions alive would ' +
      'defeat the point. The user signs in again afterwards.',
  })
  @ApiResponse({ status: 204, description: 'Password changed; all sessions revoked.' })
  @ApiResponse({ status: 400, description: 'ACCOUNT_TOKEN_INVALID, or the password is too short.' })
  @ApiResponse({ status: 410, description: 'ACCOUNT_TOKEN_EXPIRED.' })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto,
  ): Promise<void> {
    await this.account.resetPassword(dto.token, dto.newPassword);
  }

  // ---------------------------------------------------------------------------
  // Authenticated
  // ---------------------------------------------------------------------------

  @Post('change-password')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Requires the current password even though you are already authenticated: a token left ' +
      'open on a shared machine must not be enough to lock the owner out. Revokes your other ' +
      'sessions and keeps this one.',
  })
  @ApiResponse({ status: 204, description: 'Changed; other sessions revoked.' })
  @ApiResponse({ status: 401, description: 'INVALID_CREDENTIALS — the current password is wrong.' })
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
    @CurrentUser() actor: Actor | null,
  ): Promise<void> {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();

    await this.account.changePassword(
      actor.userAccountId,
      actor.sessionId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @Post('logout-all')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign out on every device',
    description:
      'Revokes every session for your own account, including the one making the request. ' +
      'Needs no permission — it acts only on the caller, and requiring one would mean a ' +
      'user who suspects a compromise cannot end it.',
  })
  @ApiResponse({ status: 200, description: 'Returns how many sessions were revoked.' })
  async logoutAll(
    @CurrentUser() actor: Actor | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();

    const result = await this.account.logoutEverywhere(actor.userAccountId);

    // This session was revoked along with the rest, so the refresh cookie in
    // this browser is now pointing at a dead session. Leaving it would mean the
    // next page load attempts a refresh that is guaranteed to fail.
    this.cookies.clear(res);

    return result;
  }
}
