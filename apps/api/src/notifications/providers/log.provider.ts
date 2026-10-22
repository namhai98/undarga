import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { isValidAddress } from './address-rules';
import type {
  DeliveryResult,
  NotificationProvider,
  OutgoingMessage,
} from './notification-provider';

/**
 * Development only (`EMAIL_PROVIDER=log`, the default outside production):
 * the message is written to the API log so a developer can read it.
 *
 * It is recorded as provider `log` — visible as such on the history screen —
 * never as a real send. Env validation refuses it in production, where an
 * unconfigured channel sends nothing and says so.
 */
export class LogNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger('LogNotificationProvider');
  readonly name = 'log';
  readonly channels: readonly NotificationChannel[];

  constructor(private readonly channel: NotificationChannel) {
    this.channels = [channel];
  }

  isValidAddress(address: string): boolean {
    return isValidAddress(this.channel, address);
  }

  send(message: OutgoingMessage): Promise<DeliveryResult> {
    this.logger.log(
      `\n--- [dev] ${message.channel} to ${message.to} ---\n` +
        (message.subject ? `Subject: ${message.subject}\n` : '') +
        `${message.body}\n---`,
    );
    return Promise.resolve({
      status: 'SENT',
      provider: this.name,
      providerMessageId: `log_${randomUUID()}`,
      providerStatus: 'logged',
    });
  }
}
