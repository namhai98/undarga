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
 * The shared behaviour of the three stand-in providers. Delivers nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES INSTEAD
 * ---------------------------------------------------------------------------
 *
 *   - In development it logs the whole message, so you can read the reminder
 *     you just triggered without a mail server.
 *   - Anywhere else it logs the recipient's domain / last digits and nothing
 *     else: a production log full of phone numbers and appointment details is
 *     a breach waiting for whoever has log access.
 *   - Outside production it keeps the last few messages in memory, and it can
 *     be told to fail — which is how the tests drive the retry path without a
 *     vendor.
 *
 * It reports SENT by default. Reporting FAILED would make the worker retry
 * forever against a provider that is working exactly as designed.
 *
 * A real vendor is a class implementing `NotificationProvider` for its
 * channel, registered in `NotificationsModule` in place of the mock.
 */
export abstract class MockNotificationProvider implements NotificationProvider {
  protected readonly logger: Logger;
  abstract readonly name: string;
  abstract readonly channel: NotificationChannel;
  private readonly failures: Array<{ retryable: boolean; reason: string; throws: boolean }> = [];
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

  reset(): void {
    this.failures.length = 0;
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

    if (this.config.app.isDevelopment) {
      this.logger.log(
        `\n--- ${message.channel} to ${message.to} ---\n` +
          (message.subject ? `Subject: ${message.subject}\n` : '') +
          `${message.body}\n---`,
      );
    } else if (!this.config.app.isTest) {
      this.logger.warn(
        `${message.channel} notification ${message.notificationId} not delivered: ` +
          `no provider configured (recipient ${redact(message.to)}).`,
      );
    }

    if (!this.config.app.isProduction) {
      this.deliveredLog.push(message);
      if (this.deliveredLog.length > DELIVERED_LOG_LIMIT) this.deliveredLog.shift();
    }

    return Promise.resolve({
      status: 'SENT',
      provider: this.name,
      providerMessageId: `mock_${randomUUID()}`,
    });
  }
}

/** Enough to tell one recipient from another in a log; not enough to contact them. */
function redact(address: string): string {
  const at = address.lastIndexOf('@');
  if (at > 0) return `***@${address.slice(at + 1)}`;
  return `***${address.slice(-3)}`;
}
