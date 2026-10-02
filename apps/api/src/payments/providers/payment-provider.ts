import type { PaymentMethod } from '@prisma/client';

/**
 * ===========================================================================
 * THE SEAM A REAL GATEWAY PLUGS INTO
 * ===========================================================================
 *
 * Every payment in this system is one of two fundamentally different things,
 * and conflating them is how gateway integrations go wrong:
 *
 *   MONEY THAT ALREADY MOVED   cash in the drawer, a card terminal receipt, a
 *                              bank transfer the owner has seen. The software
 *                              is a RECORD of a fact. There is nothing to
 *                              authorise and nothing that can fail.
 *
 *   MONEY THE SYSTEM MOVES     an online charge. There is a request, a remote
 *                              decision, an intent id, a webhook, and a real
 *                              possibility of PENDING for minutes.
 *
 * Both go through this interface so the payments service has exactly one code
 * path, and the difference lives in the implementation rather than in an `if`
 * at every call site.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PROVIDER MAY NOT DO
 * ---------------------------------------------------------------------------
 *
 * A provider never touches the database. It is handed an amount and a
 * reference, it returns an outcome, and the caller writes the row inside its
 * own transaction. That is what lets a gift-card redemption, a ledger entry
 * and an appointment total commit or fail together — a provider that wrote its
 * own row would sit outside that transaction and could survive a rollback.
 *
 * The corollary: a provider must be safe to call more than once for the same
 * `idempotencyKey`. A real gateway gives you that guarantee; the mock one below
 * derives its ids from the key so a retry is visibly the same charge.
 */

export interface ChargeRequest {
  /** Minor units. Always positive — the CHECK constraint refuses anything else. */
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly method: PaymentMethod;
  /**
   * Stable across retries of the same logical payment. A provider MUST return
   * the same outcome for the same key rather than charging twice.
   */
  readonly idempotencyKey: string;
  /** Opaque to the provider; useful in its dashboard. */
  readonly reference: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ChargeOutcome {
  /**
   * SUCCEEDED means the money is settled and the appointment balance may move.
   * AUTHORIZED means held but not captured. PENDING means the answer will
   * arrive later, through a webhook nobody has built yet.
   */
  readonly status: 'SUCCEEDED' | 'AUTHORIZED' | 'PENDING' | 'FAILED';
  readonly provider: string;
  readonly providerIntentId?: string;
  readonly providerChargeId?: string;
  /** Gateway commission, in minor units. Zero for money that moved offline. */
  readonly feeMinor?: bigint;
  readonly failureReason?: string;
}

export interface RefundRequest {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly providerChargeId: string | null;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface RefundOutcome {
  readonly status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  readonly provider: string;
  readonly providerRefundId?: string;
  readonly failureReason?: string;
}

export interface PaymentProvider {
  /** Stable identifier stored on the payment row. Never change it in place. */
  readonly name: string;
  /** Which methods this provider is willing to handle. */
  readonly methods: readonly PaymentMethod[];

  charge(request: ChargeRequest): Promise<ChargeOutcome>;
  refund(request: RefundRequest): Promise<RefundOutcome>;
}

/** Injection token for the provider list, so a test can supply its own. */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
