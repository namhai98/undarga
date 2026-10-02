import type { NotificationChannel } from '@prisma/client';

/**
 * ===========================================================================
 * THE SEAM A REAL EMAIL/SMS/PUSH VENDOR PLUGS INTO
 * ===========================================================================
 *
 *     NotificationWorkerService
 *         ↓  (NotificationProviderRegistry: one provider per channel)
 *     NotificationProvider
 *         ├── EmailNotificationProvider
 *         ├── SmsNotificationProvider
 *         └── PushNotificationProvider
 *
 * One interface for all three channels, because the differences between them
 * are data, not behaviour: an address, a subject (a title for push), a body,
 * and a vendor message id to correlate a delivery receipt with. Each channel
 * has its own class so a real vendor replaces exactly one of them; the retry,
 * dedupe and status bookkeeping stay in the worker, done once.
 *
 * A provider is handed an already-rendered message. It does not read the
 * database, does not decide whether to send, and does not know about tenants —
 * all of which happen before it is called. That keeps a vendor SDK away from
 * the part of the system that has to be tenant-safe.
 */

export interface OutgoingMessage {
  readonly channel: NotificationChannel;
  /** Email address, E.164 phone, or device token, depending on the channel. */
  readonly to: string;
  /** Email only. SMS and push ignore it. */
  readonly subject?: string;
  readonly body: string;
  /** For a support engineer tracing one message end to end. */
  readonly notificationId: string;
  /**
   * Stable per logical notification. A provider that supports it should refuse
   * a duplicate; the worker also refuses one before getting here.
   */
  readonly dedupeKey?: string;
}

export interface DeliveryResult {
  readonly status: 'SENT' | 'FAILED';
  readonly provider: string;
  readonly providerMessageId?: string;
  readonly failureReason?: string;
  /**
   * False for a permanent failure — a malformed address, an unsubscribed
   * recipient. The worker stops retrying rather than burning its budget on
   * something that will never work.
   */
  readonly retryable?: boolean;
}

export interface NotificationProvider {
  readonly name: string;
  readonly channels: readonly NotificationChannel[];
  /**
   * Whether `address` is something this provider could deliver to. Checked
   * before a notification is created, so a malformed email or phone number is
   * recorded as CANCELLED with a reason instead of burning retries.
   */
  isValidAddress(address: string): boolean;
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}

export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');
