import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { DatabaseModule } from '../database/database.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import {
  createResourceSchema,
  createResourceTypeSchema,
  createUnavailabilitySchema,
  putAvailabilitySchema,
  resourceQuerySchema,
  ResourceRepository,
  ResourcesService,
  updateResourceSchema,
  updateResourceTypeSchema,
  type CreateResourceDto,
  type CreateResourceTypeDto,
  type CreateUnavailabilityDto,
  type PutAvailabilityDto,
  type ResourceQueryDto,
  type UpdateResourceDto,
  type UpdateResourceTypeDto,
} from './resources.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const R = COMPANY_PERMISSIONS.RESOURCE_READ;
const W = COMPANY_PERMISSIONS.RESOURCE_WRITE;

@ApiTags('resources')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/resource-types', version: '1' })
export class ResourceTypesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @RequirePermission(R)
  @ApiOperation({ summary: 'Resource types (what a service can require)' })
  list() {
    return this.resources.listTypes();
  }

  @Post()
  @RequirePermission(W)
  @RequiresWrite()
  create(@Body(new ZodValidationPipe(createResourceTypeSchema)) dto: CreateResourceTypeDto) {
    return this.resources.createType(dto);
  }

  @Patch(':typeId')
  @RequirePermission(W)
  @RequiresWrite()
  update(
    @Param('typeId', uuidParam) typeId: string,
    @Body(new ZodValidationPipe(updateResourceTypeSchema)) dto: UpdateResourceTypeDto,
  ) {
    return this.resources.updateType(typeId, dto);
  }
}

@ApiTags('resources')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/resources', version: '1' })
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @RequirePermission(R)
  @ApiOperation({ summary: 'Rooms, chairs and equipment' })
  list(@Query(new ZodValidationPipe(resourceQuerySchema)) query: ResourceQueryDto) {
    return this.resources.list(query);
  }

  @Post()
  @RequirePermission(W)
  @RequiresWrite()
  create(@Body(new ZodValidationPipe(createResourceSchema)) dto: CreateResourceDto) {
    return this.resources.create(dto);
  }

  @Get(':resourceId')
  @RequirePermission(R)
  find(@Param('resourceId', uuidParam) resourceId: string) {
    return this.resources.find(resourceId);
  }

  @Patch(':resourceId')
  @RequirePermission(W)
  @RequiresWrite()
  update(
    @Param('resourceId', uuidParam) resourceId: string,
    @Body(new ZodValidationPipe(updateResourceSchema)) dto: UpdateResourceDto,
  ) {
    return this.resources.update(resourceId, dto);
  }

  @Delete(':resourceId')
  @RequirePermission(W)
  @RequiresWrite()
  remove(@Param('resourceId', uuidParam) resourceId: string) {
    return this.resources.remove(resourceId);
  }

  @Get(':resourceId/availability')
  @RequirePermission(R)
  @ApiOperation({ summary: 'Weekly windows when it may be booked (none = the branch’s hours)' })
  getAvailability(@Param('resourceId', uuidParam) resourceId: string) {
    return this.resources.getAvailability(resourceId);
  }

  @Put(':resourceId/availability')
  @RequirePermission(W)
  @RequiresWrite()
  @ApiOperation({ summary: 'Replace its weekly windows; [] = follow the branch’s hours' })
  putAvailability(
    @Param('resourceId', uuidParam) resourceId: string,
    @Body(new ZodValidationPipe(putAvailabilitySchema)) dto: PutAvailabilityDto,
  ) {
    return this.resources.putAvailability(resourceId, dto);
  }

  @Get(':resourceId/unavailability')
  @RequirePermission(R)
  listUnavailability(@Param('resourceId', uuidParam) resourceId: string) {
    return this.resources.listUnavailability(resourceId);
  }

  @Post(':resourceId/unavailability')
  @RequirePermission(W)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Mark it unavailable for a period (maintenance, out of service…)',
    description: 'Refused over booked appointments (listed), unless `allowConflicts: true`.',
  })
  addUnavailability(
    @Param('resourceId', uuidParam) resourceId: string,
    @Body(new ZodValidationPipe(createUnavailabilitySchema)) dto: CreateUnavailabilityDto,
  ) {
    return this.resources.addUnavailability(resourceId, dto);
  }

  @Delete(':resourceId/unavailability/:unavailabilityId')
  @RequirePermission(W)
  @RequiresWrite()
  removeUnavailability(
    @Param('resourceId', uuidParam) resourceId: string,
    @Param('unavailabilityId', uuidParam) unavailabilityId: string,
  ) {
    return this.resources.removeUnavailability(resourceId, unavailabilityId);
  }
}

@Module({
  imports: [DatabaseModule, SubscriptionsModule],
  controllers: [ResourceTypesController, ResourcesController],
  providers: [ResourcesService, ResourceRepository],
})
export class ResourcesModule {}
