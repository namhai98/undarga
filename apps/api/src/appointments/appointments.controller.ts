import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { AppointmentsService } from './appointments.service';
import {
  appointmentQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
  statusChangeSchema,
  type AppointmentQueryDto,
  type CancelAppointmentDto,
  type CreateAppointmentDto,
  type RescheduleAppointmentDto,
  type StatusChangeDto,
} from './dto/appointment.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const C = COMPANY_PERMISSIONS;

/**
 * Appointments within a company.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS HARD-DELETED
 * ---------------------------------------------------------------------------
 *
 * There is no DELETE. Cancelling keeps the row with its reason, time and actor;
 * rescheduling cancels the original and creates a successor linked by
 * `rescheduledFromId`. Every status change appends to an append-only history
 * table and to the audit log.
 *
 * ---------------------------------------------------------------------------
 * OWN vs ANY
 * ---------------------------------------------------------------------------
 *
 * Reads accept `appointment:read:own` or `:any`, cancellation `:cancel:own` or
 * `:any`. Holding only `:own` narrows the records to appointments assigned to
 * the caller's own employee profile — another employee's appointment is a 404,
 * exactly as another company's would be.
 *
 * ---------------------------------------------------------------------------
 * ERRORS WORTH HANDLING IN A CLIENT
 * ---------------------------------------------------------------------------
 *
 *   409 SLOT_UNAVAILABLE         the time is not offered — refresh availability
 *   409 SLOT_TAKEN               another booking won the race — refresh, retry
 *   409 INVALID_STATUS_TRANSITION e.g. confirming a cancelled appointment
 *   409 SERVICE_NOT_BOOKABLE     the service is DRAFT / INACTIVE / ARCHIVED
 *   404 RESOURCE_NOT_FOUND       any id not in this company
 */
