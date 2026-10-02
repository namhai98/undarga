import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { CustomersService } from './customers.service';
import {
  createCustomerSchema,
  customerAppointmentQuerySchema,
  customerQuerySchema,
  updateCustomerSchema,
  type CreateCustomerDto,
  type CustomerAppointmentQueryDto,
  type CustomerQueryDto,
  type UpdateCustomerDto,
} from './dto/customer.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * The people a company books work for.
 *
 * ---------------------------------------------------------------------------
 * ONE COMPANY'S RECORD OF A PERSON, NOT THE PERSON
 * ---------------------------------------------------------------------------
 *
 * These endpoints operate on `company_customer` — what THIS company knows.
 * The same human may exist in another tenant as a completely separate row with
 * a different name spelling, different notes and different consent. That is
 * deliberate, and it is why the same phone number is legal in two companies
 * and refused twice within one.
 *
 * ---------------------------------------------------------------------------
 * `customer:read` COVERS EVERYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * `customer:note:read:private` and `customer:export` already exist in the
 * permission catalogue and are NOT used by this module: the first gates the
 * separate `company_customer_note` table, the second gates bulk download.
 * Neither is built. Using either here would silently change what those keys
 * mean before the features that need them exist.
 */
@ApiTags('customers')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/customers', version: '1' })
@AllowPlatformAccess()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({
    summary: 'List customers',
    description:
      'Search matches first name, last name, email and phone, all in SQL. A phone term is ' +
      'normalised the same way stored numbers are, so “+976 9911 2233” finds “+97699112233”. ' +
      'Soft-deleted customers are never returned.',
  })
  async list(@Query(new ZodValidationPipe(customerQuerySchema)) query: CustomerQueryDto) {
    return this.customers.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a customer',
    description:
      'At least one of phone or email is required — a customer with neither is unreachable ' +
      'and unfindable. Both are normalised before storage and both are unique within the ' +
      'company, so an obvious duplicate is refused rather than silently created.',
  })
  @ApiResponse({ status: 201, description: 'Created.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED.' })
  @ApiResponse({
    status: 409,
    description:
      'CONFLICT — `details.field` is "email" or "phone", and `details.existingCustomerId` ' +
      'points at the record that already holds it.',
  })
  async create(@Body(new ZodValidationPipe(createCustomerSchema)) dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @Get(':customerId')
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({
    summary: 'One customer',
    description:
      'Includes the denormalised visit statistics. Those are projections of the appointment ' +
      'and payment tables and are not writable through this API.',
  })
  @ApiResponse({ status: 404, description: 'Not yours, or does not exist — indistinguishable.' })
  async find(@Param('customerId', uuidParam) customerId: string) {
    return this.customers.findById(customerId);
  }

  @Patch(':customerId')
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Update a customer',
    description:
      'Strict schema — `companyId` and the visit statistics are refused. Contact uniqueness is ' +
      'rechecked only for a field that actually changed, so re-saving a form does not collide ' +
      'the customer with themselves.',
  })
  async update(
    @Param('customerId', uuidParam) customerId: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) dto: UpdateCustomerDto,
  ) {
    return this.customers.update(customerId, dto);
  }

  @Delete(':customerId')
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate a customer',
    description:
      'Soft delete. Appointments, payments and invoices reference the row, so it stays and ' +
      'history keeps resolving. Both uniqueness indexes ignore deleted rows, so the phone and ' +
      'email become available again — which is what somebody deleted by mistake needs when ' +
      'they walk back in.',
  })
  async remove(@Param('customerId', uuidParam) customerId: string): Promise<void> {
    await this.customers.remove(customerId);
  }

  @Get(':customerId/appointments')
  @RequirePermission(COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY)
  @ApiOperation({
    summary: 'This customer’s appointment history',
    description:
      'Read-only, newest first. Gated on `appointment:read:any` rather than `customer:read`: ' +
      'seeing a customer record is a different decision from seeing everything they have ever ' +
      'booked, and an EMPLOYEE role holds the first but not the second.',
  })
  async listAppointments(
    @Param('customerId', uuidParam) customerId: string,
    @Query(new ZodValidationPipe(customerAppointmentQuerySchema))
    query: CustomerAppointmentQueryDto,
  ) {
    return this.customers.listAppointments(customerId, query);
  }
}
