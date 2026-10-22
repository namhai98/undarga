import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireAllPermissions } from '../authz/decorators/authz.decorators';
import { UnauthenticatedError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { isCompanyUser, type Actor } from '../tenancy/context/context.types';
import { CurrentCompanyId, NoTenant, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import type { RequestWithContext } from '../tenancy/guards/request-with-context';
import {
  completeOnboardingSchema,
  createOnboardingCompanySchema,
  onboardingSetupSchema,
  onboardingStatusQuerySchema,
  slugAvailabilityQuerySchema,
  type CompleteOnboardingDto,
  type CreateOnboardingCompanyDto,
  type OnboardingSetupDto,
  type OnboardingStatusQueryDto,
  type SlugAvailabilityQueryDto,
} from './dto/onboarding.dto';
import { COMPLETE_PERMISSIONS, OnboardingService, SETUP_PERMISSIONS } from './onboarding.service';

/**
 * Company onboarding (docs/ONBOARDING.md).
 *
 * Staff realm only: a platform token is refused at the audience check like on
 * every other staff route, and nothing here is reachable anonymously.
 *
 * The tenant-less routes (`company`, `status`, `slug-availability`) take no
 * company id they would trust. The two company routes are ordinary tenant
 * routes: `:companyId` goes through TenantGuard's membership check and then
 * PermissionGuard, so they are open to exactly the members who could make the
 * same writes through the branches, settings and catalog endpoints.
 */
@ApiTags('onboarding')
@Controller({ path: 'onboarding', version: '1' })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('company')
  @NoTenant()
  @HttpCode(201)
  // Each call starts a trial; a burst of them is never a person filling a form.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create a company and become its owner',
    description:
      'Steps 1-3 of the wizard in ONE transaction: the company (timezone from the branch, ' +
      'currency and business details), its settings and six system roles, the CALLER as its ' +
      'ACTIVE owner, the first branch with optional opening hours, and a trial of the default ' +
      'plan. Any failure rolls all of it back. The owner is always the signed-in account — no ' +
      'field names a user. Switch to the new company with POST /auth/switch-company. ' +
      'Onboarding status becomes IN_PROGRESS.',
  })
  @ApiResponse({ status: 201, description: 'Created.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — a field, timezone or currency.' })
  @ApiResponse({ status: 401, description: 'Not signed in, or a platform token.' })
  @ApiResponse({
    status: 409,
    description: 'CONFLICT — slug taken, or the account already owns the maximum number.',
  })
  async create(
    @Body(new ZodValidationPipe(createOnboardingCompanySchema)) dto: CreateOnboardingCompanyDto,
    @CurrentUser() actor: Actor | null,
  ) {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
    return this.onboarding.createCompany(actor, dto);
  }

  @Get('status')
  @NoTenant()
  @ApiOperation({
    summary: 'Where the caller is in onboarding',
    description:
      'For `companyId` if given, else the active company in the token, else the first ' +
      'membership. NOT_STARTED with `company: null` means the account belongs to no company. ' +
      '`canManage` says whether the caller holds the permissions to finish the wizard; the web ' +
      'app only guides those members back to it. Membership is verified exactly as TenantGuard ' +
      'does, so another tenant’s id is a 404.',
  })
  @ApiResponse({ status: 404, description: 'TENANT_NOT_FOUND — not a member of that company.' })
  async status(
    @Query(new ZodValidationPipe(onboardingStatusQuerySchema)) query: OnboardingStatusQueryDto,
    @CurrentUser() actor: Actor | null,
    @Req() request: RequestWithContext,
  ) {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
    // Set by JwtAuthGuard from the signature-verified token only.
    return this.onboarding.status(actor, query.companyId, request.verifiedActiveCompanyId);
  }

  @Get('slug-availability')
  @NoTenant()
  @ApiOperation({
    summary: 'Is this company identifier free?',
    description:
      'Advisory, for the form: format (including reserved names) and uniqueness. Creation ' +
      're-checks, so a race is still a 409 there.',
  })
  async slugAvailability(
    @Query(new ZodValidationPipe(slugAvailabilityQuerySchema)) query: SlugAvailabilityQueryDto,
    @CurrentUser() actor: Actor | null,
  ) {
    if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
    return this.onboarding.slugAvailability(query.slug);
  }

  @Post('companies/:companyId/setup')
  @HttpCode(200)
  @RequiresWrite()
  @RequireAllPermissions(...SETUP_PERMISSIONS)
  @ApiOperation({
    summary: 'Finish steps 2-3 for an existing company',
    description:
      'For a company an operator provisioned (onboarding NOT_STARTED): business details, the ' +
      'first branch and optional opening hours, in one transaction. A PENDING_SETUP company ' +
      'becomes ACTIVE. Requires company:write, settings:write and branch:write.',
  })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED, or the plan’s branch limit.' })
  @ApiResponse({ status: 404, description: 'TENANT_NOT_FOUND — not a member of that company.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — already set up, or branch code taken.' })
  async setup(
    @CurrentCompanyId() companyId: string,
    @Body(new ZodValidationPipe(onboardingSetupSchema)) dto: OnboardingSetupDto,
  ) {
    return this.onboarding.setup(companyId, dto);
  }

  @Post('companies/:companyId/complete')
  @HttpCode(200)
  @RequiresWrite()
  @RequireAllPermissions(...COMPLETE_PERMISSIONS)
  @ApiOperation({
    summary: 'Add the initial services (optional) and finish onboarding',
    description:
      'Step 4 and the finish, in one transaction: each service (category matched by name or ' +
      'created, offered at every branch, plan limit checked) and the company marked ' +
      'COMPLETED. An empty `services` list is the skipped step. Requires company:write and ' +
      'service:write.',
  })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED, or the plan’s service limit.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — already complete, or not set up yet.' })
  async complete(
    @CurrentCompanyId() companyId: string,
    @Body(new ZodValidationPipe(completeOnboardingSchema)) dto: CompleteOnboardingDto,
  ) {
    return this.onboarding.complete(companyId, dto);
  }
}
