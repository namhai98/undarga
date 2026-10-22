import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PlatformOnly } from '../authz/decorators/authz.decorators';
import { PLATFORM_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import {
  auditLogQuerySchema,
  platformDashboardQuerySchema,
  type AuditLogQueryDto,
  type PlatformDashboardQueryDto,
} from './dto/platform-admin.dto';
import { PlatformAdminService } from './platform-admin.service';

/**
 * The operator console's own screens: the dashboard and the audit trail.
 *
 * ---------------------------------------------------------------------------
 * `@PlatformOnly` IS THE WHOLE SECURITY BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * It sets three pieces of metadata, and all three matter:
 *
 *   META_TOKEN_REALM = 'platform'   `JwtAuthGuard` rejects a STAFF token with
 *                                   TOKEN_AUDIENCE_MISMATCH before any
 *                                   permission is read. A company owner cannot
 *                                   reach these routes by acquiring a
 *                                   permission, because the token is wrong.
 *   META_PLATFORM_ONLY              `TenantGuard` short-circuits: no company is
 *                                   resolved, so no company context exists to
 *                                   be confused with authority.
 *   required platform permissions   `PermissionGuard` checks the operator's
 *                                   own grants, which live in `platform_role`
 *                                   and share nothing with `company_role`.
 *
 * There is no company permission that grants platform access, and no platform
 * permission that implicitly grants tenant data access — `MembershipService`
 * requires `platform:company:data:read` explicitly for that, and these routes
 * do not use it.
 */
@ApiTags('platform')
@Controller({ path: 'platform', version: '1' })
export class PlatformAdminController {
  constructor(private readonly platform: PlatformAdminService) {}

  @Get('dashboard')
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_LIST)
  @ApiOperation({
    summary: 'Platform-wide statistics',
    description:
      'Companies by status, subscriptions by status, total users, total appointments, trials ' +
      'ending within seven days and the most-used plans — in ONE request, so every figure is ' +
      'from the same instant. Every number is a grouped aggregate; nothing scans rows. ' +
      'No tenant business data is returned, only counts.',
  })
  @ApiResponse({ status: 401, description: 'A staff token is rejected at the audience check.' })
  @ApiResponse({ status: 403, description: 'An operator without platform:company:list.' })
  async dashboard(
    @Query(new ZodValidationPipe(platformDashboardQuerySchema)) query: PlatformDashboardQueryDto,
  ) {
    return this.platform.dashboard(query);
  }

  @Get('audit-logs')
  @PlatformOnly(PLATFORM_PERMISSIONS.AUDIT_READ_ALL)
  @ApiOperation({
    summary: 'Administrative history across every tenant',
    description:
      'Filterable by company, action, actor and date range. The `before`/`after` payloads are ' +
      'deliberately NOT returned: for a tenant’s own actions they contain customer names and ' +
      'prices, and an operator needs to see THAT something changed and who did it. Only ' +
      '`metadata.reason` on `platform.*` actions is surfaced, because that field is ' +
      'operator-authored text about a business decision.',
  })
  @ApiResponse({
    status: 403,
    description:
      'platform:audit:read is separate from platform:company:list — reading the history of ' +
      'everything every tenant has done is a larger grant than listing them.',
  })
  async auditLogs(@Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQueryDto) {
    return this.platform.listAuditLogs(query);
  }
}
