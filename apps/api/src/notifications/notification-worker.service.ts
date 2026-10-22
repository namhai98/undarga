import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { AppConfig } from '../config';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import type { NotificationProvider } from './providers/notification-provider';
import {
  NotificationProviderRegistry,
  type ProviderConfigRow,
} from './providers/provider.registry';

/** Exponential, capped. A vendor outage should not be retried every second. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800];

/**
 * A row left in SENDING this long belongs to a worker that died mid-send. It is
 * put back for another attempt (which counts against its retry budget, so a
 * message that crashes the worker every time still stops eventually).
 */
const STALE_SENDING_MS = 10 * 60_000;

/**
 * The last stage: hand a due notification to its channel's provider and
 * record what happened.
 *
 * ---------------------------------------------------------------------------
 * CLAIM BEFORE SENDING
 * ---------------------------------------------------------------------------
 *
 * A row is moved to SENDING with a conditional UPDATE before the provider is
 * called:
 *
 *     UPDATE notification SET status = 'SENDING'
 *      WHERE id = … AND status IN ('PENDING','RETRYING')
 *
 * A zero row count means another worker got there first, and this one moves on.
 * Without the claim, two workers polling the same batch both send — and the
 * customer gets the same reminder twice.
 *
 * ---------------------------------------------------------------------------
 * RETRIES ARE BOUNDED
 * ---------------------------------------------------------------------------
 *
 * A retryable failure goes to RETRYING with `next_retry_at` pushed out by the
 * backoff; after `max_retries` it is FAILED and never picked up again. A
 * permanent failure ("that address does not exist") goes straight to FAILED —
 * retrying it only burns the budget and delays everything behind it.
 */
