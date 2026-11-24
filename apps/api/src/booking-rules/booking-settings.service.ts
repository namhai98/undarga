import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { loadBookingRules } from './booking-rules';

export const updateBookingSettingsSchema = z
  .object({
    /** No booking may start sooner than this after now (minutes, up to 30 days). */
    minimumBookingNoticeMinutes: z.number().int().min(0).max(43_200).optional(),
    /** No booking more than this many days ahead. */
    maximumAdvanceBookingDays: z.number().int().min(1).max(730).optional(),
    /** Cancelling later than this before the start is a late cancellation. */
    cancellationDeadlineHours: z.number().int().min(0).max(720).optional(),
    /** Whether appointments may be moved at all (staff and customers). */
    reschedulingAllowed: z.boolean().optional(),
    /** Moving later than this is a late change. `null` = the cancellation deadline. */
    rescheduleDeadlineHours: z.number().int().min(0).max(720).nullable().optional(),
    /** Customers' self-service in the portal. */
    allowCustomerCancel: z.boolean().optional(),
    allowCustomerReschedule: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one setting.');
export type UpdateBookingSettingsDto = z.infer<typeof updateBookingSettingsSchema>;

/**
 * The company's booking rules, in the vocabulary the screens use. Stored on
 * company_settings (the columns the availability engine already read);
 * branches may override notice, advance window and cancellation deadline in
 * their own settings, and services in theirs — see booking-rules.ts.
 */
@Injectable()
export class BookingSettingsService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  private get companyId(): string {
    return this.context.requireCompanyId('booking settings');
  }

  async find() {
    const companyId = this.companyId;
    return this.db.run(async (tx) => {
      const row = await tx.companySettings.findFirst({
        where: { companyId },
        select: { rescheduleDeadlineHours: true },
      });
      const rules = await loadBookingRules(tx, companyId, {});
      return toResponse(rules, row?.rescheduleDeadlineHours ?? null);
    }, 'BookingSettings.find');
  }

  async update(input: UpdateBookingSettingsDto) {
    const companyId = this.companyId;
    const data = {
      ...(input.minimumBookingNoticeMinutes !== undefined
        ? { bookingLeadTimeMin: input.minimumBookingNoticeMinutes }
        : {}),
      ...(input.maximumAdvanceBookingDays !== undefined
        ? { maxAdvanceBookingDays: input.maximumAdvanceBookingDays }
        : {}),
      ...(input.cancellationDeadlineHours !== undefined
        ? { cancellationWindowHours: input.cancellationDeadlineHours }
        : {}),
      ...(input.reschedulingAllowed !== undefined
        ? { reschedulingAllowed: input.reschedulingAllowed }
        : {}),
      ...(input.rescheduleDeadlineHours !== undefined
        ? { rescheduleDeadlineHours: input.rescheduleDeadlineHours }
        : {}),
      ...(input.allowCustomerCancel !== undefined
        ? { allowCustomerCancel: input.allowCustomerCancel }
        : {}),
      ...(input.allowCustomerReschedule !== undefined
        ? { allowCustomerReschedule: input.allowCustomerReschedule }
        : {}),
    };
    const { before, after } = await this.db.run(async (tx) => {
      const before = await this.findIn(tx, companyId);
      await tx.companySettings.upsert({
        where: { companyId },
        create: { companyId, ...data },
        update: data,
      });
      return { before, after: await this.findIn(tx, companyId) };
    }, 'BookingSettings.update');
    await this.audit.record({
      action: 'company.booking_settings_updated',
      resourceType: 'company_settings',
      resourceId: companyId,
      before,
      after,
    });
    return after;
  }

  private async findIn(tx: TenantTx, companyId: string) {
    const row = await tx.companySettings.findFirst({
      where: { companyId },
      select: { rescheduleDeadlineHours: true },
    });
    return toResponse(
      await loadBookingRules(tx, companyId, {}),
      row?.rescheduleDeadlineHours ?? null,
    );
  }
}

function toResponse(
  rules: Awaited<ReturnType<typeof loadBookingRules>>,
  rescheduleDeadlineHours: number | null,
) {
  return {
    minimumBookingNoticeMinutes: rules.minimumNoticeMinutes,
    maximumAdvanceBookingDays: rules.maximumAdvanceDays,
    cancellationDeadlineHours: rules.cancellationDeadlineHours,
    reschedulingAllowed: rules.reschedulingAllowed,
    /** As stored: null means "same as the cancellation deadline". */
    rescheduleDeadlineHours,
    /** What actually applies. */
    effectiveRescheduleDeadlineHours: rules.rescheduleDeadlineHours,
    allowCustomerCancel: rules.allowCustomerCancel,
    allowCustomerReschedule: rules.allowCustomerReschedule,
  };
}
