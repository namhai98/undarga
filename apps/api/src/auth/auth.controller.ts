import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionRevokedError, UnauthenticatedError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { isCompanyUser, isPlatformUser, type Actor } from '../tenancy/context/context.types';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public, Realm } from './decorators/public.decorator';
import { SessionCookieService } from './session-cookie.service';
import {
  loginSchema,
  switchCompanySchema,
  type LoginDto,
  type SwitchCompanyDto,
} from './dto/auth.dto';
import type { AuthenticatedSession } from './auth.service';

/**
 * Identity endpoints.
 *
 * All of them carry `@NoTenant()`: they are about *which* company you may
 * enter, so by definition they run before one is chosen. This is the only place
 * in the codebase where that opt-out is the normal case rather than the
 * exception.
 */
@Controller({ path: 'auth', version: '1' })
@NoTenant()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: SessionCookieService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.loginStaff(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return this.issue(res, session);
  }

  /**
   * Mint a new access token from the refresh cookie.
   *
   * Public because the access token is, by definition, expired by the time
   * anyone calls this. The refresh cookie is the credential, and the browser
   * supplies it — the request body is ignored entirely.
   */
  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = this.cookies.read(req);

    if (!refreshToken) {
      // No cookie means no session to refresh. Same error as a revoked one:
      // there is nothing to distinguish for a caller who holds neither.
      throw new SessionRevokedError();
    }

    const session = await this.auth.refreshStaff(refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return this.issue(res, session);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() actor: Actor | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    // Clear the cookie before the authentication check. A caller whose access
    // token has already expired still wants the browser to stop holding a
    // refresh token, and leaving it in place would make "sign out" quietly
    // depend on how recently you had signed in.
    this.cookies.clear(res);

    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
    await this.auth.logoutStaff(actor.sessionId);
  }

  /**
   * Move the refresh token out of the response body and into the cookie.
   *
   * Every path that mints a session goes through here, so there is one place
   * to check that the long-lived credential never reaches JavaScript.
   */
  private issue(res: Response, session: AuthenticatedSession) {
    const { refreshToken, ...body } = session;
    this.cookies.set(res, refreshToken);
    return body;
  }

  /**
   * Everything the signed-in user may reach, and which company they are
   * currently in.
   *
   * Tenant-less on purpose: this is the endpoint a client calls to *decide*
   * which company to work in.
   */
  @Get('me')
  async me(@CurrentUser() actor: Actor | null) {
    if (!actor) throw new UnauthenticatedError();

    if (isPlatformUser(actor)) {
      return {
        realm: 'platform' as const,
        id: actor.platformUserId,
        email: actor.email,
        displayName: actor.displayName,
        platformPermissions: [...actor.platformPermissions],
        impersonation: actor.impersonation ?? null,
      };
    }

    if (!isCompanyUser(actor)) throw new UnauthenticatedError();

    return {
      realm: 'staff' as const,
      id: actor.userAccountId,
      email: actor.email,
      displayName: actor.displayName,
      memberships: await this.auth.listMemberships(actor.userAccountId),
    };
  }

  /**
   * Change the active company.
   *
   * Issues a brand-new token pair and retires the old session, so a token is
   * only ever valid for one company. Membership is verified here as well as in
   * TenantGuard — this endpoint's whole job is to change the tenant, so it
   * should not lean on a downstream guard for correctness.
   */
  @Post('switch-company')
  @HttpCode(200)
  async switchCompany(
    @Body(new ZodValidationPipe(switchCompanySchema)) dto: SwitchCompanyDto,
    @CurrentUser() actor: Actor | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();

    const session = await this.auth.switchCompany(
      actor.userAccountId,
      actor.sessionId,
      dto.companyId,
    );

    // The old session was retired, so the old refresh cookie is dead. Replacing
    // it here is what keeps a reload after a switch landing in the new company
    // rather than signing the user out.
    return this.issue(res, session);
  }
}

/**
 * The platform realm gets its own controller and its own token audience. A
 * staff token cannot reach these routes and a platform token cannot reach the
 * staff ones — the separation is enforced at the audience check, before any
 * permission is consulted.
 */
@Controller({ path: 'platform/auth', version: '1' })
@NoTenant()
@Realm('platform')
export class PlatformAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto, @Req() req: Request) {
    return this.auth.loginPlatform(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() actor: Actor | null): Promise<void> {
    if (!actor || !isPlatformUser(actor)) throw new UnauthenticatedError();
    await this.auth.logoutPlatform(actor.sessionId);
  }
}
