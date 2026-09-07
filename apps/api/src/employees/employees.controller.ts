import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { EmployeesService } from './employees.service';
import {
  assignBranchSchema,
  assignServiceSchema,
  createEmployeeSchema,
  employeeQuerySchema,
  linkEmployeeAccountSchema,
  updateEmployeeSchema,
  type AssignBranchDto,
  type AssignServiceDto,
  type CreateEmployeeDto,
  type EmployeeQueryDto,
  type LinkEmployeeAccountDto,
  type UpdateEmployeeDto,
} from './dto/employee.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * The people a company books work against.
 *
 * ---------------------------------------------------------------------------
 * A JOB TITLE IS NOT A ROLE
 * ---------------------------------------------------------------------------
 *
 * `jobTitle: "Senior Stylist"` describes what somebody does for customers.
 * `roleKeys: ["EMPLOYEE"]` decides what they may do in this application. They
 * are stored in different tables, changed by different endpoints and checked by
 * different code, and conflating them is how a promotion accidentally becomes a
 * privilege escalation. Nothing in this module reads a job title to make an
 * authorization decision, and nothing reads a role to render a booking page.
 *
 * ---------------------------------------------------------------------------
 * PERMISSIONS
 * ---------------------------------------------------------------------------
 *
 * `employee:read` and `employee:write` — the catalog's existing granularity.
 * Assignment is `employee:write` rather than a new `employee.branch.assign`:
 * inventing permissions the catalog does not have would mean seeded roles
 * silently lack them, so every company would have to reconfigure before anyone
 * could assign a branch.
 *
 * Linking a login additionally goes through `InvitationsService`, which
 * requires `member:invite` and applies the privilege-escalation check — so
 * granting somebody a login is gated by the same rule as inviting them, because
 * it is the same act.
 */
