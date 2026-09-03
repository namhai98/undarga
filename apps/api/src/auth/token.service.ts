import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config';
import { TokenAudienceMismatchError, UnauthenticatedError } from '../common/errors';
import type {
  AccessClaims,
  CustomerAccessClaims,
  PlatformAccessClaims,
  StaffAccessClaims,
  TokenRealm,
} from './token.types';

const ISSUER = 'undarga';

/**
 * Mints and verifies access tokens.
 *
 * The one rule worth stating: `verify` takes the realm the *route* expects and
 * refuses anything else. Callers never inspect `aud` themselves, so there is no
 * route that can forget to.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  get accessTtlSeconds(): number {
    return this.config.jwtAccessTtlSeconds;
  }

  signStaffAccess(input: {
    userAccountId: string;
    sessionId: string;
    email: string;
    name: string;
    activeCompanyId?: string;
    companyUserId?: string;
  }): string {
    const claims: Omit<StaffAccessClaims, 'iat' | 'exp'> = {
      sub: input.userAccountId,
      aud: 'staff',
      sid: input.sessionId,
      jti: randomUUID(),
      email: input.email,
      name: input.name,
      ...(input.activeCompanyId ? { act: input.activeCompanyId } : {}),
      ...(input.companyUserId ? { cu: input.companyUserId } : {}),
    };
    return this.sign(claims);
  }

  signPlatformAccess(input: {
    platformUserId: string;
    sessionId: string;
    email: string;
    name: string;
    impersonation?: { grantId: string; companyId: string; allowWrites: boolean; expiresAt: Date };
  }): string {
    const claims: Omit<PlatformAccessClaims, 'iat' | 'exp'> = {
      sub: input.platformUserId,
      aud: 'platform',
      sid: input.sessionId,
      jti: randomUUID(),
      email: input.email,
      name: input.name,
      ...(input.impersonation
        ? {
            imp: {
              g: input.impersonation.grantId,
              c: input.impersonation.companyId,
              w: input.impersonation.allowWrites,
              e: Math.floor(input.impersonation.expiresAt.getTime() / 1000),
            },
          }
        : {}),
    };
    return this.sign(claims);
  }

  signCustomerAccess(input: {
    customerIdentityId: string;
    companyCustomerId: string;
    companyId: string;
    sessionId: string;
    email: string;
    name: string;
  }): string {
    const claims: Omit<CustomerAccessClaims, 'iat' | 'exp'> = {
      sub: input.customerIdentityId,
      aud: 'customer',
      sid: input.sessionId,
      jti: randomUUID(),
      email: input.email,
      name: input.name,
      act: input.companyId,
      cc: input.companyCustomerId,
    };
    return this.sign(claims);
  }

  /**
   * Verify a token and assert its audience.
   *
   * @throws TokenAudienceMismatchError when the realm is wrong. Surfaces as a
   *         plain 401: the caller is not told that their token is valid
   *         elsewhere, only that it is not valid here.
   */
  verify(token: string, expectedRealm: TokenRealm): AccessClaims {
    return this.verifyAny(token, [expectedRealm]);
  }

  /**
   * Verify a token against several acceptable audiences.
   *
   * Needed because a company-scoped route carrying `@AllowPlatformAccess()`
   * legitimately serves two realms: its own staff, and a platform operator who
   * has explicitly targeted the company.
   *
   * The set is derived from the ROUTE's decorators, never from the token — the
   * caller cannot widen it by claiming a different audience. Everything the
   * operator can then do is still gated by TenantGuard and MembershipService.
   */
  verifyAny(token: string, allowedRealms: readonly TokenRealm[]): AccessClaims {
    let claims: AccessClaims;

    try {
      claims = this.jwt.verify<AccessClaims>(token, {
        secret: this.config.jwtAccessSecret,
        issuer: ISSUER,
        // Checked explicitly below so the failure is a typed domain error
        // rather than a generic jsonwebtoken message.
        audience: undefined,
      });
    } catch {
      throw new UnauthenticatedError();
    }

    if (!allowedRealms.includes(claims.aud)) {
      throw new TokenAudienceMismatchError(allowedRealms.join('|'), String(claims.aud));
    }

    return claims;
  }

  private sign(claims: Record<string, unknown>): string {
    return this.jwt.sign(claims, {
      secret: this.config.jwtAccessSecret,
      issuer: ISSUER,
      expiresIn: this.config.jwtAccessTtlSeconds,
    });
  }
}
