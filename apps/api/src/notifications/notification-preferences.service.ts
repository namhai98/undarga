import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ResourceNotFoundError } from '../common/errors';
import type { TenantTx } from '../database/tenant-prisma.service';
import { NotificationTemplateRepository } from './notification.repositories';
import { NotificationProviderRegistry } from './providers/provider.registry';
import type { CustomerPreferencesDto } from './dto/notification.dto';

const CHANNELS: Array<{ key: 'email' | 'sms' | 'push'; channel: NotificationChannel }> = [
  { key: 'email', channel: 'EMAIL' },
  { key: 'sms', channel: 'SMS' },
  { key: 'push', channel: 'PUSH' },
];

/**
 * A customer's channel choices: email, SMS, push — on or off for everything.
 *
 * Opt-OUT: no row means on. Stored as `notification_preference` rows with
 * `type = NULL` (all types); the dispatcher also honours per-type rows, which
 * nothing on screen writes yet. Staff set these on the customer's page when a
 * customer asks — there is no customer-facing account to do it from.
 *
 * The response says which channels the customer can actually be reached on,
 * without repeating the addresses themselves.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    // Only for its tenant-scoped transaction; the rows touched are the
    // customer's and their preferences.
    private readonly scoped: NotificationTemplateRepository,
    private readonly providers: NotificationProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  async get(customerId: string) {
    return this.scoped.transaction(async (tx, companyId) => this.read(tx, companyId, customerId));
  }

  async update(customerId: string, input: CustomerPreferencesDto) {
    const { before, after } = await this.scoped.transaction(async (tx, companyId) => {
      const before = await this.read(tx, companyId, customerId);

      for (const { key, channel } of CHANNELS) {
        const value = input[key];
        if (value === undefined) continue;
        // `type IS NULL` rows cannot be addressed through the compound unique
        // (NULLs are distinct), hence find-then-write.
        const existing = await tx.notificationPreference.findFirst({
          where: { companyId, subjectType: 'CUSTOMER', subjectId: customerId, channel, type: null },
          select: { id: true },
        });
        if (existing) {
          await tx.notificationPreference.update({
            where: { id: existing.id },
            data: { isEnabled: value },
          });
        } else {
          await tx.notificationPreference.create({
            data: {
              companyId,
              subjectType: 'CUSTOMER',
              subjectId: customerId,
              channel,
              type: null,
              isEnabled: value,
            },
          });
        }
      }

      return { before, after: await this.read(tx, companyId, customerId) };
    });

    await this.audit.record({
      action: 'customer.notification_preferences_updated',
      resourceType: 'company_customer',
      resourceId: customerId,
      before: before.enabled,
      after: after.enabled,
    });

    return after;
  }

  private async read(tx: TenantTx, companyId: string, customerId: string) {
    // 404 for another company's customer, exactly as for one that never existed.
    const customer = await tx.companyCustomer.findFirst({
      where: { id: customerId, companyId, deletedAt: null },
      select: { id: true, email: true, phone: true },
    });
    if (!customer) throw new ResourceNotFoundError('CompanyCustomer', customerId);

    const rows = await tx.notificationPreference.findMany({
      where: { companyId, subjectType: 'CUSTOMER', subjectId: customerId, type: null },
      select: { channel: true, isEnabled: true },
    });
    const off = new Set(rows.filter((r) => !r.isEnabled).map((r) => r.channel));

    return {
      customerId,
      enabled: {
        email: !off.has('EMAIL'),
        sms: !off.has('SMS'),
        push: !off.has('PUSH'),
      },
      /** Whether there is a deliverable address on file. Push has no device registry yet. */
      reachable: {
        email: !!customer.email && this.providers.isValidAddress('EMAIL', customer.email),
        sms: !!customer.phone && this.providers.isValidAddress('SMS', customer.phone),
        push: false,
      },
    };
  }
}
