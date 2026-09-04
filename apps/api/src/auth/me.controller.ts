import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestContextService } from '../tenancy/context/request-context.service';

/**
 * What the signed-in caller may do inside the company they are currently in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT PART OF /auth/me
 * ---------------------------------------------------------------------------
 *
 * `/auth/me` is `@NoTenant()` — it is the endpoint you call to *decide* which
 * company to enter, so it runs before one is chosen and structurally cannot
 * know your permissions. Permissions only exist relative to a membership, and
 * MembershipService computes them per request inside a tenant context.
 *
 * So this is a separate, tenant-scoped route. It is a direct projection of the
 * TenantContext that TenantGuard has already built for the request: no queries,
 * no work, just the context the guard chain produced, made visible.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLIENT MAY DO WITH IT
 * ---------------------------------------------------------------------------
 *
 * Render. Nothing else. Per `docs/ARCHITECTURE-RULES.md` rule 3 the web app is
 * not a security boundary: it hides buttons, the API decides. A client that
 * omits a permission from a request it sends anyway gets a 403 from
 * PermissionGuard, which is the actual control.
 *
 * No permission is required to call it. Asking "what am I allowed to do here"
 * is not itself a privilege — the answer is derived entirely from the caller's
 * own membership, and refusing it would only mean the UI renders blind.
 */
@ApiTags('auth')
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(private readonly context: RequestContextService) {}

  @Get('context')
  @ApiOperation({
    summary: 'The current company, membership and effective permissions',
    description:
      'Tenant-scoped. Requires an active company — call POST /auth/switch-company first ' +
      'if the token carries none.',
  })
  currentContext() {
    const tenant = this.context.requireTenant('GET /me/context');

    return {
      company: {
        id: tenant.company.id,
        slug: tenant.company.slug,
        status: tenant.company.status,
        operationalStatus: tenant.company.operationalStatus,
        defaultTimezoneName: tenant.company.defaultTimezoneName,
        currencyCode: tenant.company.currencyCode,
      },
      membership: tenant.membership
        ? {
            companyUserId: tenant.membership.companyUserId,
            isOwner: tenant.membership.isOwner,
            roleKeys: [...tenant.membership.roleKeys],
            branchScope: tenant.membership.branchScope ? [...tenant.membership.branchScope] : null,
          }
        : null,
      permissions: [...tenant.permissions].sort(),
      /**
       * True when a platform operator is inside a company they do not belong
       * to. Surfaced so the UI can show that it is not an ordinary session —
       * an operator acting inside a tenant should be able to see that they are.
       */
      viaPlatformAccess: tenant.viaPlatformAccess,
    };
  }
}
