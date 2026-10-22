import { Logger } from '@nestjs/common';
import { decimalToMinorString, minorToDecimalString } from '@undarga/shared';
import { PaymentProviderError } from '../../common/errors';
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProvider,
  ProviderPaymentState,
  ProviderRefundRequest,
  ProviderRefundResult,
  WebhookRequest,
  WebhookVerification,
} from './payment-provider';
import type { PaymentSigner } from './payment-signer';

export interface QPayConfig {
  /** https://merchant.qpay.mn, or https://merchant-sandbox.qpay.mn */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly invoiceCode: string;
}

type Fetch = typeof fetch;

const TIMEOUT_MS = 15_000;

interface QPayInvoiceResponse {
  invoice_id: string;
  qr_text?: string;
  qr_image?: string;
  qPay_shortUrl?: string;
  urls?: Array<{ name?: string; description?: string; logo?: string; link?: string }>;
}

interface QPayCheckResponse {
  count?: number;
  paid_amount?: number | string;
  rows?: Array<{
    payment_id?: string | number;
    payment_status?: string;
    payment_amount?: number | string;
    payment_fee?: number | string;
    payment_currency?: string;
  }>;
}

/**
 * QPay merchant API v2 (Mongolia). MNT only.
 *
 *   createPayment  POST   /v2/invoice           a QR + bank-app links
 *   getPayment     POST   /v2/payment/check     paid rows for the invoice
 *   refundPayment  DELETE /v2/payment/refund/:payment_id   whole payments only
 *   cancelPayment  DELETE /v2/invoice/:invoice_id
 *
 * Authentication is a bearer token from POST /v2/auth/token with HTTP Basic
 * client credentials, cached until shortly before it expires and fetched again
 * once on a 401.
 *
 * ---------------------------------------------------------------------------
 * QPAY DOES NOT SIGN ITS CALLBACKS
 * ---------------------------------------------------------------------------
 *
 * The callback is a bare HTTP call to the URL given at invoice creation. So
 * that URL carries OUR signature over the transaction id (PaymentSigner), and a
 * call without a valid one is rejected. A genuine call is still only a nudge:
 * the payment's state is read back with /v2/payment/check, server to server,
 * and nothing in the callback itself is believed.
 *
 * Nothing secret is logged: not the client secret, not the access token, not
 * response bodies — only the operation and the HTTP status.
 */
export class QPayProvider implements PaymentProvider {
  private readonly logger = new Logger(QPayProvider.name);
  private token: { value: string; expiresAt: number } | null = null;

  readonly name = 'qpay';
  readonly supportsPartialRefund = false;

  constructor(
    private readonly config: QPayConfig,
    private readonly signer: PaymentSigner,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  supportsCurrency(currencyCode: string): boolean {
    return currencyCode === 'MNT';
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const invoice = await this.call<QPayInvoiceResponse>('create invoice', 'POST', '/v2/invoice', {
      invoice_code: this.config.invoiceCode,
      // Our transaction id: QPay's own dashboard then points straight back here.
      sender_invoice_no: request.transactionId,
      invoice_receiver_code: 'terminal',
      invoice_description: `${request.description} (${request.reference})`.slice(0, 255),
      amount: Number(minorToDecimalString(request.amountMinor.toString(), request.minorUnit)),
      callback_url: request.callbackUrl,
    });

    if (!invoice?.invoice_id) {
      this.logger.error('QPay create invoice returned no invoice_id.');
      throw new PaymentProviderError();
    }

    return {
      providerTransactionId: String(invoice.invoice_id),
      status: 'PENDING',
      checkout: {
        qrText: invoice.qr_text ?? null,
        qrImage: invoice.qr_image ? `data:image/png;base64,${invoice.qr_image}` : null,
        redirectUrl: invoice.qPay_shortUrl ?? null,
        deeplinks: (invoice.urls ?? [])
          .filter((u) => typeof u.link === 'string')
          .map((u) => ({
            name: u.description ?? u.name ?? 'Bank app',
            link: u.link!,
            logo: u.logo ?? null,
          })),
      },
      // QPay invoices do not expire on their own; we cancel stale ones.
      expiresAt: null,
    };
  }

  async getPayment(providerTransactionId: string): Promise<ProviderPaymentState> {
    const check = await this.call<QPayCheckResponse>('check payment', 'POST', '/v2/payment/check', {
      object_type: 'INVOICE',
      object_id: providerTransactionId,
      offset: { page_number: 1, page_limit: 100 },
    });

    const rows = check?.rows ?? [];
    const paid = rows.filter((row) => row.payment_status === 'PAID');
    const refunded = rows.filter((row) => row.payment_status === 'REFUNDED');

    if (paid.length > 0) {
      return {
        status: 'SUCCEEDED',
        providerPaymentId: String(paid[0]!.payment_id),
        paidAmountMinor: sumMinor(paid.map((row) => row.payment_amount)),
        currencyCode: paid[0]!.payment_currency ?? 'MNT',
        feeMinor: sumMinor(paid.map((row) => row.payment_fee ?? 0)),
      };
    }
    if (refunded.length > 0) {
      return {
        status: 'REFUNDED',
        providerPaymentId: String(refunded[0]!.payment_id),
        paidAmountMinor: sumMinor(refunded.map((row) => row.payment_amount)),
        currencyCode: refunded[0]!.payment_currency ?? 'MNT',
      };
    }
    // A FAILED row is one declined attempt; the invoice stays payable, so the
    // transaction stays PENDING rather than failing the customer's next try.
    const declined = rows.some((row) => row.payment_status === 'FAILED');
    return {
      status: 'PENDING',
      failureReason: declined ? 'A payment attempt was declined.' : null,
    };
  }

  async refundPayment(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    if (request.amountMinor !== request.paymentAmountMinor) {
      return { status: 'FAILED', failureReason: 'QPay refunds whole payments only.' };
    }
    try {
      await this.call(
        'refund payment',
        'DELETE',
        `/v2/payment/refund/${encodeURIComponent(request.providerPaymentId)}`,
        {
          note: request.reason.slice(0, 255),
        },
      );
      return { status: 'SUCCEEDED', providerRefundId: request.providerPaymentId };
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        return { status: 'FAILED', failureReason: 'QPay declined the refund.' };
      }
      throw error;
    }
  }

