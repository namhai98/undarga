import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import { NotificationContextService } from './notification-context.service';
import {
  defaultTemplate,
  effectiveEventChannels,
  isNotificationType,
  renderTemplate,
  type DeliveryChannel,
} from './notification-templates';
import { NotificationProviderRegistry } from './providers/provider.registry';

/**
 * An outbox row that keeps failing to dispatch is given up on after this many
 * attempts and marked FAILED, rather than retried on every tick forever.
 */
export const MAX_OUTBOX_ATTEMPTS = 5;

const CHANNEL_LABEL: Record<DeliveryChannel, string> = {
  EMAIL: 'email address',
  SMS: 'phone number',
  PUSH: 'device token',
};

/**
 * Outbox rows in, notification rows out.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS STAGE DECIDES
 * ---------------------------------------------------------------------------
 *
 * An event says what HAPPENED. A notification says who is being told, on which
 * channel, with what text. For each channel, in order:
 *
 *   1. Does this type go out on this channel? (company setting, else default)
 *   2. Is the channel switched on for the company?
 *   3. Has the customer turned it off? (notification_preference)
 *   4. Is there an address at all?           — no:  nothing is created
 *   5. Is the address deliverable?           — no:  a CANCELLED row, with why
 *   6. Render the company's active template, or the platform default.
 *
 * Suppressions (1–4) never become rows, so the table is an honest record of
 * what was attempted. An invalid address (5) does, because "why did the
 * customer never get it" deserves an answer on the history screen.
 *
 * ---------------------------------------------------------------------------
 * DEDUPE IS THE WHOLE SAFETY PROPERTY
 * ---------------------------------------------------------------------------
 *
 * `notification.dedupe_key` is unique per company and derived from the event
 * (or, for reminders, from the appointment + offset + start time) and the
 * channel. Replaying an outbox row — which WILL happen, at-least-once being the
 * only cheap guarantee — collides instead of sending a second message.
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly platformDb: PlatformPrismaService,
    private readonly context: NotificationContextService,
    private readonly providers: NotificationProviderRegistry,
  ) {}

  /**
   * Drain a batch of pending outbox rows.
   *
   * Reads on the PLATFORM connection because the outbox is cross-tenant by
   * nature. Each row is then processed inside ITS company's transaction, so
   * every read and write below is tenant-scoped again. `companyId` narrows the
   * batch to one company (the manual run endpoint).
   */
  async dispatchPending(
    options: { limit?: number; companyId?: string } = {},
  ): Promise<{ dispatched: number; failed: number }> {
    const pending = await this.platformDb.outboxEvent.findMany({
      where: { status: 'PENDING', ...(options.companyId ? { companyId: options.companyId } : {}) },
      orderBy: { occurredAt: 'asc' },
      take: options.limit ?? 50,
    });

    let dispatched = 0;
    let failed = 0;

    for (const event of pending) {
      try {
        await this.db.runInCompany(event.companyId, (tx) =>
          this.dispatchOne(tx, event.companyId, event.id, event.type, event.payload),
        );
        await this.platformDb.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });
        dispatched += 1;
      } catch (error) {
        failed += 1;
        const message = (error as Error).message.slice(0, 1000);
        const attempts = event.attempts + 1;
        const givingUp = attempts >= MAX_OUTBOX_ATTEMPTS;
        this.logger.error(
          `Dispatch failed for outbox ${event.id} (${event.type}), attempt ${attempts}` +
            `${givingUp ? ' — giving up' : ''}: ${message}`,
        );
        await this.platformDb.outboxEvent.update({
          where: { id: event.id },
          data: { attempts, lastError: message, ...(givingUp ? { status: 'FAILED' } : {}) },
        });
      }
    }

    return { dispatched, failed };
  }

  /**
   * Turn one event into zero or more notification rows.
   *
   * Zero is a legitimate outcome and not an error: a customer with no contact
   * details, or a company that switched the type off, is told nothing — and
   * treating that as a failure would retry it forever.
   */
  async dispatchOne(
    tx: TenantTx,
    companyId: string,
    eventId: string,
    type: string,
    payload: Prisma.JsonValue,
  ): Promise<number> {
    if (!isNotificationType(type)) return 0;
    const data = asRecord(payload);

    const settings = await tx.companySettings.findFirst({
      where: { companyId },
      select: {
        emailNotificationsEnabled: true,
        smsNotificationsEnabled: true,
        pushNotificationsEnabled: true,
        notificationEventChannels: true,
      },
    });
    const enabled: Record<DeliveryChannel, boolean> = {
      EMAIL: settings?.emailNotificationsEnabled ?? true,
      SMS: settings?.smsNotificationsEnabled ?? true,
      PUSH: settings?.pushNotificationsEnabled ?? true,
    };
    const channels = effectiveEventChannels(settings?.notificationEventChannels)[type].filter(
      (channel) => enabled[channel],
    );
    if (channels.length === 0) return 0;

    const context = await this.context.resolve(tx, companyId, type, data);
    if (!context) return 0;
    const { recipient } = context;

    const [suppressed, templates] = await Promise.all([
      tx.notificationPreference.findMany({
        where: {
          companyId,
          subjectType: 'CUSTOMER',
          subjectId: recipient.id,
          isEnabled: false,
          OR: [{ type: null }, { type }],
        },
        select: { channel: true },
      }),
      tx.notificationTemplate.findMany({
        where: { companyId, key: type, channel: { in: channels }, isActive: true, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, channel: true, subject: true, body: true },
      }),
    ]);
    const blocked = new Set(suppressed.map((row) => row.channel));
    const dedupeBase = typeof data.dedupeBase === 'string' ? data.dedupeBase : eventId;

    let created = 0;

    for (const channel of channels) {
      if (blocked.has(channel)) continue;
      const address = addressFor(channel, recipient);
      if (!address) continue;

      const custom = templates.find((t) => t.channel === channel) ?? null;
      const rendered = renderTemplate(custom ?? defaultTemplate(type, channel), context.variables);
      const valid = this.providers.isValidAddress(channel, address);

      // ON CONFLICT DO NOTHING rather than catching a unique violation: a
      // violation aborts the whole Postgres transaction, and the next channel's
      // insert would then fail too.
      const { count } = await tx.notification.createMany({
        skipDuplicates: true,
        data: [
          {
            companyId,
            templateId: custom?.id ?? null,
            channel,
            type,
            status: valid ? 'PENDING' : 'CANCELLED',
            recipientType: 'CUSTOMER',
            recipientId: recipient.id,
            recipientAddress: address.slice(0, 320),
            // SMS has no subject; push uses it as the title.
            subject: channel === 'SMS' ? null : rendered.subject,
            body: rendered.body,
            bodyPreview: rendered.body.slice(0, 512),
            // Ids only. Names and times are in the rendered text already.
            payload: pickIds(data),
            appointmentId: context.appointmentId,
            scheduledFor: new Date(),
            dedupeKey: `${dedupeBase}:${channel}`.slice(0, 160),
            ...(valid
              ? {}
              : { failureReason: `Invalid ${CHANNEL_LABEL[channel]}.`, failedAt: new Date() }),
          },
        ],
      });
      if (count === 0) {
        this.logger.debug(`Skipped duplicate ${channel} notification for ${dedupeBase}`);
      }
      created += count;
    }

    return created;
  }
}

function addressFor(
  channel: DeliveryChannel,
  recipient: { email: string | null; phone: string | null; pushToken: string | null },
): string | null {
  switch (channel) {
    case 'EMAIL':
      return recipient.email;
    case 'SMS':
      return recipient.phone;
    case 'PUSH':
      return recipient.pushToken;
  }
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** What is worth keeping from an event on the notification row: references, not content. */
function pickIds(data: Record<string, unknown>): Prisma.InputJsonValue {
  const out: Record<string, string | number> = {};
  for (const key of ['appointmentId', 'giftCardId', 'paymentId', 'customerId', 'offsetMinutes']) {
    const value = data[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
