import { Injectable, Logger } from '@nestjs/common';
import { AppointmentsService } from '../appointments/appointments.service';
import { AvailabilityService } from '../availability/availability.service';
import {
  OnlineBookingUnavailableError,
  SlotUnavailableError,
  TenantNotFoundError,
} from '../common/errors';
import { todayInZone } from '../common/time';
import { CustomersService } from '../customers/customers.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { MembershipService } from '../tenancy/membership/membership.service';
import { PromotionsService } from '../promotions/promotions.service';
import type {
  CreatePublicBookingDto,
  PublicAvailabilityQueryDto,
  PublicPromotionPreviewDto,
} from './dto/public-booking.dto';
import { PublicCatalogRepository } from './public-catalog.repository';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/**
 * The public booking page's backend: a thin, anonymous front door onto the
 * engines that already exist.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE DECIDES WHAT IS FREE OR WHAT IS A VALID BOOKING
 * ---------------------------------------------------------------------------
 *
 * Availability comes from AvailabilityService with `publicOnly: true`. Bookings
 * go through AppointmentsService.book() — the same resolve, availability check,
 * advisory lock and exclusion constraint the staff endpoint uses. Customers are
 * matched or created by CustomersService. This file only adds what is specific
 * to an anonymous caller: which company the URL names, what it may read, and
 * what it is told.
 *
 * ---------------------------------------------------------------------------
 * HOW AN ANONYMOUS REQUEST GETS A TENANT
 * ---------------------------------------------------------------------------
 *
 * The route is `@Public()`, so TenantGuard does nothing. Each call resolves the
 * slug through TenantDirectoryService, asks MembershipService for a
 * permission-less public context (ACTIVE companies only), and runs as the
 * SYSTEM actor `public-booking` inside it. Every query then runs under RLS for
 * exactly that company — a branch, service or employee id from another tenant
 * matches nothing and is a 404, the same as a made-up one.
 *
 * The actor is SYSTEM rather than CUSTOMER on purpose: a visitor who typed a
 * phone number has not proved they are that customer, and the audit trail
 * should not say they did.
 */
