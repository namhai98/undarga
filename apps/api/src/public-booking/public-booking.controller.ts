import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../auth/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes';
import {
  companySlugSchema,
  createPublicBookingSchema,
  publicAvailabilityQuerySchema,
  publicPromotionPreviewSchema,
  type CreatePublicBookingDto,
  type PublicAvailabilityQueryDto,
  type PublicPromotionPreviewDto,
} from './dto/public-booking.dto';
import { PublicBookingService } from './public-booking.service';

const slugParam = new ZodValidationPipe(companySlugSchema);
const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * The public booking page's API. No authentication, no membership.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS SAFE WITHOUT A LOGIN
 * ---------------------------------------------------------------------------
 *
 *   - The company comes from the slug, and only an ACTIVE company answers.
 *   - Every read is a named-column projection (PublicCatalogRepository): no
 *     legal, tax, cost, account or customer data is ever loaded.
 *   - Only online-bookable services at online-bookable branches, and only
 *     bookable employees who provide them, are visible or bookable. Anything
 *     else is a 404, indistinguishable from an id that never existed.
 *   - A booking goes through the same Appointment Engine as staff bookings,
 *     re-validated inside a locked transaction and guarded by the database
 *     exclusion constraint. Nothing the page sent is trusted.
 *   - The booking endpoint is rate-limited per client; the reads use the
 *     global ceiling.
 *
 * `@Public()` opts out of the auth and tenant guards only; this module then
 * establishes a permission-less tenant context itself (see
 * PublicBookingService.inCompany).
 */
@ApiTags('public-booking')
@ApiParam({ name: 'companySlug', description: 'The company’s public slug, e.g. `lotus-spa`.' })
@Controller({ path: 'public/companies/:companySlug', version: '1' })
@Public()
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  @Get()
  @ApiOperation({
    summary: 'Company booking page',
    description:
      'Display name, branding and the branches taking online bookings. 404 for an unknown, ' +
      'suspended or not-yet-live company.',
  })
  @ApiResponse({ status: 404, description: 'TENANT_NOT_FOUND.' })
  async company(@Param('companySlug', slugParam) slug: string) {
    return this.booking.getCompany(slug);
  }

  @Get('branches/:branchId/services')
  @ApiOperation({
    summary: 'Services bookable online at a branch',
    description:
      'ACTIVE, online-bookable services offered at this branch, with branch price and duration ' +
      'overrides applied, grouped by visible category. Price is minor units as a string.',
  })
  @ApiResponse({ status: 404, description: 'Unknown branch, or not taking online bookings.' })
  async services(
    @Param('companySlug', slugParam) slug: string,
    @Param('branchId', uuidParam) branchId: string,
  ) {
    return this.booking.getServices(slug, branchId);
  }

  @Get('branches/:branchId/services/:serviceId/employees')
  @ApiOperation({
    summary: 'Staff a customer may choose for a service',
    description:
      'Bookable employees who provide this service at this branch: name and job title only. ' +
      'Choosing one is optional — omit it and the booking takes whoever is free.',
  })
  async employees(
    @Param('companySlug', slugParam) slug: string,
    @Param('branchId', uuidParam) branchId: string,
    @Param('serviceId', uuidParam) serviceId: string,
  ) {
    return this.booking.getEmployees(slug, branchId, serviceId);
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Available times for a service on a date',
    description:
      'From the Availability Engine, restricted to online-bookable services. `date` is read in ' +
      'the branch timezone; each slot is an ISO instant with the branch offset. Buffers and ' +
      'resource allocation are not exposed.',
  })
  @ApiQuery({ name: 'branchId', required: true, format: 'uuid' })
  @ApiQuery({ name: 'serviceId', required: true, format: 'uuid' })
  @ApiQuery({ name: 'date', required: true, example: '2026-10-06' })
  @ApiQuery({ name: 'employeeId', required: false, format: 'uuid' })
  async availability(
    @Param('companySlug', slugParam) slug: string,
    @Query(new ZodValidationPipe(publicAvailabilityQuerySchema)) query: PublicAvailabilityQueryDto,
  ) {
    return this.booking.getAvailability(slug, query);
  }

  @Post('promotions/validate')
  @HttpCode(200)
  // An anonymous endpoint that says whether a code exists is a code-guessing
  // oracle; the limit keeps guessing slow.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Preview a promotion code for a booking',
    description:
      'Ids and the code only — the server prices the service. Returns original, discount and ' +
      'final amounts. An unusable code answers 200 with `valid: false` and a reason. ' +
      'Customer-specific rules are checked again when the booking is made.',
  })
  @ApiResponse({ status: 404, description: 'Unknown company, or a branch/service/employee that is not bookable online.' })
  @ApiResponse({ status: 429, description: 'Too many attempts.' })
  async previewPromotion(
    @Param('companySlug', slugParam) slug: string,
    @Body(new ZodValidationPipe(publicPromotionPreviewSchema)) dto: PublicPromotionPreviewDto,
  ) {
    return this.booking.previewPromotion(slug, dto);
  }

  @Post('bookings')
  // Anonymous and writes rows: the tightest limit in the API after login.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Book an appointment',
    description:
      'Re-validates everything: branch, service, employee, and that `startsAt` is still offered. ' +
      'Reuses the company’s existing customer with the same phone (then email) without ' +
      'modifying it, otherwise creates one. Returns a confirmation with the appointment number — ' +
      'no internal ids.',
  })
  @ApiResponse({ status: 201, description: 'Booked. The confirmation.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — form errors, or an employee who does not provide the service.' })
  @ApiResponse({ status: 404, description: 'Unknown company, branch or service, or not bookable online.' })
  @ApiResponse({ status: 409, description: 'SLOT_UNAVAILABLE / SLOT_TAKEN — pick another time. ONLINE_BOOKING_UNAVAILABLE.' })
  @ApiResponse({ status: 429, description: 'Too many booking attempts.' })
  async book(
    @Param('companySlug', slugParam) slug: string,
    @Body(new ZodValidationPipe(createPublicBookingSchema)) dto: CreatePublicBookingDto,
  ) {
    return this.booking.book(slug, dto);
  }
}