@ApiTags('employees')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/employees', version: '1' })
@AllowPlatformAccess()
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_READ)
  @ApiOperation({
    summary: 'List employees',
    description:
      'Search, filter and paginate — all in SQL. `branchId` and `serviceId` filter through the ' +
      'join tables, which is the same shape as the question the availability engine will ask.',
  })
  async list(@Query(new ZodValidationPipe(employeeQuerySchema)) query: EmployeeQueryDto) {
    return this.employees.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create an employee',
    description:
      'No login is created. An employee is somebody a customer can book; a user account is a ' +
      'login, and most salons have people in exactly one of those sets. Use ' +
      'POST /:employeeId/account when they need one.',
  })
  @ApiResponse({ status: 201, description: 'Created, with branches assigned if supplied.' })
  @ApiResponse({ status: 404, description: 'A supplied branch is unknown or another company’s.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — the employee code is taken here.' })
  async create(@Body(new ZodValidationPipe(createEmployeeSchema)) dto: CreateEmployeeDto) {
    return this.employees.create(dto);
  }

  @Get(':employeeId')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_READ)
  @ApiOperation({
    summary: 'One employee, with branches, services and account status',
    description:
      'Splits `publicProfile` from `privateProfile`: the first is what a booking page may ' +
      'render, the second holds the work phone and emergency contact and never leaves staff ' +
      'screens.',
  })
  async find(@Param('employeeId', uuidParam) employeeId: string) {
    return this.employees.findById(employeeId);
  }

  @Patch(':employeeId')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update an employee',
    description:
      'Strict schema: `companyId` is refused, so an employee cannot be moved between tenants, ' +
      'and `userAccountId` is refused because linking a login also creates a membership and an ' +
      'invitation and belongs in its own endpoint.',
  })
  async update(
    @Param('employeeId', uuidParam) employeeId: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) dto: UpdateEmployeeDto,
  ) {
    return this.employees.update(employeeId, dto);
  }

  @Delete(':employeeId')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate an employee',
    description:
      'Soft delete. Appointments, promotions and customer preferences reference this person, so ' +
      'the record stays and history keeps resolving. Also sets isBookable false, so a future ' +
      'availability engine cannot offer them even if it forgets to filter on deletedAt.',
  })
  async remove(@Param('employeeId', uuidParam) employeeId: string): Promise<void> {
    await this.employees.remove(employeeId);
  }

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  @Get(':employeeId/branches')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_READ)
  @ApiOperation({ summary: 'Where this employee works' })
  async listBranches(@Param('employeeId', uuidParam) employeeId: string) {
    return this.employees.listBranches(employeeId);
  }

  @Post(':employeeId/branches')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Assign a branch',
    description:
      'The branch must belong to this company — enforced in the service, by the composite ' +
      'foreign keys, and by RLS. The first branch assigned becomes primary, so an employee is ' +
      'never left without a default place.',
  })
  @ApiResponse({ status: 409, description: 'ALREADY_ASSIGNED.' })
  async assignBranch(
    @Param('employeeId', uuidParam) employeeId: string,
    @Body(new ZodValidationPipe(assignBranchSchema)) dto: AssignBranchDto,
  ) {
    return this.employees.assignBranch(employeeId, dto);
  }

  @Delete(':employeeId/branches/:branchId')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Unassign a branch',
    description: 'If the primary is removed, another is promoted rather than leaving none.',
  })
  async removeBranch(
    @Param('employeeId', uuidParam) employeeId: string,
    @Param('branchId', uuidParam) branchId: string,
  ): Promise<void> {
    await this.employees.removeBranch(employeeId, branchId);
  }

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------

  @Get(':employeeId/services')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_READ)
  @ApiOperation({
    summary: 'What this employee performs',
    description:
      'The other half of the employee↔service many-to-many. The service table exists but ' +
      'nothing creates rows in it yet — Service Management is a separate module.',
  })
  async listServices(@Param('employeeId', uuidParam) employeeId: string) {
    return this.employees.listServices(employeeId);
  }

  @Post(':employeeId/services')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Assign a service',
    description:
      'Optional per-employee duration and price overrides. Price is minor units as a STRING — ' +
      'the column is BigInt and money never travels as a JS number here.',
  })
  @ApiResponse({ status: 409, description: 'ALREADY_ASSIGNED.' })
  async assignService(
    @Param('employeeId', uuidParam) employeeId: string,
    @Body(new ZodValidationPipe(assignServiceSchema)) dto: AssignServiceDto,
  ) {
    return this.employees.assignService(employeeId, dto);
  }

  @Delete(':employeeId/services/:serviceId')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  async removeService(
    @Param('employeeId', uuidParam) employeeId: string,
    @Param('serviceId', uuidParam) serviceId: string,
  ): Promise<void> {
    await this.employees.removeService(employeeId, serviceId);
  }

  // ---------------------------------------------------------------------------
  // Login account
  // ---------------------------------------------------------------------------

  @Post(':employeeId/account')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Give this employee a login',
    description:
      'Creates or reuses a user account, links it, adds a company membership and issues an ' +
      'invitation — reusing InvitationsService, so this is gated by member:invite and by the ' +
      'privilege-escalation rule as well. No password is accepted or generated: the response ' +
      'carries a one-time link and the invitee chooses their own.',
  })
  @ApiResponse({ status: 409, description: 'CONFLICT — already linked, or already a member.' })
  @ApiResponse({ status: 403, description: 'PRIVILEGE_ESCALATION_BLOCKED, or no member:invite.' })
  async linkAccount(
    @Param('employeeId', uuidParam) employeeId: string,
    @Body(new ZodValidationPipe(linkEmployeeAccountSchema)) dto: LinkEmployeeAccountDto,
  ) {
    return this.employees.linkAccount(employeeId, dto);
  }

  @Delete(':employeeId/account')
  @RequirePermission(COMPANY_PERMISSIONS.EMPLOYEE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Unlink the login',
    description:
      'Detaches only. The account is not deleted and the company membership is not revoked — ' +
      'the person may belong to other companies, and removing their access is DELETE /members/:id, ' +
      'a different decision with a different permission.',
  })
  async unlinkAccount(@Param('employeeId', uuidParam) employeeId: string): Promise<void> {
    await this.employees.unlinkAccount(employeeId);
  }
}
