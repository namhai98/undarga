/**
 * ===========================================================================
 * THE ONLINE PAYMENT PROVIDER CONTRACT
 * ===========================================================================
 *
 * What a gateway (QPay today; Stripe, Golomt, … later) must implement so the
 * rest of the system never knows which one it is talking to. Adding a provider
 * is a new class implementing this interface plus one line in
 * `gateway.module-providers.ts` — no business logic changes.
 *
 * Contrast `../providers/` — the IN-PERSON recorders (cash, card terminal,
 * bank transfer), where staff assert that money already moved. Online money is
 * different in kind: there is a request, a remote decision and a webhook, and
 * the answer may take minutes. The two are kept apart so neither grows `if`s
 * for the other.
 *
 * ---------------------------------------------------------------------------
 * RULES EVERY PROVIDER FOLLOWS
 * ---------------------------------------------------------------------------
 *
 *   - No database access. A provider is given amounts and references and
 *     returns outcomes; the caller writes rows inside its own transaction.
 *   - Idempotent by `idempotencyKey`: the same key must never create a second
 *     charge or a second refund.
 *   - Never trusted from the outside. `verifyWebhook` only proves a delivery is
 *     genuine and says WHICH payment it concerns; the payment's state is then
 *     read back with `getPayment`, server to server. A webhook body — let alone
 *     a browser — never sets a status.
 *   - No card data, ever. Checkout is the provider's hosted page, QR or app
 *     link; this system only stores references to it.
 *   - Secrets come from the environment through AppConfig, never from code.
 */

/** A provider's view of one payment, mapped onto our states. */
export type ProviderPaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface CreatePaymentRequest {
  /** Our `payment_transaction.id`. Stable across retries. */
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  /** ISO 4217 exponent, so a provider that wants major units converts exactly. */
  readonly minorUnit: number;
  /** Shown to the payer by the provider. No personal data. */
  readonly description: string;
  /** Human reference (appointment or invoice number), for the provider's dashboard. */
  readonly reference: string;
  /** Where the provider sends webhooks for THIS payment (signed; see PaymentSigner). */
  readonly callbackUrl: string;
}

/** What the payer needs, all of it public by nature. */
export interface CheckoutDetails {
  /** A hosted payment page to send the payer to. */
  readonly redirectUrl?: string | null;
  /** A QR payload to render (QPay). */
  readonly qrText?: string | null;
  /** A ready-made QR image as a `data:` URL. */
  readonly qrImage?: string | null;
  /** Bank / wallet app links (QPay `urls`). */
  readonly deeplinks?: ReadonlyArray<{ name: string; link: string; logo?: string | null }>;
  /** True for the local simulator, so a UI can offer its test buttons. */
  readonly simulated?: boolean;
}

export interface CreatePaymentResult {
  /** The provider's id for this payment request (QPay: invoice_id). */
  readonly providerTransactionId: string;
  readonly status: ProviderPaymentStatus;
  readonly checkout: CheckoutDetails;
  readonly expiresAt?: Date | null;
}

export interface ProviderPaymentState {
  readonly status: ProviderPaymentStatus;
  /** The provider's id for the money that moved (QPay: payment_id). */
  readonly providerPaymentId?: string | null;
  /** What the provider says was paid. Checked against our amount before settling. */
  readonly paidAmountMinor?: bigint | null;
  readonly currencyCode?: string | null;
  readonly feeMinor?: bigint | null;
  readonly failureReason?: string | null;
}

export interface ProviderRefundRequest {
  readonly providerTransactionId: string | null;
  readonly providerPaymentId: string;
  /** What to refund now. */
  readonly amountMinor: bigint;
  /** The original payment, for providers that refund whole payments only. */
  readonly paymentAmountMinor: bigint;
  readonly currencyCode: string;
  readonly minorUnit: number;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface ProviderRefundResult {
  readonly status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  readonly providerRefundId?: string | null;
  readonly failureReason?: string | null;
}

/** An inbound delivery, exactly as received. */
export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly query: Readonly<Record<string, unknown>>;
  /** The unparsed body. Signatures are computed over bytes, not over JSON. */
  readonly rawBody: Buffer | null;
  readonly body: unknown;
}

export type WebhookVerification =
  | { readonly valid: false; readonly reason: string }
  | {
      readonly valid: true;
      /** Dedupe key: a redelivery of the same event yields the same key. */
      readonly eventKey: string;
      /** Our transaction id, when the provider echoes it back (signed). */
      readonly transactionId?: string | null;
      readonly providerTransactionId?: string | null;
      /** For the debug log only. Never read for state. */
      readonly payload: unknown;
    };

export interface PaymentProvider {
  /** Stored on every transaction. Never rename in place. */
  readonly name: string;
  /** Whether part of a payment can be refunded (QPay: no — whole payments only). */
  readonly supportsPartialRefund: boolean;
  supportsCurrency(currencyCode: string): boolean;

  createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult>;
  getPayment(providerTransactionId: string): Promise<ProviderPaymentState>;
  refundPayment(request: ProviderRefundRequest): Promise<ProviderRefundResult>;
  /** Best effort: stop an unpaid request from being paid later. */
  cancelPayment(providerTransactionId: string): Promise<void>;
  verifyWebhook(request: WebhookRequest): WebhookVerification;
}

/** Injection token for the configured gateway list (empty when payments are off). */
export const PAYMENT_GATEWAY_PROVIDERS = Symbol('PAYMENT_GATEWAY_PROVIDERS');
