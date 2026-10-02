import { apiClient } from './api-client';
import type { Paged } from './customers.service';

/**
 * Payments, gift cards and promotions.
 *
 * One client module because they are one screen's worth of concerns at a till:
 * taking money may spend a gift card and apply a promotion in the same request.
 *
 * Every money field is a STRING of minor units. The columns are BigInt, and
 * above 2^53 a JS number silently rounds — a price is exactly the value that
 * must not. Display goes through `formatMoney`; nothing here parses one.
 */

export type PaymentMethod =
  | 'CASH'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'ONLINE'
  | 'GIFT_CARD'
  | 'WALLET'
  | 'OTHER';

export type PaymentPurpose =
  | 'BOOKING'
  | 'DEPOSIT'
  | 'BALANCE'
  | 'NO_SHOW_FEE'
  | 'CANCELLATION_FEE'
  | 'GIFT_CARD_PURCHASE'
  | 'TIP'
  | 'OTHER';

export type PaymentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface Payment {
  id: string;
  paymentNumber: string;
  method: PaymentMethod;
  purpose: PaymentPurpose;
  status: PaymentStatus;
  amountMinor: string;
  feeMinor: string;
  netMinor: string;
  refundedMinor: string;
  /** What is still reversible. Drives the refund form's maximum. */
  refundableMinor: string;
  currencyCode: string;
  appointmentId: string | null;
  appointmentNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  branchId: string | null;
  branchName: string | null;
  provider: string | null;
  /** The gateway's own id — a reference for tracing a dispute, not a secret. */
  providerReference: string | null;
  failureReason: string | null;
  createdAt: string;
  capturedAt: string | null;
}

export interface PaymentDetail extends Payment {
  refunds: Array<{
    id: string;
    amountMinor: string;
    status: string;
    destination: string;
    reason: string;
    createdAt: string;
    processedAt: string | null;
  }>;
}

