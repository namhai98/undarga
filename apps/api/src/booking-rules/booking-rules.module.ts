import { Body, Controller, Get, Module, Patch } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { DatabaseModule } from '../database/database.module';
import { RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import {
  BookingSettingsService,
  updateBookingSettingsSchema,
  type UpdateBookingSettingsDto,
} from './booking-settings.service';

@ApiTags('booking settings')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/booking-settings', version: '1' })
export class BookingSettingsController {
  constructor(private readonly settings: BookingSettingsService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'The company’s booking rules',
    description:
      'Minimum notice, advance window, cancellation deadline and rescheduling rules. They apply ' +
      'to staff booking, the public booking page, rescheduling and recurring series. Branches ' +
      'and services may override notice, advance window and cancellation deadline.',
  })
  async find() {
    return this.settings.find();
  }

  @Patch()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'Change the booking rules' })
  async update(
    @Body(new ZodValidationPipe(updateBookingSettingsSchema)) dto: UpdateBookingSettingsDto,
  ) {
    return this.settings.update(dto);
  }
}

/** Booking rules: resolution (booking-rules.ts, plain functions) and their settings API. */
@Module({
  imports: [DatabaseModule],
  controllers: [BookingSettingsController],
  providers: [BookingSettingsService],
})
export class BookingRulesModule {}
