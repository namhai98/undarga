import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { SecretBox } from '../../common/crypto/secret-box';
import { transition } from '../notification-receipts.repository';
import { isValidAddress, normalisePhone } from './address-rules';
import {
  SendGridEmailProvider,
  sendGridOutcome,
  verifySendGridSignature,
} from './sendgrid.provider';
import {
  TwilioSmsProvider,
  twilioOutcome,
  twilioSignature,
  verifyTwilioSignature,
} from './twilio.provider';

/**
 * The real adapters, against a mocked `fetch`. Nothing here touches a network.
 */

const message = {
  channel: 'EMAIL' as const,
  to: 'sara@example.com',
  subject: 'Hello',
  body: 'Your booking is confirmed.',
  notificationId: '018f0000-0000-7000-8000-000000000001',
};

function fakeFetch(response: Response | Error) {
  return jest.fn((_input: string | URL | Request, _init?: RequestInit) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
}

describe('SendGridEmailProvider', () => {
  const credentials = {
    apiKey: 'SG.test-key-not-real-000000',
    fromAddress: 'no-reply@undarga.test',
    fromName: 'Undarga',
  };

  it('reports a 202 as ACCEPTED (SENT), never as delivered', async () => {
    const fetch = fakeFetch(
      new Response(null, { status: 202, headers: { 'x-message-id': 'msg-123' } }),
    );
    const result = await new SendGridEmailProvider(credentials, fetch).send(message);

    expect(result).toEqual({
      status: 'SENT',
      provider: 'sendgrid',
      providerMessageId: 'msg-123',
      providerStatus: 'accepted',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${credentials.apiKey}`,
    );
    const body = JSON.parse(init!.body as string);
    expect(body.personalizations[0].to[0].email).toBe('sara@example.com');
    expect(body.from).toEqual({ email: 'no-reply@undarga.test', name: 'Undarga' });
    // How a receipt finds its notification.
    expect(body.custom_args).toEqual({ notification_id: message.notificationId });
  });

  it('treats 4xx as permanent and 429/5xx as retryable', async () => {
    const bad = await new SendGridEmailProvider(
      credentials,
      fakeFetch(
        new Response(JSON.stringify({ errors: [{ message: 'Invalid email' }] }), { status: 400 }),
      ),
    ).send(message);
    expect(bad).toMatchObject({
      status: 'FAILED',
      retryable: false,
      failureReason: expect.stringContaining('Invalid email'),
    });

    for (const status of [429, 500, 503]) {
      const result = await new SendGridEmailProvider(
        credentials,
        fakeFetch(new Response('', { status })),
      ).send(message);
      expect(result).toMatchObject({ status: 'FAILED', retryable: true });
    }
  });

  it('reports a timeout as UNKNOWN (it may have been sent) and a network error as retryable', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(
      await new SendGridEmailProvider(credentials, fakeFetch(timeout)).send(message),
    ).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(
      await new SendGridEmailProvider(credentials, fakeFetch(new TypeError('fetch failed'))).send(
        message,
      ),
    ).toMatchObject({ status: 'FAILED', retryable: true });
  });

  it('verifies the key can send mail', async () => {
    const ok = await new SendGridEmailProvider(
      credentials,
      fakeFetch(new Response(JSON.stringify({ scopes: ['mail.send'] }), { status: 200 })),
    ).verify();
    expect(ok).toEqual({ ok: true });

    const noScope = await new SendGridEmailProvider(
      credentials,
      fakeFetch(new Response(JSON.stringify({ scopes: ['stats.read'] }), { status: 200 })),
    ).verify();
    expect(noScope).toMatchObject({ ok: false, error: expect.stringContaining('mail.send') });

    const rejected = await new SendGridEmailProvider(
      credentials,
      fakeFetch(new Response('', { status: 401 })),
    ).verify();
    expect(rejected.ok).toBe(false);
  });
});

describe('SendGrid Event Webhook signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const body = Buffer.from(JSON.stringify([{ event: 'delivered', notification_id: 'x' }]));
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const signature = sign(
    'sha256',
    Buffer.concat([Buffer.from(timestamp), body]),
    privateKey,
  ).toString('base64');

  it('accepts a correctly signed payload, in base64 or PEM form', () => {
    expect(
      verifySendGridSignature({
        publicKey: publicKeyBase64,
        signature,
        timestamp,
        rawBody: body,
        now,
      }),
    ).toBe(true);
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(
      verifySendGridSignature({ publicKey: pem, signature, timestamp, rawBody: body, now }),
    ).toBe(true);
  });

  it('refuses a tampered body, a missing signature and a stale timestamp', () => {
    const tampered = Buffer.from(body.toString().replace('delivered', 'bounce'));
    expect(
      verifySendGridSignature({
        publicKey: publicKeyBase64,
        signature,
        timestamp,
        rawBody: tampered,
        now,
      }),
    ).toBe(false);
    expect(
      verifySendGridSignature({
        publicKey: publicKeyBase64,
        signature: undefined,
        timestamp,
        rawBody: body,
        now,
      }),
    ).toBe(false);
    expect(
      verifySendGridSignature({
        publicKey: publicKeyBase64,
        signature,
        timestamp,
        rawBody: body,
        now: now + 3_600_000,
      }),
    ).toBe(false);
  });

  it('maps events onto outcomes and ignores tracking events', () => {
    expect(sendGridOutcome('processed')).toBe('ACCEPTED');
    expect(sendGridOutcome('delivered')).toBe('DELIVERED');
    expect(sendGridOutcome('bounce')).toBe('FAILED');
    expect(sendGridOutcome('dropped')).toBe('FAILED');
    expect(sendGridOutcome('open')).toBeNull();
    expect(sendGridOutcome('click')).toBeNull();
  });
});

describe('TwilioSmsProvider', () => {
  const credentials = {
    accountSid: `AC${'0'.repeat(32)}`,
    authToken: 'test-auth-token-not-real',
    fromNumber: '+15005550006',
  };
  const sms = { ...message, channel: 'SMS' as const, to: '+976 9911 2233', subject: undefined };

  it('posts the message form and reports 201 as ACCEPTED', async () => {
    const fetch = fakeFetch(
      new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201 }),
    );
    const result = await new TwilioSmsProvider(credentials, fetch).send({
      ...sms,
      statusCallbackUrl:
        'https://api.undarga.test/api/v1/notifications/receipts/twilio/platform?n=1',
    });
    expect(result).toEqual({
      status: 'SENT',
      provider: 'twilio',
      providerMessageId: 'SM1',
      providerStatus: 'queued',
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`,
    );
    const form = new URLSearchParams(init!.body as string);
    expect(form.get('To')).toBe('+97699112233');
    expect(form.get('From')).toBe('+15005550006');
    expect(form.get('StatusCallback')).toContain('/receipts/twilio/platform');
    const auth = (init!.headers as Record<string, string>).Authorization ?? '';
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(
      `${credentials.accountSid}:${credentials.authToken}`,
    );
  });

  it('prefers a Messaging Service over a from number', async () => {
    const fetch = fakeFetch(
      new Response(JSON.stringify({ sid: 'SM2', status: 'accepted' }), { status: 201 }),
    );
    await new TwilioSmsProvider(
      { ...credentials, messagingServiceSid: `MG${'1'.repeat(32)}` },
      fetch,
    ).send(sms);
    const form = new URLSearchParams(fetch.mock.calls[0]![1]!.body as string);
    expect(form.get('MessagingServiceSid')).toBe(`MG${'1'.repeat(32)}`);
    expect(form.has('From')).toBe(false);
  });

  it('treats an invalid or unsubscribed number as permanent, a server error as retryable', async () => {
    const invalid = await new TwilioSmsProvider(
      credentials,
      fakeFetch(
        new Response(JSON.stringify({ code: 21211, message: 'Invalid To' }), { status: 400 }),
      ),
    ).send(sms);
    expect(invalid).toMatchObject({ status: 'FAILED', retryable: false });

    const outage = await new TwilioSmsProvider(
      credentials,
      fakeFetch(new Response('{}', { status: 500 })),
    ).send(sms);
    expect(outage).toMatchObject({ status: 'FAILED', retryable: true });
  });
});

describe('Twilio request signature', () => {
  const url = 'https://api.undarga.test/api/v1/notifications/receipts/twilio/platform?n=abc';
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered', AccountSid: 'AC1' };

  it('is HMAC-SHA1 over the URL and the sorted parameters', () => {
    const expected = createHmac('sha1', 'token')
      .update(`${url}AccountSidAC1MessageSidSM1MessageStatusdelivered`)
      .digest('base64');
    expect(twilioSignature('token', url, params)).toBe(expected);
  });

  it('accepts the right signature and refuses a changed parameter or another token', () => {
    const signature = twilioSignature('token', url, params);
    expect(verifyTwilioSignature({ authToken: 'token', url, params, signature })).toBe(true);
    expect(
      verifyTwilioSignature({
        authToken: 'token',
        url,
        params: { ...params, MessageStatus: 'failed' },
        signature,
      }),
    ).toBe(false);
    expect(verifyTwilioSignature({ authToken: 'other', url, params, signature })).toBe(false);
    expect(verifyTwilioSignature({ authToken: 'token', url, params, signature: undefined })).toBe(
      false,
    );
  });

  it('maps statuses onto outcomes', () => {
    expect(twilioOutcome('queued')).toBe('ACCEPTED');
    expect(twilioOutcome('sent')).toBe('ACCEPTED');
    expect(twilioOutcome('delivered')).toBe('DELIVERED');
    expect(twilioOutcome('undelivered')).toBe('FAILED');
    expect(twilioOutcome('receiving')).toBeNull();
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));

  it('round-trips, and never stores the plaintext', () => {
    const sealed = box.seal('{"apiKey":"SG.secret"}', 'ctx-a');
    expect(sealed).not.toContain('SG.secret');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(box.open(sealed, 'ctx-a')).toBe('{"apiKey":"SG.secret"}');
    // A fresh IV each time.
    expect(box.seal('same', 'ctx-a')).not.toBe(box.seal('same', 'ctx-a'));
  });

  it('refuses another context, another key, or a tampered value', () => {
    const sealed = box.seal('secret', 'company-a:EMAIL');
    expect(() => box.open(sealed, 'company-b:EMAIL')).toThrow();
    expect(() =>
      new SecretBox(Buffer.alloc(32, 2).toString('base64')).open(sealed, 'company-a:EMAIL'),
    ).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'), 'company-a:EMAIL')).toThrow();
  });

  it('is unavailable without a 32-byte key', () => {
    expect(new SecretBox(null).available).toBe(false);
    expect(new SecretBox(Buffer.alloc(16).toString('base64')).available).toBe(false);
    expect(() => new SecretBox(null).seal('x', 'c')).toThrow();
  });
});

describe('address rules', () => {
  it('validates per channel', () => {
    expect(isValidAddress('EMAIL', 'sara@example.com')).toBe(true);
    expect(isValidAddress('EMAIL', 'not-an-email')).toBe(false);
    expect(isValidAddress('SMS', '+976 9911-2233')).toBe(true);
    expect(isValidAddress('SMS', '9911')).toBe(false);
    expect(normalisePhone('+976 (99) 11-22-33')).toBe('+97699112233');
  });
});

describe('receipt transitions', () => {
  const at = new Date('2026-10-21T10:00:00Z');
  const base = { sentAt: null, providerMessageId: 'm1' };

  it('settles an UNKNOWN as SENT on proof of acceptance', () => {
    expect(
      transition({ ...base, status: 'UNKNOWN' }, 'ACCEPTED', { providerStatus: 'processed', at }),
    ).toMatchObject({
      status: 'SENT',
      sentAt: at,
      failureReason: null,
    });
  });

  it('marks DELIVERED or FAILED from an open state', () => {
    expect(
      transition({ ...base, status: 'SENT' }, 'DELIVERED', { providerStatus: 'delivered', at }),
    ).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: at,
    });
    expect(
      transition({ ...base, status: 'SENT' }, 'FAILED', {
        providerStatus: 'bounce',
        at,
        reason: 'Bounced',
      }),
    ).toMatchObject({ status: 'FAILED', failureReason: 'Bounced', nextRetryAt: null });
  });

  it('never moves a final state, so a late or replayed receipt cannot undo it', () => {
    for (const status of ['DELIVERED', 'FAILED', 'CANCELLED', 'PENDING', 'RETRYING'] as const) {
      for (const outcome of ['ACCEPTED', 'DELIVERED', 'FAILED'] as const) {
        expect(transition({ ...base, status }, outcome, { providerStatus: 'x', at })).toBeNull();
      }
    }
  });

  it('does not downgrade SENT on a late "accepted"', () => {
    const data = transition({ ...base, status: 'SENT' }, 'ACCEPTED', {
      providerStatus: 'deferred',
      at,
    });
    expect(data).not.toHaveProperty('status');
    expect(data).toMatchObject({ providerStatus: 'deferred' });
  });
});
