import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import type { AppConfig } from '../../config';
import type {
  DeliveryResult,
  NotificationProvider,
  OutgoingMessage,
} from './notification-provider';

/** Kept in memory outside production only, and only this many. */
const DELIVERED_LOG_LIMIT = 200;

/**
 * The shared behaviour of the three test-double providers. Delivers nothing.
 *
 * Used only when a channel is explicitly set to `mock` (EMAIL_PROVIDER=mock
 * etc.), which env validation refuses in production. The e2e suites use it:
 * it keeps the last few messages in memory, and it can be told to fail, to
 * time out (UNKNOWN) or to report delivery outright — which is how the tests
 * drive every worker path without a vendor.
 *
 * Real delivery is SendGrid / Twilio (see platform-providers.ts); the `log`
 * provider is the development stand-in.
 */
export abstract class MockNotificationProvider implements NotificationProvider {
  protected readonly logger: Logger;
  abstract readonly name: string;
  abstract readonly channel: NotificationChannel;
  private readonly failures: Array<{ retryable: boolean; reason: string; throws: boolean }> = [];
  private readonly outcomes: Array<'UNKNOWN' | 'DELIVERED'> = [];
  private readonly deliveredLog: OutgoingMessage[] = [];

  protected constructor(
    private readonly config: AppConfig,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
  }

  get channels(): readonly NotificationChannel[] {
    return [this.channel];
  }

  abstract isValidAddress(address: string): boolean;

  /** Messages "delivered" so far (never populated in production). */
  get delivered(): readonly OutgoingMessage[] {
    return this.deliveredLog;
  }

  /**
   * Make the next `count` sends fail. `throws` simulates a transport crash
   * rather than a vendor's refusal. Refused in production.
   */
  failNext(
    count: number,
    options: { retryable?: boolean; reason?: string; throws?: boolean } = {},
  ): void {
    if (this.config.app.isProduction) return;
    for (let i = 0; i < count; i += 1) {
      this.failures.push({
        retryable: options.retryable ?? true,
        reason: options.reason ?? `Simulated ${this.channel} failure`,
        throws: options.throws ?? false,
      });
    }
  }

  /**
   * Make the next sends answer with these outcomes instead of SENT: UNKNOWN
   * (the provider never answered) or DELIVERED (confirmed in the same answer).
   */
  answerNext(...outcomes: Array<'UNKNOWN' | 'DELIVERED'>): void {
    if (this.config.app.isProduction) return;
    this.outcomes.push(...outcomes);
  }

  reset(): void {
    this.failures.length = 0;
    this.outcomes.length = 0;
    this.deliveredLog.length = 0;
  }

  send(message: OutgoingMessage): Promise<DeliveryResult> {
    const failure = this.failures.shift();
    if (failure?.throws) return Promise.reject(new Error(failure.reason));
    if (failure) {
      return Promise.resolve({
        status: 'FAILED',
        provider: this.name,
        failureReason: failure.reason,
        retryable: failure.retryable,
      });
    }

    const outcome = this.outcomes.shift();
    if (outcome === 'UNKNOWN') {
      return Promise.resolve({
        status: 'UNKNOWN',
        provider: this.name,
        failureReason: 'Simulated timeout',
      });
    }

    if (!this.config.app.isTest) {
      this.logger.debug(
        `[mock] ${message.channel} ${message.notificationId} to ${redact(message.to)}`,
      );
    }

    if (!this.config.app.isProduction) {
      this.deliveredLog.push(message);
      if (this.deliveredLog.length > DELIVERED_LOG_LIMIT) this.deliveredLog.shift();
    }

    return Promise.resolve({
      status: outcome ?? 'SENT',
      provider: this.name,
      providerMessageId: `mock_${randomUUID()}`,
      providerStatus: outcome === 'DELIVERED' ? 'delivered' : 'accepted',
    });
  }
}

/** Enough to tell one recipient from another in a log; not enough to contact them. */
function redact(address: string): string {
  const at = address.lastIndexOf('@');
  if (at > 0) return `***@${address.slice(at + 1)}`;
  return `***${address.slice(-3)}`;
}
