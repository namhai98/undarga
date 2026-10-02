import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { DatabaseModule } from '../database/database.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentRepository, AppointmentsService } from './appointments.service';

/**
 * The Appointment Engine.
 *
 * Imports AvailabilityModule so a booking is validated by the same engine that
 * serves the availability endpoint — one definition of "free", not two.
 * AuditModule is global. Exports the service for the future public booking
 * flow and for modules (customers, payments) that today read the appointment
 * table directly.
 */
@Module({
  imports: [DatabaseModule, AvailabilityModule, PromotionsModule, NotificationsModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentRepository],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
