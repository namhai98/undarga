import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
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

/** How old a signed webhook may be before it is refused as a replay. */
const TOLERANCE_SECONDS = 300;

interface MockPayment {
  amountMinor: bigint;
  currencyCode: string;
  status: ProviderPaymentState['status'];
  paymentId: string | null;
  paidAmountMinor: bigint | null;
  refundedMinor: bigint;
}

/**
 * A local stand-in for a hosted gateway: `PAYMENT_PROVIDER=mock`.
 *
 * Behaves like a real provider in every way that matters to the code calling
 * it — an asynchronous outcome, a signed webhook with a timestamp, a status
 * that must be read back server-side — so the flow is exercised end to end
 * without a merchant account. Refused in production by env validation.
 *
 * State is in memory: it is a simulator, not a ledger. A restart forgets
 * pending payments, which then simply stay PENDING until cancelled.
 *
 * ---------------------------------------------------------------------------
 * DRIVING IT
 * ---------------------------------------------------------------------------
 *
 * `simulate(providerTransactionId, outcome)` decides the payer's side and
 * returns the signed webhook the "gateway" would send. Tests post that
 * webhook; in development `POST /payments/:id/simulate` does it for you.
 * A refund whose amount ends in 13 minor units is declined, so the failure
 * path is reachable on purpose.
 */
export class MockPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(MockPaymentProvider.name);
  private readonly payments = new Map<string, MockPayment>();

  readonly name = 'mock';
  readonly supportsPartialRefund = true;

  constructor(private readonly webhookSecret: string) {}

  supportsCurrency(): boolean {
    return true;
  }

  createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const id = `mock_tx_${digest(request.idempotencyKey)}`;
    if (!this.payments.has(id)) {
      this.payments.set(id, {
        amountMinor: request.amountMinor,
        currencyCode: request.currencyCode,
        status: 'PENDING',
        paymentId: null,
        paidAmountMinor: null,
        refundedMinor: 0n,
      });
    }
    return Promise.resolve({
      providerTransactionId: id,
      status: this.payments.get(id)!.status,
      checkout: { simulated: true, qrText: `MOCK-PAY:${id}`, redirectUrl: null },
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  }

  getPayment(providerTransactionId: string): Promise<ProviderPaymentState> {
    const payment = this.payments.get(providerTransactionId);
    if (!payment)
      return Promise.reject(new PaymentProviderError('Unknown payment at the provider.'));
    return Promise.resolve({
      status: payment.status,
      providerPaymentId: payment.paymentId,
      paidAmountMinor: payment.paidAmountMinor,
      currencyCode: payment.currencyCode,
      feeMinor: payment.paidAmountMinor !== null ? (payment.paidAmountMinor * 2n) / 100n : null,
      failureReason: payment.status === 'FAILED' ? 'Simulated decline.' : null,
    });
  }

  refundPayment(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    const payment = [...this.payments.values()].find(
      (p) => p.paymentId === request.providerPaymentId,
    );
    if (!payment || (payment.status !== 'SUCCEEDED' && payment.status !== 'REFUNDED')) {
      return Promise.resolve({ status: 'FAILED', failureReason: 'Nothing settled to refund.' });
    }
    if (request.amountMinor % 100n === 13n) {
      return Promise.resolve({ status: 'FAILED', failureReason: 'Simulated refund decline.' });
    }
    payment.refundedMinor += request.amountMinor;
    if (payment.refundedMinor >= (payment.paidAmountMinor ?? payment.amountMinor)) {
      payment.status = 'REFUNDED';
    }
    return Promise.resolve({
      status: 'SUCCEEDED',
      providerRefundId: `mock_re_${digest(request.idempotencyKey)}`,
    });
  }

  cancelPayment(providerTransactionId: string): Promise<void> {
    const payment = this.payments.get(providerTransactionId);
    if (payment && payment.status === 'PENDING') payment.status = 'CANCELLED';
    return Promise.resolve();
  }

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    const header = headerValue(request.headers['x-mock-signature']);
    if (!header || !request.rawBody) return { valid: false, reason: 'Missing signature or body.' };

    const parts = Object.fromEntries(
      header.split(',').map((part) => part.split('=', 2) as [string, string]),
    );
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return { valid: false, reason: 'Malformed signature.' };
    if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) {
      return { valid: false, reason: 'Signature timestamp outside tolerance.' };
    }

    const expected = Buffer.from(this.signature(timestamp, request.rawBody));
    const given = Buffer.from(parts.v1 ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { valid: false, reason: 'Signature mismatch.' };
    }

    let event: { id?: unknown; data?: { providerTransactionId?: unknown } };
    try {
      event = JSON.parse(request.rawBody.toString('utf8')) as typeof event;
    } catch {
      return { valid: false, reason: 'Body is not JSON.' };
    }
    if (typeof event.id !== 'string' || typeof event.data?.providerTransactionId !== 'string') {
      return { valid: false, reason: 'Unexpected event shape.' };
    }
    return {
      valid: true,
      eventKey: event.id,
      providerTransactionId: event.data.providerTransactionId,
      payload: event,
    };
  }

  // ---------------------------------------------------------------------------
  // Simulator controls
  // ---------------------------------------------------------------------------

  /**
   * Decide the payer's side, and return the signed webhook a gateway would
   * send about it. `paidAmountMinor` lets a test simulate a short payment.
   */
  simulate(
    providerTransactionId: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PROCESSING',
    options: { paidAmountMinor?: bigint } = {},
  ): { headers: Record<string, string>; rawBody: string } {
    const payment = this.payments.get(providerTransactionId);
    if (!payment) throw new PaymentProviderError('Unknown payment at the provider.');

    payment.status = outcome;
    if (outcome === 'SUCCEEDED') {
      payment.paymentId ??= `mock_pay_${digest(providerTransactionId)}`;
      payment.paidAmountMinor = options.paidAmountMinor ?? payment.amountMinor;
    }
    this.logger.log(`Simulated ${outcome} for ${providerTransactionId}`);

    return this.signedEvent({
      id: `evt_${digest(`${providerTransactionId}:${outcome}`)}`,
      type: `payment.${outcome.toLowerCase()}`,
      data: { providerTransactionId },
    });
  }

  /** Sign an arbitrary event body exactly as `verifyWebhook` expects. */
  signedEvent(event: unknown, timestamp = Math.floor(Date.now() / 1000)) {
    const rawBody = JSON.stringify(event);
    return {
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': `t=${timestamp},v1=${this.signature(timestamp, Buffer.from(rawBody))}`,
      },
      rawBody,
    };
  }

  private signature(timestamp: number, rawBody: Buffer): string {
    return createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