@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);

  constructor(
    private readonly directory: TenantDirectoryService,
    private readonly memberships: MembershipService,
    private readonly context: RequestContextService,
    private readonly catalog: PublicCatalogRepository,
    private readonly availability: AvailabilityService,
    private readonly customers: CustomersService,
    private readonly appointments: AppointmentsService,
    private readonly promotions: PromotionsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  getCompany(slug: string) {
    return this.inCompany(slug, () => this.catalog.company());
  }

  getServices(slug: string, branchId: string) {
    return this.inCompany(slug, () => this.catalog.services(branchId));
  }

  getEmployees(slug: string, branchId: string, serviceId: string) {
    return this.inCompany(slug, () => this.catalog.employees(branchId, serviceId));
  }

  getAvailability(slug: string, query: PublicAvailabilityQueryDto) {
    return this.inCompany(slug, async () => {
      // Public-definition check first: a draft service must be a 404 here, not
      // the 409 SERVICE_NOT_BOOKABLE the staff endpoint gives.
      await this.catalog.assertBookable(query.branchId, query.serviceId, query.employeeId);

      const day = await this.availability.getDay(query, { publicOnly: true });

      // Buffers, reserved windows and resource ids are the business's own
      // arithmetic; a visitor needs the times and who could take them.
      return {
        date: day.date,
        timezone: day.timezone,
        durationMin: day.serviceDurationMin,
        unavailableReason: day.unavailableReason,
        slots: day.slots.map((s) => ({
          startAt: s.startAt,
          endAt: s.endAt,
          employeeIds: s.employeeIds,
        })),
      };
    });
  }

  /**
   * Preview a code for a booking not yet made. The public-definition check
   * comes first, so a private service or another tenant's id is a 404 here
   * exactly as everywhere else on the public page. Staff-only fields (usage
   * counts, targeting lists) are not echoed back.
   */
  previewPromotion(slug: string, input: PublicPromotionPreviewDto) {
    return this.inCompany(slug, async () => {
      await this.catalog.assertBookable(input.branchId, input.serviceId, input.employeeId);
      const preview = await this.promotions.validateCode(input, { publicOnly: true });
      return {
        valid: preview.valid,
        reason: preview.reason,
        message: preview.message,
        originalMinor: preview.originalMinor,
        discountMinor: preview.discountMinor,
        finalMinor: preview.finalMinor,
        currencyCode: preview.currencyCode,
        promotion: preview.promotion
          ? { name: preview.promotion.name, code: preview.promotion.code }
          : null,
      };
    });
  }

  book(slug: string, input: CreatePublicBookingDto) {
    return this.inCompany(slug, async () => {
      const branch = await this.catalog.assertBookable(
        input.branchId,
        input.serviceId,
        input.employeeId,
      );

      // Cheap pre-check before a customer record is written, so a stale slot
      // does not leave behind a customer who never booked. book() re-checks
      // under a lock; this only avoids the common case.
      const startsAt = new Date(input.startsAt);
      const day = await this.availability.getDay(
        {
          branchId: input.branchId,
          serviceId: input.serviceId,
          date: todayInZone(branch.timezone, startsAt),
          ...(input.employeeId ? { employeeId: input.employeeId } : {}),
        },
        { publicOnly: true },
      );
      if (!day.slots.some((s) => Date.parse(s.startAt) === startsAt.getTime())) {
        throw new SlotUnavailableError({
          reason: day.unavailableReason ?? 'NOT_OFFERED',
          startsAt: startsAt.toISOString(),
        });
      }

      const customer = await this.customers.findOrCreateForBooking({
        firstName: input.customer.firstName,
        lastName: input.customer.lastName ?? null,
        phone: input.customer.phone,
        email: input.customer.email ?? null,
      });
      if (customer.status !== 'ACTIVE') throw new OnlineBookingUnavailableError();

      const booked = await this.appointments.book(
        {
          branchId: input.branchId,
          serviceId: input.serviceId,
          customerId: customer.id,
          employeeId: input.employeeId,
          startsAt: input.startsAt,
          source: 'ONLINE',
          customerNote: input.note ?? null,
          internalNote: null,
          promotionCode: input.promotionCode,
        },
        { publicOnly: true },
      );

      this.logger.log(
        `Online booking ${booked.appointmentNumber} (${customer.reused ? 'existing' : 'new'} customer)`,
      );

      // The confirmation. No internal ids: the appointment number is the
      // reference a customer quotes, and whether their contact details matched
      // an existing record is not something an anonymous response reveals.
      return {
        appointmentNumber: booked.appointmentNumber,
        status: booked.status,
        startsAt: booked.startsAt,
        endsAt: booked.endsAt,
        timezone: booked.timezone,
        branch: { name: branch.name, address: branch.address, phone: branch.phone },
        service: { name: booked.service.name, durationMin: booked.service.durationMin },
        employee: booked.employee ? { name: booked.employee.name } : null,
        price: {
          originalMinor: booked.subtotalMinor,
          discountMinor: booked.discountMinor,
          amountMinor: booked.totalMinor,
          currencyCode: booked.currencyCode,
        },
        promotion: booked.promotion,
        customer: { firstName: input.customer.firstName },
      };
    });
  }

  /**
   * Resolve the slug and run `fn` as the public-booking system actor inside
   * that company. Unknown, suspended, cancelled or not-yet-live companies are
   * all the same 404 (MembershipService.authorizePublic).
   */
  private async inCompany<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const companyId = await this.directory.findCompanyIdBySlug(slug);
    if (!companyId) throw new TenantNotFoundError();

    const tenant = await this.memberships.authorizePublic(companyId);
    // A plan without online booking — or an expired subscription — has no
    // public page: the same 404 as a company that is not live.
    const entitlements = await this.entitlements.forCompany(companyId);
    if (!this.entitlements.canUse(entitlements, 'ONLINE_BOOKING')) throw new TenantNotFoundError();
    return this.context.runAsSystem(
      'public-booking',
      tenant,
      fn,
      this.context.requestId,
    );
  }
}
