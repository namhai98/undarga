import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { META_IS_PUBLIC, META_TOKEN_REALM } from '../../common/decorators/metadata';
import { SessionRevokedError, UnauthenticatedError } from '../../common/errors';
import { RequestContextService } from '../../tenancy/context/request-context.service';
import {
  REQUEST_CONTEXT_KEY,
  type RequestWithContext,
} from '../../tenancy/guards/request-with-context';
import type { Actor } from '../../tenancy/context/context.types';
import { PlatformIdentityService } from '../../platform/platform-identity.service';
import { SessionDenyList } from '../session-deny-list';
import { TokenService } from '../token.service';
import type { AccessClaims, TokenRealm } from '../token.types';

/**
 * Guard 1 of 3: who is asking.
 *
 * Establishes the AsyncLocalStorage context for the whole request and puts the
 * actor in it. Everything downstream — the tenant guard, the permission guard,
 * repositories, the audit writer — reads from that one context rather than
 * re-parsing the token.
 *
 * Registered globally and deny-by-default: a route with no `@Public()` needs a
 * valid token. Forgetting a decorator makes an endpoint unreachable, which is
 * the failure mode you want.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ALS STORE COMES FROM
 * ---------------------------------------------------------------------------
 *
 * A Nest guard cannot wrap the rest of the request in a callback, so it cannot
 * call `als.run()` itself. RequestContextMiddleware opens the store first — one
 * `run()` around the entire request — and the guards then fill it in. That is
 * why the context object is mutated through `attachActor` / `attachTenant`
 * rather than replaced, and why `enterWith` (which has sharp edges around
 * shared async resources) is not used anywhere.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly context: RequestContextService,
    private readonly denyList: SessionDenyList,
    private readonly platformIdentity: PlatformIdentityService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    const targets = [ctx.getHandler(), ctx.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(META_IS_PUBLIC, targets) ?? false;
    const realm = this.reflector.getAllAndOverride<TokenRealm>(META_TOKEN_REALM, targets) ?? 'staff';

    const token = extractBearer(request.headers.authorization);

    if (!token) {
      if (!isPublic) throw new UnauthenticatedError();
      // Public route, anonymous caller. The middleware already opened a context
      // with an anonymous actor and a request id, so there is nothing to do.
      request[REQUEST_CONTEXT_KEY] = this.context.peek();
      return true;
    }

    // A token on a public route is still verified. Ignoring it would mean an
    // expired or revoked token silently downgrades to anonymous, which makes
    // "why am I seeing logged-out content" undebuggable.
    const claims = this.tokens.verify(token, realm);

    if (this.denyList.isRevoked(claims.sid)) {
      throw new SessionRevokedError();
    }

    const actor = await this.toActor(claims);

    this.context.attachActor(actor);
    // Mirror onto the request so `@CurrentUser()` — which runs outside DI and
    // cannot reach the ALS service — can read it.
    request[REQUEST_CONTEXT_KEY] = this.context.peek();

    // Handed to the resolver chain by TenantGuard. Carried out-of-band rather
    // than via a header so it cannot be spoofed by the caller.
    request.verifiedActiveCompanyId = 'act' in claims ? claims.act : undefined;

    return true;
  }

  private async toActor(claims: AccessClaims): Promise<Actor> {
    switch (claims.aud) {
      case 'staff':
        return {
          kind: 'COMPANY_USER',
          userAccountId: claims.sub,
          email: claims.email,
          displayName: claims.name,
          sessionId: claims.sid,
        };

      case 'platform': {
        // Read per request rather than trusting a claim. These are the
        // highest-privilege grants in the system, and a 15-minute staleness
        // window on revoking one is not acceptable. Cached briefly upstream.
        const permissions = await this.platformIdentity.loadPermissions(claims.sub);
        return {
          kind: 'PLATFORM_USER',
          platformUserId: claims.sub,
          email: claims.email,
          displayName: claims.name,
          sessionId: claims.sid,
          platformPermissions: permissions,
          ...(claims.imp
            ? {
                impersonation: {
                  grantId: claims.imp.g,
                  companyId: claims.imp.c,
                  allowWrites: claims.imp.w,
                  expiresAt: new Date(claims.imp.e * 1000),
                },
              }
            : {}),
        };
      }

      case 'customer':
        return {
          kind: 'CUSTOMER',
          customerIdentityId: claims.sub,
          companyCustomerId: claims.cc,
          companyId: claims.act,
        };
    }
  }

}

function extractBearer(header?: string): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

