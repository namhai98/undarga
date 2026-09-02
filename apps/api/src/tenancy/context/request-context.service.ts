import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { MissingTenantContextError, UnauthenticatedError } from '../../common/errors';
import type {
  Actor,
  CurrentCompany,
  CurrentMembership,
  RequestContext,
  SystemActor,
  TenantContext,
} from './context.types';

/**
 * The single source of "who is asking, and on behalf of which company".
 *
 * WHY AsyncLocalStorage RATHER THAN A REQUEST-SCOPED PROVIDER
 *
 * NestJS `Scope.REQUEST` was the obvious candidate and is the wrong tool here:
 *
 *   - It is contagious. Every provider that injects a request-scoped provider
 *     becomes request-scoped itself, and so does everything that injects those.
 *     The tenant context is needed in the repository layer, so the entire
 *     service graph would be rebuilt per request.
 *   - It does not exist outside HTTP. There is no request in a BullMQ worker,
 *     a cron tick, or a WebSocket frame — and this system needs tenant context
 *     in all three (see src/jobs).
 *   - It cannot express nested contexts, which impersonation and job fan-out
 *     both need.
 *
 * AsyncLocalStorage has none of those problems: one singleton service, the same
 * API in every execution surface, and context that follows async continuations
 * automatically. The cost is that the store is implicit rather than injected,
 * which is why `requireTenant()` throws loudly instead of returning null.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT
 *
 * There is no accessor that returns "the tenant, or nothing, carry on". Code
 * that needs a company either gets one or the request fails. That is what
 * makes an accidentally unscoped query impossible to write by omission.
 */
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  // -------------------------------------------------------------------------
  // Entering a context
  // -------------------------------------------------------------------------

  /**
   * Run `fn` with `context` active. Everything awaited inside sees it; nothing
   * outside does. Contexts nest, and the inner one wins for its duration.
   */
  run<T>(context: RequestContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  /** Convenience for HTTP: build a context with no tenant, then attach later. */
  runWithActor<T>(
    actor: Actor,
    fn: () => T,
    options: { requestId?: string; ipAddress?: string; userAgent?: string } = {},
  ): T {
    return this.run(
      {
        requestId: options.requestId ?? randomUUID(),
        actor,
        tenant: null,
        startedAt: new Date(),
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
      fn,
    );
  }

  /**
   * Run `fn` as a background system actor inside one company.
   *
   * This is the ONLY sanctioned way for non-request code to obtain a tenant
   * context. It takes a fully-built TenantContext rather than a bare id, so a
   * worker cannot conjure access to a company by passing a string — the
   * TenantContext must have come from MembershipService or the job runner's
   * own validation. See src/jobs/tenant-job.runner.ts.
   */
  runAsSystem<T>(name: string, tenant: TenantContext | null, fn: () => T, requestId?: string): T {
    const actor: SystemActor = { kind: 'SYSTEM', name };
    return this.run(
      {
        requestId: requestId ?? randomUUID(),
        actor,
        tenant,
        startedAt: new Date(),
      },
      fn,
    );
  }

  /**
   * Replace the placeholder actor once authentication has identified them.
   *
   * The middleware opens the context before anything is known about the caller
   * (so that a request id exists for logging even on a 401), and JwtAuthGuard
   * fills the actor in here. Called at most once per request.
   */
  attachActor(actor: Actor): void {
    const current = this.storage.getStore();
    if (!current) {
      throw new MissingTenantContextError('attachActor');
    }
    (current as { actor: Actor }).actor = actor;
  }

  /**
   * Attach a resolved tenant to the context already in flight.
   *
   * Called exactly once per request, by TenantGuard, after MembershipService
   * has authorised the company. Re-attaching a *different* company mid-request
   * is refused: a request that changes tenant halfway is either a bug or an
   * attack, and there is no legitimate case for it. (Switching the active
   * company is a separate endpoint that issues a new token.)
   */
  attachTenant(tenant: TenantContext): void {
    const current = this.storage.getStore();
    if (!current) {
      throw new MissingTenantContextError('attachTenant');
    }
    if (current.tenant && current.tenant.company.id !== tenant.company.id) {
      throw new MissingTenantContextError(
        `attachTenant: refusing to switch from company ${current.tenant.company.id} ` +
          `to ${tenant.company.id} mid-request`,
      );
    }
    // RequestContext is readonly to consumers; the guard is the one writer.
    (current as { tenant: TenantContext | null }).tenant = tenant;
  }

  // -------------------------------------------------------------------------
  // Reading a context
  // -------------------------------------------------------------------------

  /** The raw context, or undefined outside any run(). Prefer the accessors. */
  peek(): RequestContext | undefined {
    return this.storage.getStore();
  }

  get requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  /** The actor, or null when unauthenticated. */
  get actor(): Actor | null {
    return this.storage.getStore()?.actor ?? null;
  }

  requireActor(): Actor {
    const actor = this.actor;
    if (!actor) {
      throw new UnauthenticatedError();
    }
    return actor;
  }

  /**
   * The tenant, or null. Use this ONLY where "no company" is a legitimate
   * state you are about to branch on — audit writes and the "list my
   * companies" endpoint are the real cases. Everywhere else use
   * `requireTenant()`.
   */
  tenantOrNull(): TenantContext | null {
    return this.storage.getStore()?.tenant ?? null;
  }

  /**
   * The tenant, or throw.
   *
   * This is the method the whole design turns on. Every company-scoped query
   * gets its companyId from here, so a route that forgot the tenant guard
   * produces a 500 with a precise message instead of a query that quietly
   * spans every tenant on the platform.
   */
  requireTenant(operation?: string): TenantContext {
    const tenant = this.tenantOrNull();
    if (!tenant) {
      throw new MissingTenantContextError(operation);
    }
    return tenant;
  }

  /** Shorthand for the overwhelmingly common case. */
  requireCompanyId(operation?: string): string {
    return this.requireTenant(operation).company.id;
  }

  requireCompany(operation?: string): CurrentCompany {
    return this.requireTenant(operation).company;
  }

  /**
   * The caller's membership, or null when a platform operator is inside the
   * company without one. Callers that genuinely require a member (rather than
   * any authorised actor) should check for null explicitly.
   */
  membership(): CurrentMembership | null {
    return this.tenantOrNull()?.membership ?? null;
  }

  hasPermission(permission: string): boolean {
    return this.tenantOrNull()?.permissions.has(permission) ?? false;
  }

  /** True when the current tenant context came from platform access. */
  get isPlatformAccess(): boolean {
    return this.tenantOrNull()?.viaPlatformAccess ?? false;
  }
}