export interface PaymentQuery {
  appointmentId?: string;
  customerId?: string;
  branchId?: string;
  method?: PaymentMethod;
  status?: PaymentStatus;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PaymentInput {
  amountMinor: string;
  method: PaymentMethod;
  purpose?: PaymentPurpose;
  currencyCode?: string;
  appointmentId?: string;
  customerId?: string;
  branchId?: string;
  /** Required when `method` is GIFT_CARD. */
  giftCardCode?: string;
  /** Send one from any client that can retry. Stops a double-submit charging twice. */
  idempotencyKey?: string;
  note?: string;
}

export interface PaymentPage {
  items: Payment[];
  total: number;
  limit: number;
  offset: number;
  /** Totals for the WHOLE filter, not just the visible page. */
  summary: { collectedMinor: string; refundedMinor: string; netMinor: string };
}

export interface AppointmentBalance {
  appointmentId: string;
  currencyCode: string;
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
  paidMinor: string;
  refundedMinor: string;
  /** Never negative — an overpayment reports zero owed. */
  outstandingMinor: string;
  isSettled: boolean;
  paymentStatus: string;
}

// ---------------------------------------------------------------------------

/**
 * The EFFECTIVE status: an ACTIVE card past its expiry comes back as EXPIRED.
 * DISABLED is reversible and keeps the balance; VOID is final.
 */
export type GiftCardStatus =
  | 'PENDING_ACTIVATION'
  | 'ACTIVE'
  | 'DEPLETED'
  | 'EXPIRED'
  | 'DISABLED'
  | 'VOID';

export interface GiftCard {
  id: string;
  /** The only part of the code that survives issue. */
  last4: string;
  status: GiftCardStatus;
  initialBalanceMinor: string;
  currentBalanceMinor: string;
  currencyCode: string;
  /** Whether it can be spent right now, and if not, one sentence why. */
  isRedeemable: boolean;
  problem: string | null;
  branchId: string | null;
  /** The owning customer, if the card is assigned to one. */
  issuedToCustomerId: string | null;
  issuedToName: string | null;
  purchasedByCustomerId: string | null;
  purchasedByName: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  depletedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GiftCardQuery {
  status?: GiftCardStatus;
  /** A full code, the last four characters, or the customer / recipient. */
  search?: string;
  issuedToCustomerId?: string;
  limit?: number;
  offset?: number;
}

/** What may change after issue. Never the balance: that moves only through the ledger. */
export interface GiftCardUpdate {
  issuedToCustomerId?: string | null;
  expiresAt?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
}

/** Only ever returned by `issue`, once. */
export interface IssuedGiftCard extends GiftCard {
  code: string;
}

export interface GiftCardTransaction {
  id: string;
  type: 'ISSUE' | 'REDEEM' | 'REFUND' | 'ADJUSTMENT' | 'EXPIRE' | 'VOID';
  /** Signed: negative for a redemption. */
  amountMinor: string;
  balanceAfterMinor: string;
  currencyCode: string;
  appointmentId: string | null;
  paymentId: string | null;
  /** On a REFUND: the redemption it gave back. */
  reversesTransactionId: string | null;
  reason: string | null;
  performedByType: string;
  occurredAt: string;
  /** REDEEM rows only: given back so far, and what can still be refunded here. */
  refundedMinor: string | null;
  refundableMinor: string | null;
}

/** The result of a redemption or refund: the ledger row, and the card after it. */
export interface GiftCardMovement {
  transactionId: string;
  /** True when an idempotency key matched an earlier request — nothing moved twice. */
  replayed: boolean;
  card: GiftCard;
}

export interface GiftCardLookup {
  id: string;
  last4: string;
  status: GiftCardStatus;
  currentBalanceMinor: string;
  currencyCode: string;
  expiresAt: string | null;
  branchId: string | null;
  isRedeemable: boolean;
  /** One sentence, safe to read out to a customer. */
  problem: string | null;
}

// ---------------------------------------------------------------------------

export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type PromotionStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'ARCHIVED';

export interface Promotion {
  id: string;
  name: string;
  description: string | null;
  status: PromotionStatus;
  /** Derived: active, started, not finished, not exhausted. */
  isLive: boolean;
  discountType: DiscountType;
  /** Basis points. 15% is 1500, never 0.15. */
  discountValueBps: number | null;
  discountAmountMinor: string | null;
  maxDiscountMinor: string | null;
  minPurchaseMinor: string | null;
  currencyCode: string;
  startsAt: string;
  endsAt: string | null;
  newCustomersOnly: boolean;
  isAutoApply: boolean;
  isStackable: boolean;
  priority: number;
  maxRedemptions: number | null;
  maxRedemptionsPerCustomer: number | null;
  redeemedCount: number;
  serviceIds: string[];
  branchIds: string[];
  employeeIds: string[];
  /** The live code customers type, or null. */
  code: string | null;
  /** True when the promotion can only be applied with its code. */
  requiresCode: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionInput {
  name: string;
  description?: string | null;
  status?: PromotionStatus;
  discountType: DiscountType;
  discountValueBps?: number;
  discountAmountMinor?: string;
  maxDiscountMinor?: string | null;
  minPurchaseMinor?: string | null;
  currencyCode?: string;
  startsAt: string;
  endsAt?: string | null;
  newCustomersOnly?: boolean;
  isAutoApply?: boolean;
  isStackable?: boolean;
  priority?: number;
  maxRedemptions?: number | null;
  maxRedemptionsPerCustomer?: number | null;
  serviceIds?: string[];
  branchIds?: string[];
  employeeIds?: string[];
  /** Setting a code makes the promotion code-only. `null` removes it. */
  code?: string | null;
}

export interface PromotionQuery {
  search?: string;
  status?: PromotionStatus;
  discountType?: DiscountType;
  activeNow?: 'true' | 'false';
  limit?: number;
  offset?: number;
}

/**
 * A code checked against a booking that has not been made yet. Every amount
 * comes from the server, which priced the service itself.
 */
export interface PromotionValidation {
  valid: boolean;
  /** `INVALID_CODE`, `ENDED`, `LIMIT_REACHED`, `WRONG_BRANCH`… */
  reason: string | null;
  /** One sentence, safe to show a customer. */
  message: string | null;
  originalMinor: string;
  discountMinor: string;
  finalMinor: string;
  currencyCode: string;
  promotion: { name: string; code: string } | null;
}

export interface PromotionQuote {
  subtotalMinor: string;
  applicable: boolean;
  problem: { code: string; message: string } | null;
  promotionId?: string;
  promotionName?: string;
  discountMinor?: string;
  totalMinor?: string;
  cappedBy?: 'maxDiscount' | 'subtotal' | null;
}

const base = (companyId: string) => `/companies/${companyId}`;

export const paymentsService = {
  list: (companyId: string, query: PaymentQuery = {}, signal?: AbortSignal) =>
    apiClient.get<PaymentPage>(`${base(companyId)}/payments`, { query: { ...query }, signal }),

  get: (companyId: string, paymentId: string, signal?: AbortSignal) =>
    apiClient.get<PaymentDetail>(`${base(companyId)}/payments/${paymentId}`, { signal }),

  create: (companyId: string, input: PaymentInput) =>
    apiClient.post<PaymentDetail>(`${base(companyId)}/payments`, input),

  refund: (
    companyId: string,
    paymentId: string,
    input: { amountMinor?: string; reason: string; destination?: string },
  ) => apiClient.post<PaymentDetail>(`${base(companyId)}/payments/${paymentId}/refund`, input),

  balance: (companyId: string, appointmentId: string, signal?: AbortSignal) =>
    apiClient.get<AppointmentBalance>(
      `${base(companyId)}/appointments/${appointmentId}/balance`,
      { signal },
    ),
};

export const giftCardsService = {
  list: (
    companyId: string,
    query: GiftCardQuery = {},
    signal?: AbortSignal,
  ) => apiClient.get<Paged<GiftCard>>(`${base(companyId)}/gift-cards`, { query: { ...query }, signal }),

  get: (companyId: string, giftCardId: string, signal?: AbortSignal) =>
    apiClient.get<GiftCard>(`${base(companyId)}/gift-cards/${giftCardId}`, { signal }),

  /** The response is the only place the code will ever appear. */
  issue: (companyId: string, input: Record<string, unknown>) =>
    apiClient.post<IssuedGiftCard>(`${base(companyId)}/gift-cards`, input),

  /** POST, because a code in a URL lands in logs and cannot be rotated. */
  lookup: (companyId: string, code: string) =>
    apiClient.post<GiftCardLookup>(`${base(companyId)}/gift-cards/lookup`, { code }),

  transactions: (
    companyId: string,
    giftCardId: string,
    query: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    apiClient.get<Paged<GiftCardTransaction>>(
      `${base(companyId)}/gift-cards/${giftCardId}/transactions`,
      { query: { ...query }, signal },
    ),

  update: (companyId: string, giftCardId: string, input: GiftCardUpdate) =>
    apiClient.patch<GiftCard>(`${base(companyId)}/gift-cards/${giftCardId}`, input),

  disable: (companyId: string, giftCardId: string, reason: string) =>
    apiClient.post<GiftCard>(`${base(companyId)}/gift-cards/${giftCardId}/disable`, { reason }),

  enable: (companyId: string, giftCardId: string) =>
    apiClient.post<GiftCard>(`${base(companyId)}/gift-cards/${giftCardId}/enable`, {}),

  /** Send the same `idempotencyKey` on a retry: the server then spends once. */
  redeem: (
    companyId: string,
    giftCardId: string,
    input: { amountMinor: string; note?: string; appointmentId?: string; idempotencyKey: string },
  ) =>
    apiClient.post<GiftCardMovement>(`${base(companyId)}/gift-cards/${giftCardId}/redeem`, input),

  refund: (
    companyId: string,
    giftCardId: string,
    input: { transactionId: string; amountMinor?: string; reason: string; idempotencyKey: string },
  ) =>
    apiClient.post<GiftCardMovement>(`${base(companyId)}/gift-cards/${giftCardId}/refund`, input),

  adjust: (companyId: string, giftCardId: string, input: { amountMinor: string; reason: string }) =>
    apiClient.post<GiftCard>(`${base(companyId)}/gift-cards/${giftCardId}/adjust`, input),

  void: (companyId: string, giftCardId: string, reason: string) =>
    apiClient.post<void>(`${base(companyId)}/gift-cards/${giftCardId}/void`, { reason }),
};

export const promotionsService = {
  list: (
    companyId: string,
    query: PromotionQuery = {},
    signal?: AbortSignal,
  ) => apiClient.get<Paged<Promotion>>(`${base(companyId)}/promotions`, { query: { ...query }, signal }),

  get: (companyId: string, promotionId: string, signal?: AbortSignal) =>
    apiClient.get<Promotion>(`${base(companyId)}/promotions/${promotionId}`, { signal }),

  create: (companyId: string, input: PromotionInput) =>
    apiClient.post<Promotion>(`${base(companyId)}/promotions`, input),

  update: (companyId: string, promotionId: string, input: Partial<PromotionInput>) =>
    apiClient.patch<Promotion>(`${base(companyId)}/promotions/${promotionId}`, input),

  remove: (companyId: string, promotionId: string) =>
    apiClient.delete<void>(`${base(companyId)}/promotions/${promotionId}`),

  /**
   * Check a code for a booking not yet made. Ids only — the server prices the
   * service. Commits nothing; the booking re-validates.
   */
  validate: (
    companyId: string,
    input: { code: string; branchId: string; serviceId: string; employeeId?: string; customerId?: string },
  ) => apiClient.post<PromotionValidation>(`${base(companyId)}/promotions/validate`, input),

  /** Prices without committing. Omit `promotionId` for the best automatic discount. */
  quote: (companyId: string, input: Record<string, unknown>) =>
    apiClient.post<PromotionQuote>(`${base(companyId)}/promotions/quote`, input),

  apply: (companyId: string, promotionId: string, appointmentId: string) =>
    apiClient.post<{ discountMinor: string; totalMinor: string; promotionName: string }>(
      `${base(companyId)}/promotions/apply`,
      { promotionId, appointmentId },
    ),
};