  async cancelPayment(providerTransactionId: string): Promise<void> {
    try {
      await this.call(
        'cancel invoice',
        'DELETE',
        `/v2/invoice/${encodeURIComponent(providerTransactionId)}`,
      );
    } catch (error) {
      // Best effort. An invoice that cannot be cancelled and is later paid is
      // still settled — the money moved — so this failing is not fatal.
      this.logger.warn(`Could not cancel QPay invoice: ${(error as Error).message}`);
    }
  }

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    const tx = first(request.query.tx);
    if (!tx || !this.signer.verify('webhook:qpay', tx, first(request.query.sig))) {
      return { valid: false, reason: 'Missing or invalid callback signature.' };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const paymentId =
      first(request.query.payment_id) ??
      first(request.query.qpay_payment_id) ??
      first(body.payment_id);
    return {
      valid: true,
      eventKey: `${tx}:${paymentId ?? 'callback'}`,
      transactionId: tx,
      payload: { query: { payment_id: paymentId ?? null }, body },
    };
  }

  // ---------------------------------------------------------------------------

  private async call<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`QPay ${operation} failed: ${(error as Error).name}`);
      throw new PaymentProviderError();
    }

    if (response.status === 401 && !retried) {
      this.token = null;
      return this.call<T>(operation, method, path, body, true);
    }
    if (!response.ok) {
      this.logger.error(`QPay ${operation} returned HTTP ${response.status}.`);
      throw new PaymentProviderError();
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v2/auth/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`QPay authentication failed: ${(error as Error).name}`);
      throw new PaymentProviderError();
    }
    if (!response.ok) {
      this.logger.error(`QPay authentication returned HTTP ${response.status}.`);
      throw new PaymentProviderError();
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new PaymentProviderError();

    // QPay has returned `expires_in` both as seconds-from-now and as an epoch
    // timestamp; either way, never cache past an hour.
    const raw = Number(json.expires_in ?? 0);
    const expiresAt = raw > 1_000_000_000 ? raw * 1000 : Date.now() + raw * 1000;
    this.token = {
      value: json.access_token,
      expiresAt: Math.min(expiresAt, Date.now() + 3_600_000),
    };
    return this.token.value;
  }
}

/** QPay amounts are MNT major units; tugrik has two minor digits in ISO 4217. */
function sumMinor(values: Array<number | string | undefined>): bigint {
  return values.reduce<bigint>((total, value) => {
    const minor = decimalToMinorString(String(value ?? 0), 2);
    return total + BigInt(minor ?? '0');
  }, 0n);
}

function first(value: unknown): string | undefined {
  const v: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}
