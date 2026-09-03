import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  META_ALLOW_PLATFORM_ACCESS,
  META_IS_PUBLIC,
  META_NO_TENANT,
  META_PLATFORM_ONLY,
} from '../../common/decorators/metadata';
import {
  PlatformAccessNotTargetedError,
  TenantUnresolvedError,
  UnauthenticatedError,
} from '../../common/errors';
import { RequestContextService } from '../context/request-context.service';
import { isPlatformUser, isSystemActor } from '../context/context.types';
import { MembershipService } from '../membership/membership.service';
import { TenantResolverChain } from '../resolvers/tenant-resolver.chain';
import type { TenantResolutionInput } from '../resolvers/tenant-resolver.types';
import { REQUEST_CONTEXT_KEY, type RequestWithContext } from './request-with-context';

/**
 * Guard 2 of 3: which company.
 *
 * ---------------------------------------------------------------------------
 * DENY BY DEFAULT
 * ---------------------------------------------------------------------------
 *
 * Registered globally, and a route with no decorator IS company-scoped. Opting
 * out takes `@NoTenant()`, `@PlatformOnly()` or `@Public()`.
 *
 * The alternative — tenant-scoping only routes that ask for it — fails in the
 * worst possible direction: a developer adds `GET /reports/revenue`, forgets
 * the decorator, and ships an endpoint that reads every company's revenue. With
 * this ordering the same mistake produces a 500 on the first request, in
 * development, with a message naming the missing decorator.
 *
 * ---------------------------------------------------------------------------
 * THE TWO STEPS THAT MUST STAY SEPARATE
 * ---------------------------------------------------------------------------
 *
 *   1. RESOLUTION — TenantResolverChain answers "which company is named?"
 *      It reads the URL, the header, the hostname and the token claim. It is
 *      pure lookup and grants nothing.
 *
 *   2. AUTHORIZATION — MembershipService answers "may this actor enter it?"
 *      It is the only thing that produces a TenantContext.
 *
 * Keeping them in separate objects is what makes the attack in the brief
 * uninteresting. `GET /api/v1/companies/<company-B-id>/appointments` resolves
 * cleanly to company B — and then MembershipService finds no membership and
 * returns 404. The id in the URL was never trusted; it was only *read*.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolvers: TenantResolverChain,
    private readonly memberships: MembershipService,
    private readonly context: RequestContextService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(META_IS_PUBLIC, targets) ?? false;
    const noTenant = this.reflector.getAllAndOverride<boolean>(META_NO_TENANT, targets) ?? false;
    const platformOnly =
      this.reflector.getAllAndOverride<boolean>(META_PLATFORM_ONLY, targets) ?? false;
    const allowPlatform =
      this.reflector.getAllAndOverride<boolean>(META_ALLOW_PLATFORM_ACCESS, targets) ?? false;

    // A platform-only route is not company-scoped unless it explicitly opts in
    // to entering one.
    if (isPublic || noTenant || (platformOnly && !allowPlatform)) {
      return true;
    }

    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    const actor = this.context.actor;

    if (!actor || isSystemActor(actor)) {
      // Reached when a route is company-scoped but not authenticated. That is a
      // wiring error, not a client error, but 401 is the honest response.
      throw new UnauthenticatedError();
    }

    if (isPlatformUser(actor) && !allowPlatform) {
      // A platform token on an ordinary company route. Refused rather than
      // silently granted: cross-company reach is opt-in per endpoint, so it is
      // greppable rather than emergent.
      throw new PlatformAccessNotTargetedError();
    }

    const input = this.toResolutionInput(request);
    const candidate = await this.resolvers.resolve(input);

    // Checked before the generic "unresolved" case so an operator gets an
    // actionable message. They have no active company of their own, so *no*
    // candidate and an *implicit* candidate mean the same thing here: they did
    // not name a target, and one must never be invented for them.
    if (isPlatformUser(actor) && (!candidate || !candidate.explicit)) {
      throw new PlatformAccessNotTargetedError();
    }

    if (!candidate) {
      throw new TenantUnresolvedError();
    }

    // The authorization step. Throws 404 when the actor is not a member.
    const tenant = await this.memberships.authorize(actor, candidate.companyId, candidate.source);

    this.context.attachTenant(tenant);
    request[REQUEST_CONTEXT_KEY] = this.context.peek();

    if (tenant.viaPlatformAccess) {
      this.logger.warn(
        `Cross-company access: ${actor.kind} entered company ${tenant.company.slug} ` +
          `on ${input.method} ${input.path} via ${candidate.source}`,
      );
    }

    return true;
  }

  /**
   * Adapt Express to the transport-neutral resolver input.
   *
   * `activeCompanyId` comes from `request.verifiedActiveCompanyId`, which
   * JwtAuthGuard set from the signature-verified token — not from a header, so
   * a caller cannot supply it.
   *
   * A WebSocket gateway would add a sibling of this method and reuse the whole
   * chain unchanged; that is the reason the input type exists at all.
   */
  private toResolutionInput(request: RequestWithContext): TenantResolutionInput {
    return {
      params: (request.params ?? {}) as Record<string, string | undefined>,
      query: (request.query ?? {}) as Record<string, string | undefined>,
      headers: request.headers as Record<string, string | undefined>,
      host: request.headers.host,
      path: request.path ?? request.url ?? '',
      method: request.method ?? 'GET',
      actor: this.context.actor,
      activeCompanyId: request.verifiedActiveCompanyId,
    };
  }
}
