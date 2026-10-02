import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess } from '../tenancy/decorators/tenant.decorators';
import { AvailabilityService } from './availability.service';
import { availabilityQuerySchema, type AvailabilityQueryDto } from './availability.dto';

/**
 * Bookable slots for a service, at a branch, on a date.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY. IT CREATES NOTHING.
 * ---------------------------------------------------------------------------
 *
 * No appointment, no hold, no reservation — a `GET` that computes and returns.
 * The result is ADVISORY (docs/DATABASE.md §13.1): a slot can be taken between
 * this call and a booking, so the Appointment Engine re-checks under the
 * database exclusion constraint. Nothing here is a guarantee, and nothing here
 * is audited (docs prompt §38 — a read this frequent would drown the log).
 *
 * ---------------------------------------------------------------------------
 * THE IDS ARE NOT TRUSTED
 * ---------------------------------------------------------------------------
 *
 * `companyId` is validated against the caller's memberships by TenantGuard.
 * `branchId`, `serviceId`, `employeeId` and `resourceId` are only ever used
 * inside a filter that also carries the resolved company, so another tenant's
 * id matches nothing — 404 for the branch/service, an empty day for a stray
 * employee or resource.
 */
@ApiTags('availability')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/availability', version: '1' })
@AllowPlatformAccess()
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.AVAILABILITY_READ)
  @ApiOperation({
    summary: 'Bookable slots for a service on a date',
    description:
      'Combines branch hours, closures, employee schedules, breaks, single-date schedule ' +
      'overrides, approved time off, service duration and buffers, resource pools and existing ' +
      'appointments. The `date` is read in the BRANCH timezone; every returned instant is an ' +
      'ISO string with its offset, and `timezone` names the zone. With no `employeeId` the ' +
      'search spans every eligible employee and each slot lists the ones who could take it; ' +
      'likewise for resources. An empty `slots` with `unavailableReason` set means a structural ' +
      'reason (branch closed, service not offered here, nobody rostered); an empty `slots` with ' +
      '`unavailableReason: null` means the day is simply full or outside the booking window.',
  })
  @ApiQuery({ name: 'branchId', required: true, format: 'uuid' })
  @ApiQuery({ name: 'serviceId', required: true, format: 'uuid' })
  @ApiQuery({ name: 'date', required: true, example: '2026-09-15', description: 'YYYY-MM-DD, branch-local.' })
  @ApiQuery({ name: 'employeeId', required: false, format: 'uuid', description: 'Restrict to one employee.' })
  @ApiQuery({ name: 'resourceId', required: false, format: 'uuid', description: 'Restrict to one resource.' })
  @ApiQuery({
    name: 'excludeAppointmentId',
    required: false,
    format: 'uuid',
    description: 'Ignore this appointment’s own reservations — for picking a reschedule slot.',
  })
  @ApiResponse({ status: 200, description: 'The day, with zero or more slots.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — bad uuid or a date that is not YYYY-MM-DD.' })
  @ApiResponse({ status: 404, description: 'Unknown / deleted / another company’s branch or service.' })
  @ApiResponse({ status: 409, description: 'SERVICE_NOT_BOOKABLE — the service is DRAFT, INACTIVE or ARCHIVED.' })
  async getDay(
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQueryDto,
  ) {
    const { excludeAppointmentId, ...day } = query;
    return this.availability.getDay(day, { excludeAppointmentId });
  }
}
