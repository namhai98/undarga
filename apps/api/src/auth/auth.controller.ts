import { Body, Controller, Get, HttpCode, Post, Req, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthenticatedError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { isCompanyUser, isPlatformUser, type Actor } from '../tenancy/context/context.types';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public, Realm } from './decorators/public.decorator';
import {
  loginSchema,
  refreshSchema,
  switchCompanySchema,
  type LoginDto,
  type RefreshDto,
  type SwitchCompanyDto,
} from './dto/auth.dto';

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
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.loginStaff(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(refreshSchema))
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refreshStaff(dto.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() actor: Actor | null): Promise<void> {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
    await this.auth.logoutStaff(actor.sessionId);
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
  @UsePipes(new ZodValidationPipe(switchCompanySchema))
  async switchCompany(@Body() dto: SwitchCompanyDto, @CurrentUser() actor: Actor | null) {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
    return this.auth.switchCompany(actor.userAccountId, actor.sessionId, dto.companyId);
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
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(@Body() dto: LoginDto, @Req() req: Request) {
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
