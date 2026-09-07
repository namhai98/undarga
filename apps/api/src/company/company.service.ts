import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import type {
  DeactivateCompanyDto,
  UpdateCompanyBrandingDto,
  UpdateCompanyDto,
  UpdateCompanySettingsDto,
} from './dto/company.dto';

/**
 * The company a caller is currently inside.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO REPOSITORY CLASS HERE
 * ---------------------------------------------------------------------------
 *
 * `TenantScopedRepository` merges `companyId` into every filter, and `company`
 * has no `companyId` column — its tenant key is `id`. Extending that base class
 * would produce `where: { id, companyId }` against a table with no such field.
 *
 * Isolation is not weaker for it, it is enforced one layer down: the RLS policy
 * on `company` matches `id = current_setting('app.current_company_id')`, so on
 * the tenant connection a query for another company's row returns nothing no
 * matter what id is passed. The id is taken from the request context anyway, so
 * a caller never supplies it — the route parameter was already validated
 * against their memberships by TenantGuard.
 *
 * ---------------------------------------------------------------------------
 * CACHE INVALIDATION IS PART OF CORRECTNESS
 * ---------------------------------------------------------------------------
 *
 * `TenantDirectoryService` caches the company row for TENANT_CACHE_TTL_SECONDS,
 * and `CurrentCompany.defaultTimezoneName` and `.status` are read from that
 * cache on every request. Any write that touches either must invalidate, or the
 * change appears to take up to a minute — and in the case of status, a
 * cancelled company keeps working for that minute.
 */
