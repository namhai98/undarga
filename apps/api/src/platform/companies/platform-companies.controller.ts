import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PlatformOnly } from '../../authz/decorators/authz.decorators';
import { PLATFORM_PERMISSIONS } from '../../authz/permissions';
import { ZodValidationPipe } from '../../common/pipes';
import { CompanyProvisioningService } from './company-provisioning.service';
import { provisionCompanySchema, type ProvisionCompanyDto } from './dto/provision-company.dto';

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
  constructor(private readonly provisioning: CompanyProvisioningService) {}

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

  @Get(':id')
  @PlatformOnly(PLATFORM_PERMISSIONS.COMPANY_LIST)
  @ApiOperation({
    summary: 'Read a provisioned company back',
    description:
      'For the onboarding flow to re-read what it created, and for an operator to confirm ' +
      'state after the fact. Counts of members, roles and branches are included so the ' +
      'caller can tell setup progress without a second call.',
  })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND.' })
  async findOne(@Param('id', uuidParam) id: string) {
    return this.provisioning.findById(id);
  }
}
