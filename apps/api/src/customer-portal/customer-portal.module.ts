import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AuthModule } from '../auth/auth.module';
import { AvailabilityModule } from '../availability/availability.module';
import { MailModule } from '../mail/mail.module';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerIdentityRepository } from './customer-identity.repository';
import { CustomerAuthController, CustomerPortalController } from './customer-portal.controller';
import { CustomerPortalService } from './customer-portal.service';

/**
 * The customer portal (docs/CUSTOMER-PORTAL.md): a customer's own bookings,
 * payments, gift cards and profile at one business. Builds on the existing
 * customer token realm, Appointment Engine and Availability Engine.
 */
@Module({
  imports: [AuthModule, MailModule, AppointmentsModule, AvailabilityModule],
  controllers: [CustomerAuthController, CustomerPortalController],
  providers: [CustomerAuthService, CustomerPortalService, CustomerIdentityRepository],
})
export class CustomerPortalModule {}