@Injectable()
export class NotificationWorkerService {
  private readonly logger = new Logger(NotificationWorkerService.name);

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly providers: NotificationProviderRegistry,
    private readonly config: AppConfig,
  ) {}

  /**
   * Send everything that is due.
   *
   * Reads across tenants on the platform connection, because a worker cannot be
   * told which company has mail waiting. Every write is keyed by the row's own
   * id. `companyId` narrows the batch to one company (the manual run endpoint).
   */
  async processDue(
    options: { limit?: number; companyId?: string } = {},
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    const now = new Date();
    const scope = options.companyId ? { companyId: options.companyId } : {};

    await this.recoverStale(now, scope);

    const due = await this.platformDb.notification.findMany({
      where: {
        ...scope,
        scheduledFor: { lte: now },
        OR: [{ status: 'PENDING' }, { status: 'RETRYING', nextRetryAt: { lte: now } }],
      },
      orderBy: { scheduledFor: 'asc' },
      take: options.limit ?? 50,
    });

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const configs = await this.companyConfigs(due);

    for (const notification of due) {
      // The company's own account when it has an enabled one, else the
      // platform's. Recorded on the row at claim time, so a receipt — which can
      // arrive before the send call returns — is verified against the same
      // credentials that sent it.
      const config = configs.get(`${notification.companyId}:${notification.channel}`) ?? null;
      const claimed = await this.platformDb.notification.updateMany({
        where: { id: notification.id, status: { in: ['PENDING', 'RETRYING'] } },
        data: { status: 'SENDING', providerConfigId: config?.id ?? null },
      });
      if (claimed.count === 0) {
        skipped += 1;
        continue;
      }

      let provider: NotificationProvider | null;
      try {
        provider = config
          ? this.providers.forCompanyConfig(config)
          : this.providers.forChannel(notification.channel);
      } catch {
        // Wrong or rotated SECRETS_ENCRYPTION_KEY. Flag the configuration so the
        // settings screen says so; the message itself cannot be sent.
        if (config) {
          await this.platformDb.notificationProviderConfig.updateMany({
            where: { id: config.id },
            data: {
              status: 'FAILED',
              lastError: 'Stored credentials could not be decrypted.',
              lastCheckedAt: new Date(),
            },
          });
        }
        await this.markFailed(
          notification,
          'The company’s stored provider credentials could not be read.',
          false,
        );
        failed += 1;
        continue;
      }
      if (!provider) {
        await this.markFailed(
          notification,
          `No ${notification.channel} provider is configured.`,
          false,
        );
        failed += 1;
        continue;
      }

      try {
        const result = await provider.send({
          channel: notification.channel,
          to: notification.recipientAddress,
          subject: notification.subject ?? undefined,
          body: notification.body ?? notification.bodyPreview ?? '',
          notificationId: notification.id,
          dedupeKey: notification.dedupeKey ?? undefined,
          statusCallbackUrl: this.receiptUrl(provider.name, config?.id ?? null, notification.id),
        });

        if (result.status === 'SENT' || result.status === 'DELIVERED') {
          // SENT is "accepted by the provider", not delivered. DELIVERED only
          // when the provider confirmed delivery in the same answer.
          const now = new Date();
          await this.platformDb.notification.updateMany({
            where: { id: notification.id, status: 'SENDING' },
            data: {
              status: result.status,
              sentAt: now,
              ...(result.status === 'DELIVERED' ? { deliveredAt: now } : {}),
              provider: result.provider,
              providerConfigId: config?.id ?? null,
              providerMessageId: result.providerMessageId ?? null,
              providerStatus: result.providerStatus ?? null,
              failureReason: null,
              nextRetryAt: null,
            },
          });
          sent += 1;
          continue;
        }

        if (result.status === 'UNKNOWN') {
          // Retrying might send it twice; a person decides (POST …/retry).
          await this.platformDb.notification.updateMany({
            where: { id: notification.id, status: 'SENDING' },
            data: {
              status: 'UNKNOWN',
              provider: result.provider,
              providerConfigId: config?.id ?? null,
              failureReason: (result.failureReason ?? 'The provider did not answer.').slice(
                0,
                1000,
              ),
              nextRetryAt: null,
            },
          });
          this.logger.warn(
            `Notification ${notification.id}: outcome unknown (${result.provider}).`,
          );
          failed += 1;
          continue;
        }

        await this.markFailed(
          notification,
          result.failureReason ?? 'The provider rejected the message.',
          result.retryable ?? true,
          result.provider,
        );
        failed += 1;
      } catch (error) {
        // A thrown provider is treated as retryable: a crash is far more likely
        // to be a transport problem than a permanently bad address.
        await this.markFailed(notification, (error as Error).message, true, provider.name);
        failed += 1;
      }
    }

    if (sent > 0 || failed > 0) {
      this.logger.log(
        `Notifications: ${sent} sent, ${failed} failed, ${skipped} claimed elsewhere.`,
      );
    }

    return { sent, failed, skipped };
  }

  /** Each company's enabled own-account configs for the channels in a batch. */
  private async companyConfigs(batch: Array<{ companyId: string; channel: NotificationChannel }>) {
    const map = new Map<string, ProviderConfigRow>();
    if (batch.length === 0) return map;
    const rows = await this.platformDb.notificationProviderConfig.findMany({
      where: {
        isEnabled: true,
        companyId: { in: [...new Set(batch.map((n) => n.companyId))] },
      },
      select: {
        id: true,
        companyId: true,
        channel: true,
        provider: true,
        credentials: true,
        settings: true,
        updatedAt: true,
      },
    });
    for (const row of rows) map.set(`${row.companyId}:${row.channel}`, row);
    return map;
  }

  /**
   * The per-message receipt URL for providers that take one (Twilio). The
   * source segment says whose credentials verify it: `platform` or a config id.
   */
  private receiptUrl(provider: string, configId: string | null, notificationId: string) {
    const base = this.config.notificationProviders.webhookBaseUrl;
    if (!base || provider !== 'twilio') return undefined;
    return `${base}/${this.config.app.apiPrefix}/v1/notifications/receipts/twilio/${configId ?? 'platform'}?n=${notificationId}`;
  }

  private async recoverStale(now: Date, scope: { companyId?: string }) {
    const stale = await this.platformDb.notification.findMany({
      where: {
        ...scope,
        status: 'SENDING',
        updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) },
      },
      select: { id: true, retryCount: true, maxRetries: true },
      take: 100,
    });
    for (const row of stale) {
      await this.markFailed(row, 'The worker stopped while sending.', true, null, 'SENDING');
    }
  }

  private async markFailed(
    notification: { id: string; retryCount: number; maxRetries: number },
    reason: string,
    retryable: boolean,
    provider: string | null = null,
    expectedStatus: 'SENDING' = 'SENDING',
  ) {
    const attempt = notification.retryCount + 1;
    const canRetry = retryable && attempt <= notification.maxRetries;
    const backoff =
      RETRY_BACKOFF_SECONDS[Math.min(notification.retryCount, RETRY_BACKOFF_SECONDS.length - 1)] ??
      1800;

    // Conditional on still being SENDING: only the worker that claimed the row
    // records its outcome.
    await this.platformDb.notification.updateMany({
      where: { id: notification.id, status: expectedStatus },
      data: {
        status: canRetry ? 'RETRYING' : 'FAILED',
        retryCount: attempt,
        failureReason: reason.slice(0, 1000),
        failedAt: canRetry ? null : new Date(),
        nextRetryAt: canRetry ? new Date(Date.now() + backoff * 1000) : null,
        ...(provider ? { provider } : {}),
      },
    });
  }
}
