import { Injectable, Logger } from '@nestjs/common';
import { WebhookSignatureInvalidError } from '../common/errors';
import { AppConfig } from '../config';
import {
  NotificationReceiptsRepository,
  type ReceiptOutcome,
} from './notification-receipts.repository';
import { NotificationProviderRegistry, settingsOf } from './providers/provider.registry';
import { sendGridOutcome, verifySendGridSignature } from './providers/sendgrid.provider';
import { twilioOutcome, verifyTwilioSignature } from './providers/twilio.provider';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReceiptRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer | null;
  body: unknown;
}

/** Where a receipt says it came from: the platform account or one company configuration. */
type Source = { kind: 'platform' } | { kind: 'company'; configId: string };

interface Receipt {
  notificationId: string;
  outcome: ReceiptOutcome;
  providerStatus: string;
  at: Date;
  reason?: string;
  providerMessageId?: string;
}

/**
 * Provider delivery receipts: the only way a notification becomes DELIVERED
 * (or FAILED after it was accepted).
 *
 *   POST /notifications/receipts/sendgrid/:source   SendGrid Event Webhook
 *   POST /notifications/receipts/twilio/:source?n=  Twilio StatusCallback
 *
 * `source` is `platform` or a company configuration id, and names whose key
 * verifies the request. Each receipt only touches notifications that were sent
 * through that same source. Bodies are never logged — they carry addresses.
 */
@Injectable()
export class NotificationReceiptsService {
  private readonly logger = new Logger(NotificationReceiptsService.name);

  constructor(
    private readonly repository: NotificationReceiptsRepository,
    private readonly registry: NotificationProviderRegistry,
    private readonly config: AppConfig,
  ) {}

  async sendgrid(sourceParam: string, request: ReceiptRequest) {
    const source = parseSource(sourceParam);
    const publicKey = await this.sendgridKey(source);
    const valid =
      !!publicKey &&
      verifySendGridSignature({
        publicKey,
        signature: header(request.headers, 'x-twilio-email-event-webhook-signature'),
        timestamp: header(request.headers, 'x-twilio-email-event-webhook-timestamp'),
        rawBody: request.rawBody,
      });
    if (!valid) throw new WebhookSignatureInvalidError();

    const events = Array.isArray(request.body)
      ? (request.body as Array<Record<string, unknown>>)
      : [];
    const receipts: Receipt[] = [];
    for (const event of events) {
      const notificationId = event.notification_id;
      const name = typeof event.event === 'string' ? event.event : '';
      const outcome = sendGridOutcome(name);
      if (!outcome || typeof notificationId !== 'string' || !UUID.test(notificationId)) continue;
      const ts =
        typeof event.timestamp === 'number' ? new Date(event.timestamp * 1000) : new Date();
      receipts.push({
        notificationId,
        outcome,
        providerStatus: name,
        at: Number.isNaN(ts.getTime()) ? new Date() : ts,
        // Not the provider's reason text: bounce reasons quote the address.
        reason: outcome === 'FAILED' ? `SendGrid reported the email as ${name}.` : undefined,
        providerMessageId:
          typeof event.sg_message_id === 'string' ? event.sg_message_id : undefined,
      });
    }
    return this.apply('sendgrid', source, receipts, events.length);
  }

  async twilio(
    sourceParam: string,
    request: ReceiptRequest & { originalUrl: string; query: unknown },
  ) {
    const source = parseSource(sourceParam);
    const base = this.config.notificationProviders.webhookBaseUrl;
    const authToken = await this.twilioToken(source);
    const params = formParams(request.body);
    const valid =
      !!base &&
      !!authToken &&
      verifyTwilioSignature({
        authToken,
        url: `${base}${request.originalUrl}`,
        params,
        signature: header(request.headers, 'x-twilio-signature'),
      });
    if (!valid) throw new WebhookSignatureInvalidError();

    const query = (request.query ?? {}) as Record<string, unknown>;
    const notificationId = typeof query.n === 'string' ? query.n : '';
    const status = params.MessageStatus ?? '';
    const outcome = twilioOutcome(status);
    const receipts: Receipt[] =
      outcome && UUID.test(notificationId)
        ? [
            {
              notificationId,
              outcome,
              providerStatus: status,
              at: new Date(),
              reason:
                outcome === 'FAILED'
                  ? `Twilio reported the message as ${status}${params.ErrorCode ? ` (error ${params.ErrorCode})` : ''}.`
                  : undefined,
              providerMessageId: params.MessageSid,
            },
          ]
        : [];
    return this.apply('twilio', source, receipts, 1);
  }

  private async apply(provider: string, source: Source, receipts: Receipt[], received: number) {
    const targets = await this.repository.findNotifications([
      ...new Set(receipts.map((r) => r.notificationId)),
    ]);
    const byId = new Map(targets.map((t) => [t.id, t]));
    const expectedConfig = source.kind === 'platform' ? null : source.configId;

    let applied = 0;
    let ignored = 0;
    // Oldest first, so "accepted" then "delivered" in one batch lands as delivered.
    for (const receipt of [...receipts].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const target = byId.get(receipt.notificationId);
      const sameSender =
        !!target &&
        target.providerConfigId === expectedConfig &&
        (target.provider === null || target.provider === provider) &&
        sameMessage(target.providerMessageId, receipt.providerMessageId);
      if (!target || !sameSender) {
        ignored += 1;
        continue;
      }
      const changed = await this.repository.apply(target, receipt.outcome, receipt);
      if (changed) {
        applied += 1;
        // Re-read state for the next receipt about the same message.
        const [fresh] = await this.repository.findNotifications([target.id]);
        if (fresh) byId.set(fresh.id, fresh);
      }
    }

    if (ignored > 0) {
      this.logger.warn(
        `${provider} receipts: ${ignored} did not match a message from this source.`,
      );
    }
    return { received, applied, ignored };
  }

  private async sendgridKey(source: Source): Promise<string | null> {
    if (source.kind === 'platform') {
      const email = this.config.notificationProviders.email;
      return email.provider === 'sendgrid' ? (email.sendgridWebhookPublicKey ?? null) : null;
    }
    const row = await this.repository.findConfig(source.configId);
    if (!row || row.channel !== 'EMAIL' || row.provider !== 'sendgrid') return null;
    return settingsOf(row.settings).webhookPublicKey ?? null;
  }

  private async twilioToken(source: Source): Promise<string | null> {
    if (source.kind === 'platform') {
      const sms = this.config.notificationProviders.sms;
      return sms.provider === 'twilio' ? (sms.twilioAuthToken ?? null) : null;
    }
    const row = await this.repository.findConfig(source.configId);
    if (!row || row.channel !== 'SMS' || row.provider !== 'twilio') return null;
    try {
      return this.registry.openSecrets(row).authToken ?? null;
    } catch {
      return null;
    }
  }
}

function parseSource(value: string): Source {
  if (value === 'platform') return { kind: 'platform' };
  if (UUID.test(value)) return { kind: 'company', configId: value };
  // Unknown source: nothing can verify it.
  throw new WebhookSignatureInvalidError();
}

function header(headers: ReceiptRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function formParams(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** SendGrid's sg_message_id is the X-Message-Id followed by `.filter…`. */
function sameMessage(stored: string | null, reported: string | undefined): boolean {
  if (!stored || !reported) return true;
  return reported === stored || reported.startsWith(`${stored}.`);
}
