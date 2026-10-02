import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantTx } from '../database/tenant-prisma.service';
import {
  DELIVERY_CHANNELS,
  TEMPLATE_VARIABLES,
  effectiveEventChannels,
  notificationCatalog,
} from './notification-templates';
import { NotificationTemplateRepository } from './notification.repositories';
import type { UpdateNotificationSettingsDto } from './dto/notification.dto';

const SELECT = {
  emailNotificationsEnabled: true,
  smsNotificationsEnabled: true,
  pushNotificationsEnabled: true,
  remindersEnabled: true,
  reminderOffsetsMinutes: true,
  notificationEventChannels: true,
} as const;

type SettingsRow = Prisma.CompanySettingsGetPayload<{ select: typeof SELECT }>;

/**
 * A company's notification switches: which channels are on, when reminders go
 * out, and which channels each kind of message uses by default.
 *
 * Lives on `company_settings`, next to the booking rules it sits beside —
 * `reminder_offsets_minutes` was already there.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(
    // Only for its tenant-scoped transaction.
    private readonly settings: NotificationTemplateRepository,
    private readonly audit: AuditService,
  ) {}

  async get() {
    return this.settings.transaction(async (tx, companyId) =>
      toResponse(await this.load(tx, companyId)),
    );
  }

  async update(input: UpdateNotificationSettingsDto) {
    const { before, after } = await this.settings.transaction(async (tx, companyId) => {
      const current = await this.load(tx, companyId);

      const eventChannels = input.eventChannels
        ? { ...effectiveEventChannels(current.notificationEventChannels), ...input.eventChannels }
        : undefined;

      const data = {
        ...(input.channels?.email !== undefined
          ? { emailNotificationsEnabled: input.channels.email }
          : {}),
        ...(input.channels?.sms !== undefined
          ? { smsNotificationsEnabled: input.channels.sms }
          : {}),
        ...(input.channels?.push !== undefined
          ? { pushNotificationsEnabled: input.channels.push }
          : {}),
        ...(input.reminders?.enabled !== undefined
          ? { remindersEnabled: input.reminders.enabled }
          : {}),
        ...(input.reminders?.offsetsMinutes
          ? { reminderOffsetsMinutes: [...input.reminders.offsetsMinutes].sort((a, b) => b - a) }
          : {}),
        ...(eventChannels
          ? { notificationEventChannels: eventChannels as Prisma.InputJsonValue }
          : {}),
      };

      const updated = await tx.companySettings.upsert({
        where: { companyId },
        create: { companyId, ...data },
        update: data,
        select: SELECT,
      });
      return { before: toResponse(current), after: toResponse(updated) };
    });

    await this.audit.record({
      action: 'notification_settings.updated',
      resourceType: 'company_settings',
      before: {
        channels: before.channels,
        reminders: before.reminders,
        eventChannels: before.eventChannels,
      },
      after: {
        channels: after.channels,
        reminders: after.reminders,
        eventChannels: after.eventChannels,
      },
    });

    return after;
  }

  private async load(tx: TenantTx, companyId: string): Promise<SettingsRow> {
    const row = await tx.companySettings.findFirst({ where: { companyId }, select: SELECT });
    // Every provisioned company has a row; the defaults cover one that somehow
    // does not, and the first update creates it.
    return (
      row ?? {
        emailNotificationsEnabled: true,
        smsNotificationsEnabled: true,
        pushNotificationsEnabled: true,
        remindersEnabled: true,
        reminderOffsetsMinutes: [1440, 120],
        notificationEventChannels: null,
      }
    );
  }
}

function toResponse(row: SettingsRow) {
  return {
    channels: {
      email: row.emailNotificationsEnabled,
      sms: row.smsNotificationsEnabled,
      push: row.pushNotificationsEnabled,
    },
    reminders: {
      enabled: row.remindersEnabled,
      offsetsMinutes: [...row.reminderOffsetsMinutes].sort((a, b) => b - a),
    },
    eventChannels: effectiveEventChannels(row.notificationEventChannels),
    catalog: notificationCatalog(),
    channelsAvailable: DELIVERY_CHANNELS,
    variables: TEMPLATE_VARIABLES,
  };
}
