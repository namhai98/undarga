import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PlatformOnly } from '../../authz/decorators/authz.decorators';
import { PLATFORM_PERMISSIONS } from '../../authz/permissions';
import { ZodValidationPipe } from '../../common/pipes';
import { CompanyProvisioningService } from './company-provisioning.service';
import { provisionCompanySchema, type ProvisionCompanyDto } from './dto/provision-company.dto';
import {
  changeCompanyStatusSchema,
  companyListQuerySchema,
  companyUsersQuerySchema,
  type ChangeCompanyStatusDto,
  type CompanyListQueryDto,
  type CompanyUsersQueryDto,
} from '../dto/platform-admin.dto';
import { PlatformAdminService } from '../platform-admin.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Operator-facing company management.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO SELF-SERVE SIGNUP
 * ---------------------------------------------------------------------------
 *
 * Creating a company means creating its billing relationship. Provisioning
 * starts its subscription — a trial of `planKey` (default PRO) — in the same
 * transaction (see docs/SUBSCRIPTIONS.md); the commercial terms beyond that are
 * agreed out of band. Self-serve signup can be added later as a second entry
 * point into the same service.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE PARAMETER IS `:id`, NOT `:companyId`
 * ---------------------------------------------------------------------------
 *
 * `RouteParamTenantResolver` keys on `params['companyId']`. These routes are
 * @PlatformOnly, so TenantGuard short-circuits and the resolver never runs
 * today — but naming the parameter `:id` means the route stays inert even if
 * someone later adds @AllowPlatformAccess() to it. Cheap insurance against a
 * caller-supplied company id becoming a tenant selector.
 */
@ApiTags('platform')
@Controller({ path: 'platform/companies', version: '1' })
export class PlatformCompaniesController {
  constructor(
    private readonly provisioning: CompanyProvisioningService,
    private readonly admin: PlatformAdminService,
  ) {}

  @Post()
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_PROVISION)
  @ApiOperation({
    summary: 'Provision a company and its first owner',
    description:
      'Creates the company, its settings, the six system roles and the owner membership in ' +
      'one transaction. The owner cannot sign in until they accept an invitation unless the ' +
      'email already belongs to an active account — `owner.requiresInvitation` says which.',
  })
  @ApiResponse({ status: 201, description: 'Provisioned.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — unknown timezone or currency.' })
  @ApiResponse({ status: 401, description: 'No token, or a staff token (audience mismatch).' })
  @ApiResponse({ status: 404, description: 'PLATFORM_ACCESS_REQUIRED — not a platform operator.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — slug taken, or owner account unusable.' })
  async provision(@Body(new ZodValidationPipe(provisionCompanySchema)) dto: ProvisionCompanyDto) {
    return this.provisioning.provision(dto);
  }

  @Get()
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_LIST)
  @ApiOperation({
    summary: 'List every company on the platform',
    description:
      'Searchable across display name, legal name, slug and contact email; filterable by ' +
      'company status, subscription status, plan and creation date. Each row carries member, ' +
      'branch and employee COUNTS — enough to size a tenant, with none of its contents.',
  })
  @ApiResponse({ status: 401, description: 'No token, or a staff token (audience mismatch).' })
  @ApiResponse({ status: 404, description: 'PLATFORM_ACCESS_REQUIRED — not a platform operator.' })
  async list(@Query(new ZodValidationPipe(companyListQuerySchema)) query: CompanyListQueryDto) {
    return this.admin.listCompanies(query);
  }

  @Get(':id')
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_LIST)
  @ApiOperation({
    summary: 'One company, with its size and its subscription',
    description:
      'Branch, employee, service, customer and appointment counts, the subscription, and the ' +
      'last ten administrative actions — in one request. The activity list carries the action ' +
      'and the actor, never the payload: for a tenant’s own actions that payload contains ' +
      'customer data.',
  })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND.' })
  async findOne(@Param('id', uuidParam) id: string) {
    return this.admin.getCompany(id);
  }

  @Patch(':id/status')
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_SUSPEND)
  @ApiOperation({
    summary: 'Suspend, reactivate, or switch a company off',
    description:
      'A reason is REQUIRED and goes on the hash-chained audit trail — suspending a company ' +
      'stops every member of its staff working, and "an operator clicked it" is not an answer ' +
      'six months later. The tenant directory cache is invalidated immediately, because ' +
      'without that a suspended company keeps working until the TTL expires. ' +
      '`CANCELED -> ACTIVE` is the only way back from a company deactivating itself: the ' +
      'company-facing endpoint is deliberately one-way, since a cancelled company’s owner can ' +
      'no longer reach anything.',
  })
  @ApiResponse({ status: 200, description: 'Changed; the full company is returned.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — an illegal transition.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — already in that status, or deleted.' })
  async changeStatus(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(changeCompanyStatusSchema)) dto: ChangeCompanyStatusDto,
  ) {
    return this.admin.changeCompanyStatus(id, dto);
  }

  @Get(':id/users')
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_LIST)
  @ApiOperation({
    summary: 'The people who can sign in to this company',
    description:
      'Company USERS, not customers — the people who bought the product, which is who an ' +
      'operator supports. No password hash, session, MFA secret or token is selected. ' +
      'Nothing here returns a tenant’s customers.',
  })
  async users(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(companyUsersQuerySchema)) query: CompanyUsersQueryDto,
  ) {
    return this.admin.listCompanyUsers(id, query);
  }

  @Get(':id/subscription')
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_LIST)
  @ApiOperation({
    summary: 'Subscription and usage, together',
    description:
      'One question — "is this customer within what they are paying for" — so one response. ' +
      'Plan entitlements with any negotiated overrides applied, this period’s counters against ' +
      'those limits, and recent periods so growth is visible without a second call.',
  })
  async subscription(@Param('id', uuidParam) id: string) {
    return this.admin.getCompanySubscription(id);
  }
}
