import { Injectable } from '@nestjs/common';
import { ResourceNotFoundError } from '../common/errors';
import type { Prisma } from '@prisma/client';
import type { NotificationQueryDto as NotificationQuery } from './dto/notification.dto';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';

interface NotificationRow {
  id: string;
  companyId: string;
  type: string;
}

@Injectable()
export class NotificationRepository extends TenantScopedRepository<NotificationRow> {
  protected readonly modelName = 'Notification';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<NotificationRow> {
    return tx.notification;
  }
}

/**
 * The read side of the notification pipeline.
 *
 * Deliberately thin. Producing notifications is the dispatcher's job and
 * sending them is the worker's; this exists so a support engineer can answer
 * "did the customer get their reminder" without a database console.
 *
 * The body is NOT returned in full — only the preview the row stores. A
 * notification body can contain an appointment's details and a customer's name,
 * and a list endpoint that dumped all of it would turn one permission into a
 * bulk export of who is booked for what.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly notifications: NotificationRepository) {}

  async list(query: NotificationQuery) {
    return this.notifications.transaction(async (tx, companyId) => {
      const where: Prisma.NotificationWhereInput = {
        companyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      };

      const [rows, total] = await Promise.all([
        tx.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.offset,
          take: query.limit,
        }),
        tx.notification.count({ where }),
      ]);

      return {
        items: rows.map(toSummary),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  /**
   * One notification, with the full message text. The address stays masked
   * and the raw event payload is never returned.
   */
  async findById(notificationId: string) {
    return this.notifications.transaction(async (tx, companyId) => {
      const row = await tx.notification.findFirst({ where: { id: notificationId, companyId } });
      if (!row) throw new ResourceNotFoundError('Notification', notificationId);
      return {
        ...toSummary(row),
        body: row.body ?? row.bodyPreview,
        templateId: row.templateId,
        customTemplate: row.templateId !== null,
        providerMessageId: row.providerMessageId,
      };
    });
  }

  /** Counts by status and channel — two grouped queries, not a scan. */
  async stats() {
    return this.notifications.transaction(async (tx, companyId) => {
      const [byStatus, byChannel, pendingOutbox] = await Promise.all([
        tx.notification.groupBy({
          by: ['status'],
          where: { companyId },
          _count: { _all: true },
        }),
        tx.notification.groupBy({
          by: ['channel'],
          where: { companyId },
          _count: { _all: true },
        }),
        tx.outboxEvent.count({ where: { companyId, status: 'PENDING' } }),
      ]);

      return {
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        byChannel: Object.fromEntries(byChannel.map((r) => [r.channel, r._count._all])),
        /** Events waiting to become notifications. A growing number means the
            dispatcher is not running. */
        pendingEvents: pendingOutbox,
      };
    });
  }
}

function toSummary(row: {
  id: string;
  type: string;
  channel: string;
  status: string;
  recipientType: string;
  recipientAddress: string;
  subject: string | null;
  bodyPreview: string | null;
  appointmentId: string | null;
  scheduledFor: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: Date | null;
  provider: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    channel: row.channel,
    status: row.status,
    recipientType: row.recipientType,
    /**
     * Masked. A staff member checking whether a reminder went out does not
     * need the customer's address, and this list is the easiest place to
     * accidentally build a contact-harvesting screen.
     */
    recipientAddress: mask(row.recipientAddress),
    subject: row.subject,
    preview: row.bodyPreview,
    appointmentId: row.appointmentId,
    scheduledFor: row.scheduledFor,
    sentAt: row.sentAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    nextRetryAt: row.nextRetryAt,
    provider: row.provider,
    createdAt: row.createdAt,
  };
}

function mask(address: string): string {
  const at = address.lastIndexOf('@');
  if (at > 1) return `${address.slice(0, 1)}***@${address.slice(at + 1)}`;
  if (address.length > 4) return `***${address.slice(-4)}`;
  return '***';
}
