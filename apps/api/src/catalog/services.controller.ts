import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { ServicesService } from './services.service';
import {
  assignServiceBranchSchema,
  assignServiceEmployeeSchema,
  createServiceSchema,
  serviceQuerySchema,
  updateServiceSchema,
  type AssignServiceBranchDto,
  type AssignServiceEmployeeDto,
  type CreateServiceDto,
  type ServiceQueryDto,
  type UpdateServiceDto,
} from './dto/catalog.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * What a company sells.
 *
 * ---------------------------------------------------------------------------
 * BOOKABLE IS NOT PUBLIC
 * ---------------------------------------------------------------------------
 *
 *   `status: ACTIVE`         can be booked at all
 *   `isOnlineBookable: true` additionally shown on the public booking site
 *
 * An internal-only service is ACTIVE and not online-bookable. Two columns
 * already express this; a third `isPublic` would create a state nobody could
 * describe.
 *
 * ---------------------------------------------------------------------------
 * `/services/:id/employees` IS THE SAME TABLE AS `/employees/:id/services`
 * ---------------------------------------------------------------------------
 *
 * Both write `employee_service`, whose primary key is
 * `(company_id, employee_id, service_id)`. There is no second junction table:
 * two would drift, and the availability engine would have to pick a winner.
 * Assigning from either direction produces the identical row, and a test
 * asserts it.
 */
@ApiTags('catalog')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/services', version: '1' })
@AllowPlatformAccess()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_READ)
  @ApiOperation({
    summary: 'List services',
    description:
      'All filtering in SQL. `branchId` and `employeeId` filter through the join tables — ' +
      'together they are the intersection the availability engine will need.',
  })
  async list(@Query(new ZodValidationPipe(serviceQuerySchema)) query: ServiceQueryDto) {
    return this.services.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a service',
    description:
      'Duration and buffers are whole minutes so the occupied window is arithmetic. Price is ' +
      'minor units as a STRING — the column is BigInt and money never becomes a JS number here. ' +
      'Currency defaults to the company’s. Branches, employees and resource requirements may ' +
      'all be supplied, and every id is validated before anything is written.',
  })
  @ApiResponse({ status: 201, description: 'Created, with relationships attached.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — bad duration, price or currency.' })
  @ApiResponse({ status: 404, description: 'A supplied category, branch or employee is not yours.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — the service code is taken here.' })
  async create(@Body(new ZodValidationPipe(createServiceSchema)) dto: CreateServiceDto) {
    return this.services.create(dto);
  }

  @Get(':serviceId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_READ)
  @ApiOperation({
    summary: 'One service, with category, branches, employees and resource requirements',
  })
  async find(@Param('serviceId', uuidParam) serviceId: string) {
    return this.services.findById(serviceId);
  }

  @Patch(':serviceId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update a service',
    description:
      'Strict schema — `companyId` is refused. Supplying `resourceRequirements` replaces the ' +
      'whole set, because requirements are read as a set and patching them individually would ' +
      'leave a service half-configured between calls.',
  })
  async update(
    @Param('serviceId', uuidParam) serviceId: string,
    @Body(new ZodValidationPipe(updateServiceSchema)) dto: UpdateServiceDto,
  ) {
    return this.services.update(serviceId, dto);
  }

  @Delete(':serviceId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate a service',
    description:
      'Soft delete. Appointments, promotions and waitlist entries reference it, so the record ' +
      'stays and history keeps resolving. Also clears isOnlineBookable, so a public booking ' +
      'page cannot offer it even if it forgets to filter on deletedAt.',
  })
  async remove(@Param('serviceId', uuidParam) serviceId: string): Promise<void> {
    await this.services.remove(serviceId);
  }

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  @Get(':serviceId/branches')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_READ)
  @ApiOperation({ summary: 'Where this service is offered' })
  async listBranches(@Param('serviceId', uuidParam) serviceId: string) {
    return this.services.listBranches(serviceId);
  }

  @Post(':serviceId/branches')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Offer this service at a branch',
    description:
      'Optional per-branch price and duration overrides. `isAvailable: false` keeps the ' +
      'assignment while temporarily withdrawing the service — a room being refitted.',
  })
  @ApiResponse({ status: 409, description: 'ALREADY_ASSIGNED.' })
  async assignBranch(
    @Param('serviceId', uuidParam) serviceId: string,
    @Body(new ZodValidationPipe(assignServiceBranchSchema)) dto: AssignServiceBranchDto,
  ) {
    return this.services.assignBranch(serviceId, dto);
  }

  @Delete(':serviceId/branches/:branchId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  async removeBranch(
    @Param('serviceId', uuidParam) serviceId: string,
    @Param('branchId', uuidParam) branchId: string,
  ): Promise<void> {
    await this.services.removeBranch(serviceId, branchId);
  }

  // ---------------------------------------------------------------------------
  // Employees
  // ---------------------------------------------------------------------------

  @Get(':serviceId/employees')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_READ)
  @ApiOperation({
    summary: 'Who provides this service',
    description:
      'Reads `employee_service` — the same rows `/employees/:id/services` writes. Being ' +
      'assigned here does NOT mean the person can provide it at every branch: the availability ' +
      'engine will intersect employee↔branch with service↔branch.',
  })
  async listEmployees(@Param('serviceId', uuidParam) serviceId: string) {
    return this.services.listEmployees(serviceId);
  }

  @Post(':serviceId/employees')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Assign an employee to this service',
    description: 'Optional per-employee duration and price overrides — some people are quicker.',
  })
  @ApiResponse({ status: 409, description: 'ALREADY_ASSIGNED.' })
  async assignEmployee(
    @Param('serviceId', uuidParam) serviceId: string,
    @Body(new ZodValidationPipe(assignServiceEmployeeSchema)) dto: AssignServiceEmployeeDto,
  ) {
    return this.services.assignEmployee(serviceId, dto);
  }

  @Delete(':serviceId/employees/:employeeId')
  @RequirePermission(COMPANY_PERMISSIONS.SERVICE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  async removeEmployee(
    @Param('serviceId', uuidParam) serviceId: string,
    @Param('employeeId', uuidParam) employeeId: string,
  ): Promise<void> {
    await this.services.removeEmployee(serviceId, employeeId);
  }
}
