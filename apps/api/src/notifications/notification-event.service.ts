import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';

/**
 * Business events that somebody might need to be told about.
 *
 * The list is closed on purpose. A string type would let a typo produce an
 * event nothing handles, silently, forever — the failure mode of every
 * stringly-typed event bus. Adding one here forces a decision about who is
 * notified and on which channel.
 */
export const NOTIFICATION_EVENTS = {
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_CONFIRMED: 'appointment.confirmed',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_REMINDER: 'appointment.reminder',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  PAYMENT_COMPLETED: 'payment.completed',
  GIFT_CARD_ISSUED: 'gift_card.issued',
  GIFT_CARD_ASSIGNED: 'gift_card.assigned',
} as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/**
 * ===========================================================================
 * THE TRANSACTIONAL OUTBOX
 * ===========================================================================
 *
 *     business write  →  outbox_event  →  dispatcher  →  notification  →  worker  →  provider
 *
 * The queue IS the outbox (and then the notification table): a database-backed
 * queue drained by `NotificationSchedulerService`, which polls in-process. The
 * request that caused an event only pays for one INSERT in its own
 * transaction; everything slow happens later, off the request path.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OUTBOX AND NOT BULLMQ
 * ---------------------------------------------------------------------------
 *
 * The brief says to use BullMQ "if already available". It is not — only
 * `ioredis` is installed — and Redis is deliberately OPTIONAL in this codebase:
 * `RedisModule` degrades to a no-op when it cannot connect, because a cache
 * being down must not take the API down with it.
 *
 * Pushing notification jobs straight into Redis would quietly make that
 * optional dependency load-bearing: a payment would commit, the enqueue would
 * fail, and the receipt would never be sent with nothing recorded to show for
 * it. The `outbox_event` table already exists in the schema for precisely this,
 * and it gives the property that matters — an event is written in the SAME
 * DATABASE as the thing that caused it, so it cannot be lost independently.
 *
 * BullMQ is still the natural transport later. It slots in at the DISPATCHER,
 * which reads the outbox and fans out; nothing above or below it changes.
 *
 * ---------------------------------------------------------------------------
 * `emit` VS `emitWithin`
 * ---------------------------------------------------------------------------
 *
 * `emitWithin(tx, …)` writes the event in the CALLER's transaction, which is
 * the real outbox pattern: the event and the business fact commit together.
 * Use it for anything where a missing notification is a correctness problem.
 *
 * `emit(…)` opens its own transaction. It is for callers that have already
 * committed and where a lost notification is an annoyance rather than a bug —
 * a payment receipt, say, where the money is safely recorded either way. The
 * distinction is deliberate rather than accidental, and both are here so the
 * choice has to be made explicitly at each call site.
 */
@Injectable()
export class NotificationEventService {
  private readonly logger = new Logger(NotificationEventService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContextService,
  ) {}

  /** Write the event inside the caller's transaction. The strong version. */
  async emitWithin(
    tx: TenantTx,
    companyId: string,
    type: NotificationEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: { companyId, type, payload: payload as Prisma.InputJsonValue },
    });
  }

  /**
   * Write the event in its own transaction.
   *
   * Swallows its own failure and logs loudly. An unsent receipt must never turn
   * a successful payment into a 500 the client retries — the money already
   * moved, and the retry would be the actual damage.
   */
  async emit(type: NotificationEventType, payload: Record<string, unknown>): Promise<void> {
    const companyId = this.context.tenantOrNull()?.company.id;
    if (!companyId) {
      this.logger.error(`Cannot emit ${type}: no tenant context.`);
      return;
    }

    try {
      await this.db.runInCompany(companyId, async (tx) => {
        await this.emitWithin(tx, companyId, type, payload);
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${type} for company ${companyId}: ${(error as Error).message}`,
      );
    }
  }
}
