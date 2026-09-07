import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { BranchesService } from './branches.service';
import {
  createBranchSchema,
  listBranchesSchema,
  putBusinessHoursSchema,
  updateBranchSchema,
  updateBranchSettingsSchema,
  type CreateBranchDto,
  type ListBranchesDto,
  type PutBusinessHoursDto,
  type UpdateBranchDto,
  type UpdateBranchSettingsDto,
} from './dto/branch.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Branches within a company.
 *
 * ---------------------------------------------------------------------------
 * `branchId` IS NEVER TRUSTED ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * Two ids arrive in the path and neither is believed. `companyId` is validated
 * against the caller's memberships by TenantGuard; `branchId` is then only ever
 * used inside a filter that also carries the resolved company, so a branch
 * belonging to another tenant matches nothing and 404s. There is no code path
 * that looks a branch up by id alone.
 *
 * Beneath that the composite foreign key `(company_id, branch_id)` makes a
 * settings row or an opening-hours row attached to another company's branch
 * unrepresentable, and RLS refuses the rows regardless.
 *
 * ---------------------------------------------------------------------------
 * PERMISSIONS, NOT ROLE NAMES
 * ---------------------------------------------------------------------------
 *
 * `branch:read` and `branch:write` throughout. Nothing here asks whether the
 * caller is an OWNER or a BRANCH_MANAGER — which roles carry which permission
 * is a company's own configuration, and a controller that named a role would
 * quietly ignore it.
 *
 * Branch-level scoping (`company_user_branch`) exists in the schema and is
 * carried on the request context as `membership.branchScope`. It is NOT
 * enforced here yet, because nothing consumes it — but every read goes through
 * one repository, so applying it later is one filter in one place rather than a
 * sweep through controllers.
 */
@ApiTags('branches')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/branches', version: '1' })
@AllowPlatformAccess()
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_READ)
  @ApiOperation({ summary: 'List branches', description: 'Soft-deleted branches are excluded.' })
  async list(@Query(new ZodValidationPipe(listBranchesSchema)) query: ListBranchesDto) {
    return this.branches.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a branch',
    description:
      'The code is unique within this company only — half the salons in the country want "HQ", ' +
      'and making the first to sign up its owner would be absurd. Timezone is required: the ' +
      'BRANCH timezone is what bookings are calculated against, so defaulting it silently ' +
      'would make the most consequential field the easiest to get wrong.',
  })
  @ApiResponse({ status: 201, description: 'Created.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — unknown timezone or currency.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — the code is taken in this company.' })
  async create(@Body(new ZodValidationPipe(createBranchSchema)) dto: CreateBranchDto) {
    return this.branches.create(dto);
  }

  @Get(':branchId')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_READ)
  @ApiResponse({ status: 404, description: 'Unknown, deleted, or another company’s branch.' })
  async find(@Param('branchId', uuidParam) branchId: string) {
    return this.branches.findById(branchId);
  }

  @Patch(':branchId')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update a branch',
    description: 'Strict schema — `companyId` is not accepted, so a branch cannot be moved between tenants.',
  })
  async update(
    @Param('branchId', uuidParam) branchId: string,
    @Body(new ZodValidationPipe(updateBranchSchema)) dto: UpdateBranchDto,
  ) {
    return this.branches.update(branchId, dto);
  }

  @Delete(':branchId')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate a branch',
    description:
      'Soft delete. A branch is referenced by appointments, payments and gift cards, so the row ' +
      'stays and the bookings that happened there keep resolving. Deleting also releases the ' +
      'code for reuse, because the unique index is filtered on deleted_at.',
  })
  async remove(@Param('branchId', uuidParam) branchId: string): Promise<void> {
    await this.branches.remove(branchId);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  @Get(':branchId/settings')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_READ)
  @ApiOperation({
    summary: 'Per-branch policy overrides',
    description:
      'Null means "inherit the company", not zero. A branch nobody has configured returns all ' +
      'nulls and keeps following the company as the company changes.',
  })
  async findSettings(@Param('branchId', uuidParam) branchId: string) {
    return this.branches.findSettings(branchId);
  }

  @Patch(':branchId/settings')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'Update per-branch policy overrides' })
  async updateSettings(
    @Param('branchId', uuidParam) branchId: string,
    @Body(new ZodValidationPipe(updateBranchSettingsSchema)) dto: UpdateBranchSettingsDto,
  ) {
    return this.branches.updateSettings(branchId, dto);
  }

  // ---------------------------------------------------------------------------
  // Business hours
  // ---------------------------------------------------------------------------

  @Get(':branchId/business-hours')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_READ)
  @ApiOperation({
    summary: 'Weekly opening hours',
    description:
      'The current version of each day. Hours are versioned by effective date so a company can ' +
      'set summer hours in advance; this returns what is in force.',
  })
  async findBusinessHours(@Param('branchId', uuidParam) branchId: string) {
    return this.branches.findBusinessHours(branchId);
  }

  @Put(':branchId/business-hours')
  @RequirePermission(COMPANY_PERMISSIONS.BRANCH_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Replace the weekly opening hours',
    description:
      'PUT, not PATCH: opening hours are read as a set, and seven independent edits would leave ' +
      'windows where the schedule is half old and half new. Days you omit become CLOSED. ' +
      'Overnight hours (22:00 → 06:00) are supported — the crossesMidnight flag is derived by ' +
      'a database trigger. Only opensAt === closesAt is rejected.',
  })
  @ApiResponse({ status: 400, description: 'INVALID_BUSINESS_HOURS — see details.issues.' })
  async putBusinessHours(
    @Param('branchId', uuidParam) branchId: string,
    @Body(new ZodValidationPipe(putBusinessHoursSchema)) dto: PutBusinessHoursDto,
  ) {
    return this.branches.putBusinessHours(branchId, dto);
  }
}
