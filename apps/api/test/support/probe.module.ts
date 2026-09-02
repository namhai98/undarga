import { Controller, Delete, Get, Injectable, Module, Param, Patch } from '@nestjs/common';
import { RequirePermission } from '../../src/authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../../src/authz/permissions';
import {
  AllowPlatformAccess,
  CurrentCompanyId,
  NoTenant,
} from '../../src/tenancy/decorators/tenant.decorators';
import { RequestContextService } from '../../src/tenancy/context/request-context.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../../src/database/tenant-scoped.repository';
import { TenantPrismaService, type TenantTx } from '../../src/database/tenant-prisma.service';

/**
 * TEST-ONLY HTTP surface.
 *
 * Lives in test/, never in src/, and is never imported by AppModule.
 *
 * The brief's isolation tests need endpoints that read and write appointments,
 * customers, payments and reports — but the brief also says not to start those
 * business modules yet. Both hold: these controllers contain no business logic
 * whatsoever. Each one is a single repository call, which is the point. If a
 * cross-tenant read is possible through code this thin, the fault is in the
 * foundation and nowhere else.
 *
 * They are wired with the REAL guards, the REAL tenant context and the REAL
 * repository base class, so what the suite exercises is the shipped
 * foundation, not a mock of it.
 */

interface AppointmentRow {
  id: string;
  companyId: string;
  appointmentNumber: string;
  status: string;
}

@Injectable()
export class ProbeAppointmentRepository extends TenantScopedRepository<AppointmentRow> {
  protected readonly modelName = 'Appointment';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<AppointmentRow> {
    return tx.appointment as unknown as PrismaDelegateLike<AppointmentRow>;
  }
}

interface CustomerRow {
  id: string;
  companyId: string;
  firstName: string;
}

@Injectable()
export class ProbeCustomerRepository extends TenantScopedRepository<CustomerRow> {
  protected readonly modelName = 'CompanyCustomer';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<CustomerRow> {
    return tx.companyCustomer as unknown as PrismaDelegateLike<CustomerRow>;
  }
}

interface PaymentRow {
  id: string;
  companyId: string;
  paymentNumber: string;
}

@Injectable()
export class ProbePaymentRepository extends TenantScopedRepository<PaymentRow> {
  protected readonly modelName = 'Payment';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<PaymentRow> {
    return tx.payment as unknown as PrismaDelegateLike<PaymentRow>;
  }
}

/** Company-inferred routes: the company comes from the authenticated context. */
@Controller({ path: 'probe', version: '1' })
export class ProbeController {
  constructor(
    private readonly appointments: ProbeAppointmentRepository,
    private readonly customers: ProbeCustomerRepository,
    private readonly payments: ProbePaymentRepository,
    private readonly context: RequestContextService,
  ) {}

  @Get('appointments')
  @RequirePermission(COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY)
  @AllowPlatformAccess()
  async listAppointments(@CurrentCompanyId() companyId: string | null) {
    return { companyId, items: await this.appointments.findMany() };
  }

  @Get('appointments/:id')
  @RequirePermission(COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY)
  @AllowPlatformAccess()
  async getAppointment(@Param('id') id: string) {
    return this.appointments.requireById(id);
  }

  @Patch('appointments/:id')
  @RequirePermission(COMPANY_PERMISSIONS.APPOINTMENT_WRITE)
  async updateAppointment(@Param('id') id: string) {
    return this.appointments.requireUpdateById(id, { status: 'CANCELLED' });
  }

  @Delete('appointments/:id')
  @RequirePermission(COMPANY_PERMISSIONS.APPOINTMENT_CANCEL_ANY)
  async deleteAppointment(@Param('id') id: string) {
    await this.appointments.requireDeleteById(id);
    return { deleted: true };
  }

  @Get('customers/:id')
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_READ)
  async getCustomer(@Param('id') id: string) {
    return this.customers.requireById(id);
  }

  @Get('payments/:id')
  @RequirePermission(COMPANY_PERMISSIONS.PAYMENT_READ)
  async getPayment(@Param('id') id: string) {
    return this.payments.requireById(id);
  }

  /**
   * Stands in for a report: an aggregate over company-owned rows. Reports are
   * the endpoint class where a missing tenant filter is least likely to be
   * noticed in review and most damaging when it happens.
   */
  @Get('reports/revenue')
  @RequirePermission(COMPANY_PERMISSIONS.REPORT_REVENUE_READ)
  async revenueReport(@CurrentCompanyId() companyId: string | null) {
    return {
      companyId,
      appointments: await this.appointments.count(),
      payments: await this.payments.count(),
    };
  }

  /**
   * A route that opts out of the tenant guard and then asks for the tenant
   * anyway — i.e. the mistake a developer makes when they add `@NoTenant()` to
   * silence an error they did not understand.
   *
   * It must fail closed, not return every company's rows. Exercised by Test 11.
   */
  @Get('missing-context/appointments')
  @NoTenant()
  async missingContext() {
    return this.appointments.findMany();
  }
}

/**
 * Explicit-company routes: `/api/v1/companies/:companyId/...`.
 *
 * The companyId in the path is validated against the caller's memberships by
 * TenantGuard. This is the shape the brief's nested-resource attack targets.
 */
@Controller({ path: 'companies/:companyId/probe', version: '1' })
export class ProbeCompanyScopedController {
  constructor(private readonly appointments: ProbeAppointmentRepository) {}

  @Get('appointments')
  @RequirePermission(COMPANY_PERMISSIONS.APPOINTMENT_READ_ANY)
  @AllowPlatformAccess()
  async list(@CurrentCompanyId() companyId: string | null) {
    return { companyId, items: await this.appointments.findMany() };
  }
}

@Module({
  controllers: [ProbeController, ProbeCompanyScopedController],
  providers: [ProbeAppointmentRepository, ProbeCustomerRepository, ProbePaymentRepository],
})
export class ProbeModule {}
