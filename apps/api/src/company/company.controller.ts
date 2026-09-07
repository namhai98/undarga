import { Body, Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { CompanyService } from './company.service';
import {
  deactivateCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
  updateCompanySettingsSchema,
  type DeactivateCompanyDto,
  type UpdateCompanyBrandingDto,
  type UpdateCompanyDto,
  type UpdateCompanySettingsDto,
} from './dto/company.dto';

/**
 * A company, administered from inside itself.
 *
 * ---------------------------------------------------------------------------
 * THE `:companyId` IN THE PATH IS NOT TRUSTED
 * ---------------------------------------------------------------------------
 *
 * `RouteParamTenantResolver` reads it, and `MembershipService` then checks it
 * against the caller's memberships — a company they do not belong to produces
 * 404 TENANT_NOT_FOUND, not 403, so the endpoint will not even confirm that the
 * company exists. Reading the id is not the vulnerability; trusting it would
 * be, and nothing here does: the service takes the company from the resolved
 * request context, never from the parameter.
 *
 * Under that, RLS on the tenant connection matches `company.id` against the
 * transaction's `app.current_company_id`, so a query for another company's row
 * returns nothing regardless.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO `POST /companies`
 * ---------------------------------------------------------------------------
 *
 * Companies are provisioned by a platform operator
 * (`POST /api/v1/platform/companies`, see docs/PROVISIONING.md), not created by
 * their own future members — there is no self-serve signup, and creating a
 * company means creating a billing relationship. Adding a second creation path
 * here would contradict that and would need the plan and trial decisions that
 * are still open.
 */
@ApiTags('company')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId', version: '1' })
@AllowPlatformAccess()
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.COMPANY_READ)
  @ApiOperation({ summary: 'The company you are in' })
  @ApiResponse({ status: 200, description: 'The company profile.' })
  @ApiResponse({ status: 404, description: 'TENANT_NOT_FOUND — you are not a member.' })
  async find() {
    return this.company.findCurrent();
  }

  @Patch()
  @RequirePermission(COMPANY_PERMISSIONS.COMPANY_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update the company profile',
    description:
      'Strict schema. `slug`, `status` and `currencyCode` are deliberately not editable here — ' +
      'the slug is a tenant-resolution key, status has its own endpoint so transitions can be ' +
      'validated, and currency reinterprets every amount already stored.',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — including unknown fields.' })
  async update(@Body(new ZodValidationPipe(updateCompanySchema)) dto: UpdateCompanyDto) {
    return this.company.update(dto);
  }

  /**
   * Deactivate. Deliberately not a destructive delete.
   *
   * `DELETE` because that is what a client reaching for "remove this company"
   * will try, and answering it with the safe behaviour beats leaving the verb
   * unhandled and inviting someone to add a real one later.
   */
  @Delete()
  @RequirePermission(COMPANY_PERMISSIONS.COMPANY_WRITE)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deactivate the company',
    description:
      'Sets status to CANCELED and a 90-day purge date. Nothing is deleted: a company owns ' +
      'appointments, payments and a ledger, and cascading through financial history has no ' +
      'undo. An actual purge is a separate operation that does not exist yet.',
  })
  @ApiResponse({ status: 409, description: 'CONFLICT — a suspended company cannot self-serve.' })
  async deactivate() {
    return this.company.deactivate({});
  }

  @Post('deactivate')
  @RequirePermission(COMPANY_PERMISSIONS.COMPANY_WRITE)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deactivate, recording a reason in the audit trail',
    description:
      'One-way, and that is structural rather than policy: MembershipService treats a CANCELED ' +
      'company as not found, so cancelling locks every member out — including the owner who ' +
      'would have to ask for it back. Offering "reactivate" on a tenant-scoped route would ' +
      'advertise a state no caller can ever be in. Reactivation is a platform operation and is ' +
      'not built yet.',
  })
  async deactivateWithReason(
    @Body(new ZodValidationPipe(deactivateCompanySchema)) dto: DeactivateCompanyDto,
  ) {
    return this.company.deactivate(dto);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  @Get('settings')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'Booking policy defaults',
    description:
      'The foundation later modules read. Nothing enforces these yet — the scheduling engine ' +
      'that consumes them is not built.',
  })
  async findSettings() {
    return this.company.findSettings();
  }

  @Patch('settings')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update booking policy defaults',
    description:
      'Percentages are basis points (10000 = 100%) and integers throughout — no float ever ' +
      'touches money in this codebase.',
  })
  async updateSettings(
    @Body(new ZodValidationPipe(updateCompanySettingsSchema)) dto: UpdateCompanySettingsDto,
  ) {
    return this.company.updateSettings(dto);
  }

  // ---------------------------------------------------------------------------
  // Branding
  // ---------------------------------------------------------------------------

  @Get('branding')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'Booking-page appearance',
    description: 'Returns the schema defaults when nothing has been customised yet.',
  })
  async findBranding() {
    return this.company.findBranding();
  }

  @Patch('branding')
  @RequirePermission(COMPANY_PERMISSIONS.BRANDING_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update booking-page appearance',
    description:
      'Logo and favicon are absent until the file module exists; `customCss` is absent because ' +
      'arbitrary CSS on a page rendering customer data is an exfiltration primitive.',
  })
  async updateBranding(
    @Body(new ZodValidationPipe(updateCompanyBrandingSchema)) dto: UpdateCompanyBrandingDto,
  ) {
    return this.company.updateBranding(dto);
  }
}