@ApiTags('appointments')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/appointments', version: '1' })
@AllowPlatformAccess()
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @RequirePermission(C.APPOINTMENT_READ_OWN, C.APPOINTMENT_READ_ANY)
  @ApiOperation({
    summary: 'List appointments',
    description:
      'Filterable by branch, employee, resource, service, customer, status (comma-separated) ' +
      'and a UTC date range on the start time. Ordered by start time. With only ' +
      '`appointment:read:own`, results are narrowed to your own appointments.',
  })
  @ApiQuery({ name: 'branchId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'employeeId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'resourceId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'serviceId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'customerId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, example: 'PENDING,CONFIRMED' })
  @ApiQuery({ name: 'from', required: false, example: '2026-10-01', description: 'YYYY-MM-DD, inclusive.' })
  @ApiQuery({ name: 'to', required: false, example: '2026-10-31', description: 'YYYY-MM-DD, inclusive.' })
  @ApiQuery({ name: 'search', required: false, description: 'Appointment number contains.' })
  @ApiQuery({ name: 'limit', required: false, example: 25 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async list(@Query(new ZodValidationPipe(appointmentQuerySchema)) query: AppointmentQueryDto) {
    return this.appointments.list(query);
  }

  @Post()
  @RequirePermission(C.APPOINTMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Book an appointment',
    description:
      '`startsAt` must be an ISO instant with offset that the availability endpoint currently ' +
      'offers for this branch and service. `endsAt`, price and initial status are derived by the ' +
      'server: end from the service duration, price from service / branch / employee overrides, ' +
      'status CONFIRMED or PENDING per the company’s auto-confirm policy. Omit `employeeId` or ' +
      '`resourceId` to have the first eligible candidate assigned deterministically. The ' +
      'availability check is repeated inside a locked transaction and backed by a database ' +
      'exclusion constraint, so concurrent requests for one slot cannot both succeed.',
  })
  @ApiResponse({ status: 201, description: 'Created. Returns the full appointment.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — malformed input or ids that do not fit together.' })
  @ApiResponse({ status: 404, description: 'A branch, customer, service, employee or resource is not in this company.' })
  @ApiResponse({ status: 409, description: 'SLOT_UNAVAILABLE, SLOT_TAKEN or SERVICE_NOT_BOOKABLE.' })
  async create(@Body(new ZodValidationPipe(createAppointmentSchema)) dto: CreateAppointmentDto) {
    return this.appointments.create(dto);
  }

  @Get(':appointmentId')
  @RequirePermission(C.APPOINTMENT_READ_OWN, C.APPOINTMENT_READ_ANY)
  @ApiOperation({ summary: 'One appointment, with its status history and reschedule links' })
  @ApiResponse({ status: 404, description: 'Unknown, another company’s, or (with :own) not yours.' })
  async find(@Param('appointmentId', uuidParam) appointmentId: string) {
    return this.appointments.findById(appointmentId);
  }

  @Post(':appointmentId/confirm')
  @HttpCode(200)
  @RequirePermission(C.APPOINTMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'PENDING → CONFIRMED' })
  @ApiResponse({ status: 409, description: 'INVALID_STATUS_TRANSITION.' })
  async confirm(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(statusChangeSchema)) dto: StatusChangeDto,
  ) {
    return this.appointments.confirm(appointmentId, dto.reason);
  }

  @Post(':appointmentId/start')
  @HttpCode(200)
  @RequirePermission(C.APPOINTMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'CONFIRMED (or CHECKED_IN) → IN_PROGRESS' })
  @ApiResponse({ status: 409, description: 'INVALID_STATUS_TRANSITION.' })
  async start(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(statusChangeSchema)) dto: StatusChangeDto,
  ) {
    return this.appointments.start(appointmentId, dto.reason);
  }

  @Post(':appointmentId/complete')
  @HttpCode(200)
  @RequirePermission(C.APPOINTMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'IN_PROGRESS → COMPLETED' })
  @ApiResponse({ status: 409, description: 'INVALID_STATUS_TRANSITION.' })
  async complete(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(statusChangeSchema)) dto: StatusChangeDto,
  ) {
    return this.appointments.complete(appointmentId, dto.reason);
  }

  @Post(':appointmentId/no-show')
  @HttpCode(200)
  @RequirePermission(C.APPOINTMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'PENDING / CONFIRMED / CHECKED_IN → NO_SHOW',
    description: 'Only once the start time has passed. Releases the slot.',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — the appointment has not started yet.' })
  @ApiResponse({ status: 409, description: 'INVALID_STATUS_TRANSITION.' })
  async noShow(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(statusChangeSchema)) dto: StatusChangeDto,
  ) {
    return this.appointments.noShow(appointmentId, dto.reason);
  }

  @Post(':appointmentId/cancel')
  @HttpCode(200)
  @RequirePermission(C.APPOINTMENT_CANCEL_OWN, C.APPOINTMENT_CANCEL_ANY)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Cancel an appointment',
    description:
      'A reason is required. Records cancelledAt and who cancelled, and releases the slot for ' +
      'the employee and any resources. The appointment is never deleted.',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — missing reason.' })
  @ApiResponse({ status: 409, description: 'INVALID_STATUS_TRANSITION — already finished or cancelled.' })
  async cancel(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(cancelAppointmentSchema)) dto: CancelAppointmentDto,
  ) {
    return this.appointments.cancel(appointmentId, dto);
  }

  @Post(':appointmentId/reschedule')
  @HttpCode(200)
  @RequirePermission(C.APPOINTMENT_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Move an appointment to another time',
    description:
      'Cancel-and-create in one transaction: the original becomes CANCELLED (reason ' +
      '`RESCHEDULED`) and a new appointment is returned with `rescheduledFrom` pointing back. ' +
      'The new slot is re-validated exactly as a new booking, except that the appointment being ' +
      'moved does not count against itself. Employee and resource default to the original.',
  })
  @ApiResponse({ status: 200, description: 'The NEW appointment.' })
  @ApiResponse({ status: 409, description: 'SLOT_UNAVAILABLE, SLOT_TAKEN or INVALID_STATUS_TRANSITION.' })
  async reschedule(
    @Param('appointmentId', uuidParam) appointmentId: string,
    @Body(new ZodValidationPipe(rescheduleAppointmentSchema)) dto: RescheduleAppointmentDto,
  ) {
    return this.appointments.reschedule(appointmentId, dto);
  }
}