@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
    private readonly directory: TenantDirectoryService,
    private readonly audit: AuditService,
  ) {}

  private get companyId(): string {
    return this.context.requireCompanyId('company management');
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  async findCurrent() {
    const company = await this.db.run(
      (tx) => tx.company.findFirst({ where: { id: this.companyId, deletedAt: null } }),
      'Company.findCurrent',
    );

    if (!company) throw new ResourceNotFoundError('Company', this.companyId);
    return toCompanyResponse(company);
  }

  async update(input: UpdateCompanyDto) {
    const companyId = this.companyId;

    const { before, after } = await this.db.run(async (tx) => {
      const before = await tx.company.findFirst({ where: { id: companyId, deletedAt: null } });
      if (!before) throw new ResourceNotFoundError('Company', companyId);

      if (input.defaultTimezoneName && input.defaultTimezoneName !== before.defaultTimezoneName) {
        await assertTimezoneExists(tx, input.defaultTimezoneName);
      }

      const after = await tx.company.update({ where: { id: companyId }, data: input });
      return { before, after };
    }, 'Company.update');

    // The directory caches `defaultTimezoneName`, and CurrentCompany is built
    // from that cache on every request.
    this.directory.invalidate(companyId, after.slug);

    await this.audit.record({
      action: 'company.updated',
      resourceType: 'company',
      resourceId: companyId,
      before: auditableCompany(before),
      after: auditableCompany(after),
    });

    return toCompanyResponse(after);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Deactivate, never delete.
   *
   * A company owns appointments, payments, invoices, ledger entries and an
   * audit trail. Deleting the row would cascade through history that is
   * financial and, in the case of the ledger, legally required — and there is
   * no undo. So `CANCELED` plus a `purgeAfter` date is the whole of it: the
   * data stays, the tenant stops working, and an actual purge is a separate,
   * deliberate operation that does not exist yet.
   *
   * `deletedAt` is deliberately NOT set. Every company-owned table's RLS policy
   * matches on `company_id` alone, so soft-deleting the parent does not hide
   * the children — it would only make the company invisible to its own
   * administrators while its data stayed queryable, which is the worst of both.
   */
  async deactivate(input: DeactivateCompanyDto) {
    const companyId = this.companyId;

    const { before, after } = await this.db.run(async (tx) => {
      const before = await tx.company.findFirst({ where: { id: companyId, deletedAt: null } });
      if (!before) throw new ResourceNotFoundError('Company', companyId);

      if (before.status === 'SUSPENDED') {
        // Suspension is a platform decision, usually non-payment. A company
        // that could lift its own suspension would make it meaningless.
        throw new ConflictError('This company is suspended. Contact support.', {
          field: 'status',
        });
      }

      const after = await tx.company.update({
        where: { id: companyId },
        data: {
          status: 'CANCELED',
          // 90 days before the data is even eligible for purging, so a
          // cancellation made in error is recoverable — by an operator, since
          // the company can no longer reach its own API.
          purgeAfter: new Date(Date.now() + 90 * 86_400_000),
        },
      });

      return { before, after };
    }, 'Company.deactivate');

    // Without this the cancelled company keeps working for up to
    // TENANT_CACHE_TTL_SECONDS.
    this.directory.invalidate(companyId, after.slug);

    await this.audit.record({
      action: 'company.deactivated',
      resourceType: 'company',
      resourceId: companyId,
      before: { status: before.status },
      after: { status: after.status },
      metadata: input.reason ? { reason: input.reason } : undefined,
    });

    this.logger.log(`Company ${companyId} status ${before.status} -> ${after.status}`);

    return toCompanyResponse(after);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async findSettings() {
    const companyId = this.companyId;

    const settings = await this.db.run(
      (tx) => tx.companySettings.findFirst({ where: { companyId } }),
      'CompanySettings.find',
    );

    // Provisioning always creates the row, so an absent one means the company
    // predates that or was made by hand. Surface it rather than inventing
    // defaults that would silently diverge from the schema's.
    if (!settings) throw new ResourceNotFoundError('CompanySettings', companyId);

    return toSettingsResponse(settings);
  }

  async updateSettings(input: UpdateCompanySettingsDto) {
    const companyId = this.companyId;

    const { before, after } = await this.db.run(async (tx) => {
      const before = await tx.companySettings.findFirst({ where: { companyId } });
      if (!before) throw new ResourceNotFoundError('CompanySettings', companyId);

      const after = await tx.companySettings.update({ where: { companyId }, data: input });
      return { before, after };
    }, 'CompanySettings.update');

    await this.audit.record({
      action: 'company.settings_updated',
      resourceType: 'company_settings',
      resourceId: companyId,
      before: toSettingsResponse(before),
      after: toSettingsResponse(after),
    });

    return toSettingsResponse(after);
  }

  // ---------------------------------------------------------------------------
  // Branding
  // ---------------------------------------------------------------------------

  async findBranding() {
    const companyId = this.companyId;

    const branding = await this.db.run(
      (tx) => tx.companyBranding.findFirst({ where: { companyId } }),
      'CompanyBranding.find',
    );

    // Unlike settings, provisioning does NOT create this row — branding is
    // optional and every column has a schema default. Returning the defaults is
    // truthful: it is exactly what the booking page would render.
    return branding ? toBrandingResponse(branding) : DEFAULT_BRANDING;
  }

  async updateBranding(input: UpdateCompanyBrandingDto) {
    const companyId = this.companyId;

    const { before, after } = await this.db.run(async (tx) => {
      const before = await tx.companyBranding.findFirst({ where: { companyId } });

      // Upsert, because the row may genuinely not exist yet.
      const after = await tx.companyBranding.upsert({
        where: { companyId },
        create: { companyId, ...input },
        update: input,
      });

      return { before, after };
    }, 'CompanyBranding.update');

    await this.audit.record({
      action: 'company.branding_updated',
      resourceType: 'company_branding',
      resourceId: companyId,
      before: before ? toBrandingResponse(before) : null,
      after: toBrandingResponse(after),
    });

    return toBrandingResponse(after);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check the reference table before the foreign key does.
 *
 * The FK would catch it, but as an opaque constraint violation the exception
 * filter can only render as a 500. This turns "unknown timezone" into a 400
 * that names the field.
 */
async function assertTimezoneExists(tx: TenantTx, name: string): Promise<void> {
  const timezone = await tx.timezone.findUnique({ where: { name } });
  if (!timezone) {
    throw new ValidationFailedError({ defaultTimezoneName: 'Unknown IANA timezone.' });
  }
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/**
 * Explicit response shapes rather than returning rows.
 *
 * `purgeAfter` and `deletedAt` are internal lifecycle bookkeeping and are
 * omitted — a client has no use for them and they invite being treated as an
 * API contract.
 */
function toCompanyResponse(company: {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  status: string;
  defaultTimezoneName: string;
  currencyCode: string;
  locale: string;
  registrationNumber: string | null;
  taxNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: company.id,
    slug: company.slug,
    legalName: company.legalName,
    displayName: company.displayName,
    status: company.status,
    defaultTimezoneName: company.defaultTimezoneName,
    currencyCode: company.currencyCode,
    locale: company.locale,
    registrationNumber: company.registrationNumber,
    taxNumber: company.taxNumber,
    contactEmail: company.contactEmail,
    contactPhone: company.contactPhone,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

/** The subset worth recording in an audit diff — no timestamps, no ids. */
function auditableCompany(company: Record<string, unknown>) {
  const { displayName, legalName, contactEmail, contactPhone, defaultTimezoneName, locale } =
    company;
  return { displayName, legalName, contactEmail, contactPhone, defaultTimezoneName, locale };
}

function toSettingsResponse(s: {
  slotGranularityMin: number;
  bookingLeadTimeMin: number;
  maxAdvanceBookingDays: number;
  cancellationWindowHours: number;
  holdTtlSeconds: number;
  autoConfirmBookings: boolean;
  allowOnlineBooking: boolean;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  requireDeposit: boolean;
  depositPercentBps: number;
  noShowFeePercentBps: number;
  lateCancelFeePercentBps: number;
  reminderOffsetsMinutes: number[];
  defaultLocale: string;
}) {
  return {
    slotGranularityMin: s.slotGranularityMin,
    bookingLeadTimeMin: s.bookingLeadTimeMin,
    maxAdvanceBookingDays: s.maxAdvanceBookingDays,
    cancellationWindowHours: s.cancellationWindowHours,
    holdTtlSeconds: s.holdTtlSeconds,
    autoConfirmBookings: s.autoConfirmBookings,
    allowOnlineBooking: s.allowOnlineBooking,
    allowCustomerCancel: s.allowCustomerCancel,
    allowCustomerReschedule: s.allowCustomerReschedule,
    requireDeposit: s.requireDeposit,
    depositPercentBps: s.depositPercentBps,
    noShowFeePercentBps: s.noShowFeePercentBps,
    lateCancelFeePercentBps: s.lateCancelFeePercentBps,
    reminderOffsetsMinutes: s.reminderOffsetsMinutes,
    defaultLocale: s.defaultLocale,
  };
}

function toBrandingResponse(b: {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  fontFamily: string | null;
  bookingPageHeadline: string | null;
  bookingPageBlurb: string | null;
  emailFromName: string | null;
  emailReplyTo: string | null;
}) {
  return {
    primaryColor: b.primaryColor,
    accentColor: b.accentColor,
    backgroundColor: b.backgroundColor,
    fontFamily: b.fontFamily,
    bookingPageHeadline: b.bookingPageHeadline,
    bookingPageBlurb: b.bookingPageBlurb,
    emailFromName: b.emailFromName,
    emailReplyTo: b.emailReplyTo,
    // `logoFileId` and friends are absent until the file module exists. Adding
    // them as permanent nulls would advertise an API that does nothing.
  };
}

/** Mirrors the column defaults in schema.prisma. */
const DEFAULT_BRANDING = {
  primaryColor: '#0F6B63',
  accentColor: '#8A5A12',
  backgroundColor: '#FFFFFF',
  fontFamily: null,
  bookingPageHeadline: null,
  bookingPageBlurb: null,
  emailFromName: null,
  emailReplyTo: null,
};
