import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NotificationChannel } from '@prisma/client';
import { isValidAddress, normalisePhone } from './address-rules';
import { PROVIDER_TIMEOUT_MS, failedResult, thrownResult } from './http-outcome';
import type {
  DeliveryResult,
  NotificationProvider,
  OutgoingMessage,
} from './notification-provider';

export interface TwilioCredentials {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber?: string | null;
  readonly messagingServiceSid?: string | null;
}

type Fetch = typeof fetch;

/** Twilio error codes that will never succeed on a retry. */
const PERMANENT_CODES = new Set([21211, 21408, 21610, 21612, 21614]);

/**
 * SMS through Twilio's Programmable Messaging API.
 *
 *   send     POST /Accounts/:sid/Messages.json → 201 with a status of
 *            `queued`/`accepted`: ACCEPTED, not delivered. `StatusCallback`
 *            is our per-message receipt URL when receipts are configured.
 *   verify   GET /Accounts/:sid.json — the credentials are valid.
 *
 * Twilio signs status callbacks (X-Twilio-Signature, HMAC-SHA1 with the auth
 * token); see `verifyTwilioSignature`.
 */
export class TwilioSmsProvider implements NotificationProvider {
  readonly name = 'twilio';
  readonly channels: readonly NotificationChannel[] = ['SMS'];

  constructor(
    private readonly credentials: TwilioCredentials,
    // Looked up per call, so a test can replace the global.
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  get authToken(): string {
    return this.credentials.authToken;
  }

  isValidAddress(address: string): boolean {
    return isValidAddress('SMS', address);
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    const form = new URLSearchParams({ To: normalisePhone(message.to), Body: message.body });
    if (this.credentials.messagingServiceSid) {
      form.set('MessagingServiceSid', this.credentials.messagingServiceSid);
    } else if (this.credentials.fromNumber) {
      form.set('From', this.credentials.fromNumber);
    }
    if (message.statusCallbackUrl) form.set('StatusCallback', message.statusCallbackUrl);

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.credentials.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: this.basicAuth(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
    } catch (error) {
      return thrownResult(this.name, error);
    }

    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      code?: number;
      message?: string;
      error_code?: number | null;
    };
    if (response.status === 201 || response.status === 200) {
      return {
        status: 'SENT',
        provider: this.name,
        providerMessageId: body.sid,
        providerStatus: body.status ?? 'queued',
      };
    }
    const result = failedResult(this.name, response.status, body.message ?? response.statusText);
    // A known permanent error code is permanent even if Twilio said 5xx-ish.
    return body.code && PERMANENT_CODES.has(body.code) ? { ...result, retryable: false } : result;
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.credentials.accountSid)}.json`,
        {
          headers: { Authorization: this.basicAuth() },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
      if (!response.ok)
        return { ok: false, error: `Twilio rejected the credentials (${response.status}).` };
      return { ok: true };
    } catch {
      return { ok: false, error: 'Twilio could not be reached.' };
    }
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${this.credentials.accountSid}:${this.credentials.authToken}`).toString('base64')}`;
  }
}

/**
 * Twilio's request signature: base64 HMAC-SHA1, keyed with the auth token,
 * over the full callback URL followed by every POST parameter as key+value,
 * keys sorted.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  const expected = Buffer.from(twilioSignature(input.authToken, input.url, input.params));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A Twilio MessageStatus, mapped onto what it means for a notification. */
export function twilioOutcome(status: string): 'ACCEPTED' | 'DELIVERED' | 'FAILED' | null {
  switch (status) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
    case 'sent':
      return 'ACCEPTED';
    case 'delivered':
    case 'read':
      return 'DELIVERED';
    case 'undelivered':
    case 'failed':
    case 'canceled':
      return 'FAILED';
    default:
      return null;
  }
}
