import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { NotificationChannel } from '@prisma/client';
import { isValidAddress } from './address-rules';
import { PROVIDER_TIMEOUT_MS, failedResult, thrownResult } from './http-outcome';
import type {
  DeliveryResult,
  NotificationProvider,
  OutgoingMessage,
} from './notification-provider';

export interface SendGridCredentials {
  readonly apiKey: string;
  readonly fromAddress: string;
  readonly fromName?: string | null;
}

type Fetch = typeof fetch;

const API = 'https://api.sendgrid.com/v3';

/**
 * Email through SendGrid's v3 Mail Send API.
 *
 *   send     POST /mail/send → 202 means ACCEPTED (queued at SendGrid), not
 *            delivered. The X-Message-Id header is the provider message id.
 *            `custom_args.notification_id` comes back on every Event Webhook
 *            event, which is how a receipt finds its notification.
 *   verify   GET /scopes — the key works and may send mail.
 *
 * Delivery is learnt from the Event Webhook (`delivered`, `bounce`,
 * `dropped`…), whose payload SendGrid signs with ECDSA; see
 * `verifySendGridSignature`. Open and click events are ignored — this is not
 * a tracking system.
 */
export class SendGridEmailProvider implements NotificationProvider {
  readonly name = 'sendgrid';
  readonly channels: readonly NotificationChannel[] = ['EMAIL'];

  constructor(
    private readonly credentials: SendGridCredentials,
    // Looked up per call, so a test can replace the global.
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  isValidAddress(address: string): boolean {
    return isValidAddress('EMAIL', address);
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}/mail/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: {
            email: this.credentials.fromAddress,
            ...(this.credentials.fromName ? { name: this.credentials.fromName } : {}),
          },
          subject: message.subject ?? '',
          content: [{ type: 'text/plain', value: message.body }],
          custom_args: { notification_id: message.notificationId },
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      return thrownResult(this.name, error);
    }

    if (response.status === 202) {
      return {
        status: 'SENT',
        provider: this.name,
        providerMessageId: response.headers.get('x-message-id') ?? undefined,
        providerStatus: 'accepted',
      };
    }
    return failedResult(this.name, response.status, await errorText(response));
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.fetchImpl(`${API}/scopes`, {
        headers: { Authorization: `Bearer ${this.credentials.apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok)
        return { ok: false, error: `SendGrid rejected the API key (${response.status}).` };
      const body = (await response.json().catch(() => ({}))) as { scopes?: string[] };
      if (!body.scopes?.includes('mail.send')) {
        return { ok: false, error: 'The API key may not send mail (missing the mail.send scope).' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'SendGrid could not be reached.' };
    }
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { errors?: Array<{ message?: string }> };
    return (
      body.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join('; ') || response.statusText
    );
  } catch {
    return response.statusText || 'error';
  }
}

// ---------------------------------------------------------------------------
// Event Webhook
// ---------------------------------------------------------------------------

/** A key as SendGrid shows it (base64 DER, SPKI) or as PEM. */
export function sendGridPublicKey(value: string): KeyObject {
  const trimmed = value.trim();
  return trimmed.startsWith('-----BEGIN')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
}

/**
 * SendGrid's signed Event Webhook: ECDSA (P-256, SHA-256) over the timestamp
 * header followed by the raw body. Timestamps older than `toleranceSeconds`
 * are refused as replays.
 */
export function verifySendGridSignature(input: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | null;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  if (!input.signature || !input.timestamp || !input.rawBody) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = (input.now ?? Date.now()) / 1000;
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? 600)) return false;
  try {
    return verifySignature(
      'sha256',
      Buffer.concat([Buffer.from(input.timestamp), input.rawBody]),
      sendGridPublicKey(input.publicKey),
      Buffer.from(input.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** A SendGrid event, mapped onto what it means for a notification. */
export function sendGridOutcome(event: string): 'ACCEPTED' | 'DELIVERED' | 'FAILED' | null {
  switch (event) {
    case 'processed':
    case 'deferred':
      return 'ACCEPTED';
    case 'delivered':
      return 'DELIVERED';
    case 'bounce':
    case 'dropped':
    case 'blocked':
      return 'FAILED';
    default:
      // open, click, spamreport, unsubscribe…: not delivery facts.
      return null;
  }
}
