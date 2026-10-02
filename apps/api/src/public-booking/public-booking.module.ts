import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CustomersModule } from '../customers/customers.module';
import { DatabaseModule } from '../database/database.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';
import { PublicCatalogRepository } from './public-catalog.repository';

/**
 * The anonymous booking page.
 *
 * Composes the existing engines rather than re-implementing any: Availability
 * for times, Appointments for the booking, Customers for the record, Tenancy
 * for turning a slug into a (permission-less) tenant. When payments, promotions
 * or notifications arrive they hook in behind AppointmentsService.book(), not
 * here.
 */
@Module({
  imports: [
    DatabaseModule,
    TenancyModule,
    AvailabilityModule,
    AppointmentsModule,
    CustomersModule,
    PromotionsModule,
  ],
  controllers: [PublicBookingController],
  providers: [PublicBookingService, PublicCatalogRepository],
})
export class PublicBookingModule {}
