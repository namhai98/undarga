import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Everything this server signs about payments, from one secret
 * (`PAYMENT_SIGNING_SECRET`), each use under its own derived key so a value
 * signed for one purpose can never be replayed as another.
 *
 *   webhook URLs      QPay does not sign its callbacks, so the callback URL we
 *                     hand it carries our own signature over the transaction
 *                     id. A forged call without it is rejected; a genuine one
 *                     still only TRIGGERS a server-side status check.
 *   mock webhooks     the local simulator signs like a real gateway would.
 *   payment links     the public booking confirmation carries a token that
 *                     lets that booker — and only someone holding it — pay
 *                     for that one appointment, until it expires.
 *
 * A plain class built by a factory, so tests can construct one with a known
 * secret without touching the environment.
 */
export class PaymentSigner {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly secret: string | null,
    /** This API's public origin, no trailing slash. */
    private readonly webhookBaseUrl: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.secret);
  }

  sign(purpose: string, value: string): string {
    return createHmac('sha256', this.key(purpose)).update(value).digest('base64url');
  }

  verify(purpose: string, value: string, signature: unknown): boolean {
    if (typeof signature !== 'string' || signature.length === 0) return false;
    const expected = Buffer.from(this.sign(purpose, value));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** The URL a provider calls for one transaction. */
  callbackUrl(provider: string, transactionId: string): string {
    const sig = this.sign(`webhook:${provider}`, transactionId);
    return `${this.webhookBaseUrl}/api/v1/payments/webhook/${provider}?tx=${transactionId}&sig=${sig}`;
  }

  /**
   * A capability to pay for one appointment, for the anonymous booker.
   *
   * `v1.<payload>.<signature>`. The payload holds only the appointment NUMBER
   * the confirmation already shows and an expiry — no internal ids. The company
   * is bound in through the signature instead, so a token is worthless under
   * any other company's slug.
   */
  issuePaymentLink(companyId: string, appointmentNumber: string, ttlMs: number, now = Date.now()) {
    const payload = Buffer.from(
      JSON.stringify({ n: appointmentNumber, e: Math.floor((now + ttlMs) / 1000) }),
    ).toString('base64url');
    return `v1.${payload}.${this.sign('payment-link', `${companyId}.${payload}`)}`;
  }

  /** null for anything forged, malformed, expired, or issued for another company. */
  readPaymentLink(
    companyId: string,
    token: unknown,
    now = Date.now(),
  ): { appointmentNumber: string } | null {
    if (typeof token !== 'string' || token.length > 512) return null;
    const [version, payload, sig] = token.split('.');
    if (version !== 'v1' || !payload || !sig) return null;
    if (!this.verify('payment-link', `${companyId}.${payload}`, sig)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        n?: unknown;
        e?: unknown;
      };
      if (typeof parsed.n !== 'string' || typeof parsed.e !== 'number') return null;
      if (parsed.e * 1000 <= now) return null;
      return { appointmentNumber: parsed.n };
    } catch {
      return null;
    }
  }

  private key(purpose: string): Buffer {
    if (!this.secret) {
      // Callers check `configured` first; reaching here is a wiring bug, and
      // signing with an empty key would make every signature forgeable.
      throw new Error('PAYMENT_SIGNING_SECRET is not configured.');
    }
    let key = this.keys.get(purpose);
    if (!key) {
      key = createHmac('sha256', this.secret).update(`undarga-payments:${purpose}`).digest();
      this.keys.set(purpose, key);
    }
    return key;
  }
}
