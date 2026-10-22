import { Injectable } from '@nestjs/common';
import type { NotificationStatus, Prisma } from '@prisma/client';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import type { ProviderConfigRow } from './providers/provider.registry';

/** What a provider's receipt says about a message. */
export type ReceiptOutcome = 'ACCEPTED' | 'DELIVERED' | 'FAILED';

export interface ReceiptTarget {
  id: string;
  companyId: string;
  status: NotificationStatus;
  provider: string | null;
  providerConfigId: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
}

/**
 * Delivery receipts arrive before any company is known: the provider calls a
 * public URL. This finds the configuration whose key verifies the receipt and
 * the notifications it names, then moves each one forward — on the platform
 * connection, every write keyed by the row's id AND company and conditional on
 * the status it was read in.
 *
 * The receipts service checks that each notification was sent through the
 * same source (platform or that one company configuration) whose key verified
 * the request, so one company's webhook key can never touch another company's
 * messages.
 */
@Injectable()
export class NotificationReceiptsRepository {
  constructor(private readonly platformDb: PlatformPrismaService) {}

  findConfig(id: string): Promise<(ProviderConfigRow & { isEnabled: boolean }) | null> {
    return this.platformDb.notificationProviderConfig.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        channel: true,
        provider: true,
        credentials: true,
        settings: true,
        updatedAt: true,
        isEnabled: true,
      },
    });
  }

  findNotifications(ids: string[]): Promise<ReceiptTarget[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.platformDb.notification.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        companyId: true,
        status: true,
        provider: true,
        providerConfigId: true,
        providerMessageId: true,
        sentAt: true,
      },
    });
  }

  /**
   * Move one notification forward. Returns false when the receipt changes
   * nothing: a duplicate, an out-of-order "accepted" after "delivered", or a
   * row that moved on since it was read.
   */
  async apply(
    target: ReceiptTarget,
    outcome: ReceiptOutcome,
    detail: { providerStatus: string; at: Date; reason?: string; providerMessageId?: string },
  ): Promise<boolean> {
    const data = transition(target, outcome, detail);
    if (!data) return false;
    const { count } = await this.platformDb.notification.updateMany({
      where: { id: target.id, companyId: target.companyId, status: target.status },
      data,
    });
    return count === 1;
  }
}

/**
 * The only moves a receipt may make. Final states (DELIVERED, FAILED,
 * CANCELLED) never move again, so a late or replayed receipt cannot undo one.
 */
export function transition(
  target: Pick<ReceiptTarget, 'status' | 'sentAt' | 'providerMessageId'>,
  outcome: ReceiptOutcome,
  detail: { providerStatus: string; at: Date; reason?: string; providerMessageId?: string },
): Prisma.NotificationUpdateManyMutationInput | null {
  const open =
    target.status === 'SENDING' || target.status === 'SENT' || target.status === 'UNKNOWN';
  if (!open) return null;
  const common = {
    providerStatus: detail.providerStatus.slice(0, 32),
    providerEventAt: detail.at,
    ...(target.providerMessageId || !detail.providerMessageId
      ? {}
      : { providerMessageId: detail.providerMessageId.slice(0, 128) }),
  };

  switch (outcome) {
    case 'ACCEPTED':
      // Proof the provider has it: settles an UNKNOWN as SENT.
      return target.status === 'SENT'
        ? common
        : { ...common, status: 'SENT', sentAt: target.sentAt ?? detail.at, failureReason: null };
    case 'DELIVERED':
      return {
        ...common,
        status: 'DELIVERED',
        deliveredAt: detail.at,
        sentAt: target.sentAt ?? detail.at,
        failureReason: null,
        nextRetryAt: null,
      };
    case 'FAILED':
      // The provider tried and gave up (bounce, unreachable handset): a retry
      // from here would fail the same way, so it is final.
      return {
        ...common,
        status: 'FAILED',
        failedAt: detail.at,
        failureReason: (detail.reason ?? 'The provider could not deliver the message.').slice(
          0,
          1000,
        ),
        nextRetryAt: null,
      };
  }
}
