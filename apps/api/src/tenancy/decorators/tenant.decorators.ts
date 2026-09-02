import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  META_ALLOW_PLATFORM_ACCESS,
  META_NO_TENANT,
  META_REQUIRES_WRITE,
} from '../../common/decorators/metadata';
// Aliased: the decorators below deliberately reuse these names as values, and a
// type and a value with the same name cannot both be declared in one module.
import type {
  CurrentCompany as CurrentCompanyType,
  CurrentMembership as CurrentMembershipType,
  TenantContext,
} from '../context/context.types';
import { REQUEST_CONTEXT_KEY, type RequestWithContext } from '../guards/request-with-context';

/**
 * Opt this route out of tenant resolution.
 *
 * Needed because TenantGuard is global and DENIES BY DEFAULT — a route with no
 * decorator at all is company-scoped. That ordering is deliberate: forgetting a
 * decorator should make a route inaccessible, not make it unscoped. The
 * opt-outs are login, "list my companies", company switching, platform routes,
 * and health.
 */
export const NoTenant = () => SetMetadata(META_NO_TENANT, true);

/**
 * Permit a platform operator to enter this company-scoped route.
 *
 * Without it, a platform token on a company route is refused even with the
 * right platform permission. Cross-company access is opt-in per route, so
 * "which endpoints can support reach?" is answerable by grepping for this
 * decorator rather than by reasoning about role checks.
 */
export const AllowPlatformAccess = () => SetMetadata(META_ALLOW_PLATFORM_ACCESS, true);

/**
 * Mark a route as mutating. Blocked when the company is in a read-only state
 * (billing grace) or when a platform operator holds read-only access.
 */
export const RequiresWrite = () => SetMetadata(META_REQUIRES_WRITE, true);

function contextOf(ctx: ExecutionContext) {
  const request = ctx.switchToHttp().getRequest<RequestWithContext>();
  return request[REQUEST_CONTEXT_KEY];
}

/**
 * Param decorators read from the request rather than from
 * RequestContextService, because `createParamDecorator` factories run outside
 * dependency injection. The guards write both, in the same statement, so the
 * two can never disagree.
 */

/** The whole tenant context. Null only on routes that opted out. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext | null => contextOf(ctx)?.tenant ?? null,
);

export const CurrentCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentCompanyType | null =>
    contextOf(ctx)?.tenant?.company ?? null,
);

export const CurrentCompanyId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    contextOf(ctx)?.tenant?.company.id ?? null,
);

/** Null when a platform operator is inside the company without a membership. */
export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentMembershipType | null =>
    contextOf(ctx)?.tenant?.membership ?? null,
);
