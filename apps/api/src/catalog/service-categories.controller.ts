import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { ServiceCategoriesService } from './service-categories.service';
import {
  createServiceCategorySchema,
  updateServiceCategorySchema,
  type CreateServiceCategoryDto,
  type UpdateServiceCategoryDto,
} from './dto/catalog.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * How a company groups its catalogue.
 *
 * ---------------------------------------------------------------------------
 * WHY `service:read` / `service:write` AND NOT NEW CATEGORY PERMISSIONS
 * ---------------------------------------------------------------------------
 *
 * The catalog is one thing to administer: nobody manages categories without
 * managing the services in them. Inventing `service.category.create` would mean
 * the six seeded roles silently lack it, so every existing company would have
 * to reconfigure before anyone could add a category — a migration imposed on
 * customers to express a distinction they do not make.
 */
@ApiTags('catalog')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/service-categories', version: '1' })
@AllowPlatformAccess()
export class ServiceCategoriesController {
  constructor(private readonly categories: ServiceCategoriesService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_READ)
  @ApiOperation({
    summary: 'List categories',
    description:
      'Flat list with `parentId`, so a caller builds the two-level tree itself rather than ' +
      'receiving a nested shape it would have to flatten again for a table.',
  })
  async list() {
    return this.categories.list();
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a category',
    description:
      'Two levels deep at most. Names are unique per PARENT, not per company, so ' +
      '`Hair > Colouring` and `Nails > Colouring` can both exist.',
  })
  @ApiResponse({ status: 409, description: 'CONFLICT — that name is taken under this parent.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — the parent is itself nested.' })
  async create(
    @Body(new ZodValidationPipe(createServiceCategorySchema)) dto: CreateServiceCategoryDto,
  ) {
    return this.categories.create(dto);
  }

  @Get(':categoryId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_READ)
  @ApiOperation({ summary: 'One category, with its children and service count' })
  async find(@Param('categoryId', uuidParam) categoryId: string) {
    return this.categories.findById(categoryId);
  }

  @Patch(':categoryId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update or re-parent a category',
    description: 'Cycles and three-level nesting are refused.',
  })
  async update(
    @Param('categoryId', uuidParam) categoryId: string,
    @Body(new ZodValidationPipe(updateServiceCategorySchema)) dto: UpdateServiceCategoryDto,
  ) {
    return this.categories.update(categoryId, dto);
  }

  @Delete(':categoryId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a category',
    description:
      'Soft delete, and refused while it still holds services or sub-categories. Cascading ' +
      'would silently orphan a price list — and because `service.categoryId` is nullable the ' +
      'failure would not even be a foreign-key error, just a catalogue that lost its structure. ' +
      'The refusal carries a count so the UI can say "move these 12 services first".',
  })
  @ApiResponse({ status: 409, description: 'CONFLICT — details.serviceCount or details.childCount.' })
  async remove(@Param('categoryId', uuidParam) categoryId: string): Promise<void> {
    await this.categories.remove(categoryId);
  }
}
