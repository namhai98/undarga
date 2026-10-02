'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  giftCardsService,
  paymentsService,
  promotionsService,
  type GiftCard,
  type GiftCardMovement,
  type GiftCardQuery,
  type GiftCardUpdate,
  type IssuedGiftCard,
  type PaymentDetail,
  type PaymentInput,
  type PaymentQuery,
  type Promotion,
  type PromotionInput,
  type PromotionQuery,
  type PromotionStatus,
} from '@/services/billing.service';

export const billingKeys = {
  all: (companyId: string) => ['billing', companyId] as const,
  payments: (companyId: string) => [...billingKeys.all(companyId), 'payments'] as const,
  paymentList: (companyId: string, query: PaymentQuery) =>
    [...billingKeys.payments(companyId), 'list', query] as const,
  payment: (companyId: string, id: string) => [...billingKeys.payments(companyId), id] as const,
  giftCards: (companyId: string) => [...billingKeys.all(companyId), 'gift-cards'] as const,
  giftCard: (companyId: string, id: string) => [...billingKeys.giftCards(companyId), id] as const,
  promotions: (companyId: string) => [...billingKeys.all(companyId), 'promotions'] as const,
};

/**
 * Money mutations invalidate the DASHBOARD too.
 *
 * Taking a payment changes today's revenue, the outstanding total and the
 * payment-method breakdown. Leaving the dashboard cached means an owner takes a
 * payment and watches the number not move — which reads as a bug in the
 * payment, not in the cache.
 */
function useMoneyInvalidator() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: billingKeys.all(activeCompanyId!) });
    void queryClient.invalidateQueries({ queryKey: ['analytics', activeCompanyId] });
  };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export function usePayments(query: PaymentQuery = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: billingKeys.paymentList(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => paymentsService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    placeholderData: keepPreviousData,
  });
}

export function usePayment(paymentId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<PaymentDetail>({
    queryKey: billingKeys.payment(activeCompanyId ?? 'none', paymentId ?? 'none'),
    queryFn: ({ signal }) => paymentsService.get(activeCompanyId!, paymentId!, signal),
    enabled: Boolean(activeCompanyId && paymentId),
  });
}

export function useAppointmentBalance(appointmentId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: [...billingKeys.payments(activeCompanyId ?? 'none'), 'balance', appointmentId],
    queryFn: ({ signal }) => paymentsService.balance(activeCompanyId!, appointmentId!, signal),
    enabled: Boolean(activeCompanyId && appointmentId),
  });
}

export function useTakePayment() {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return useMutation<PaymentDetail, unknown, PaymentInput>({
    mutationFn: (input) => paymentsService.create(activeCompanyId!, input),
    onSuccess: invalidate,
  });
}

export function useRefundPayment(paymentId: string) {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return useMutation<
    PaymentDetail,
    unknown,
    { amountMinor?: string; reason: string; destination?: string }
  >({
    mutationFn: (input) => paymentsService.refund(activeCompanyId!, paymentId, input),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Gift cards
// ---------------------------------------------------------------------------

/** Pass `enabled: false` where the viewer may not read gift cards — no request, no 403. */
export function useGiftCards(query: GiftCardQuery = {}, options: { enabled?: boolean } = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: [...billingKeys.giftCards(activeCompanyId ?? 'none'), 'list', query],
    queryFn: ({ signal }) => giftCardsService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId) && options.enabled !== false,
    placeholderData: keepPreviousData,
  });
}

export function useGiftCard(giftCardId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<GiftCard>({
    queryKey: billingKeys.giftCard(activeCompanyId ?? 'none', giftCardId ?? 'none'),
    queryFn: ({ signal }) => giftCardsService.get(activeCompanyId!, giftCardId!, signal),
    enabled: Boolean(activeCompanyId && giftCardId),
    // A 404 is an answer (wrong id, or another company's card), not a blip.
    retry: false,
  });
}

export function useGiftCardTransactions(
  giftCardId: string | null,
  query: { limit?: number; offset?: number } = {},
) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: [
      ...billingKeys.giftCard(activeCompanyId ?? 'none', giftCardId ?? 'none'),
      'ledger',
      query,
    ],
    queryFn: ({ signal }) =>
      giftCardsService.transactions(activeCompanyId!, giftCardId!, query, signal),
    enabled: Boolean(activeCompanyId && giftCardId),
    placeholderData: keepPreviousData,
  });
}

/**
 * Issuing returns the plaintext code, once.
 *
 * The result is deliberately NOT written into the query cache: it would then
 * sit in memory, reachable from devtools, for as long as the cache lives. The
 * component shows it and drops it.
 */
export function useIssueGiftCard() {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return useMutation<IssuedGiftCard, unknown, Record<string, unknown>>({
    mutationFn: (input) => giftCardsService.issue(activeCompanyId!, input),
    onSuccess: invalidate,
  });
}

export function useGiftCardLookup() {
  const { activeCompanyId } = useSession();

  return useMutation({
    mutationFn: (code: string) => giftCardsService.lookup(activeCompanyId!, code),
  });
}

/**
 * Everything that changes one card. Each invalidates all money queries: a
 * redemption moves the card, the list, the customer's cards and the dashboard.
 *
 * `redeem` and `refund` take an idempotency key from the caller, who keeps
 * it for the life of one attempt — so a retry after a timeout is answered with
 * the first result instead of spending the card twice.
 */
export function useGiftCardActions(giftCardId: string) {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return {
    update: useMutation<GiftCard, unknown, GiftCardUpdate>({
      mutationFn: (input) => giftCardsService.update(activeCompanyId!, giftCardId, input),
      onSuccess: invalidate,
    }),
    disable: useMutation<GiftCard, unknown, string>({
      mutationFn: (reason) => giftCardsService.disable(activeCompanyId!, giftCardId, reason),
      onSuccess: invalidate,
    }),
    enable: useMutation<GiftCard, unknown, void>({
      mutationFn: () => giftCardsService.enable(activeCompanyId!, giftCardId),
      onSuccess: invalidate,
    }),
    redeem: useMutation<
      GiftCardMovement,
      unknown,
      { amountMinor: string; note?: string; idempotencyKey: string }
    >({
      mutationFn: (input) => giftCardsService.redeem(activeCompanyId!, giftCardId, input),
      onSuccess: invalidate,
    }),
    refund: useMutation<
      GiftCardMovement,
      unknown,
      { transactionId: string; amountMinor?: string; reason: string; idempotencyKey: string }
    >({
      mutationFn: (input) => giftCardsService.refund(activeCompanyId!, giftCardId, input),
      onSuccess: invalidate,
    }),
    adjust: useMutation<GiftCard, unknown, { amountMinor: string; reason: string }>({
      mutationFn: (input) => giftCardsService.adjust(activeCompanyId!, giftCardId, input),
      onSuccess: invalidate,
    }),
    void: useMutation<void, unknown, string>({
      mutationFn: (reason) => giftCardsService.void(activeCompanyId!, giftCardId, reason),
      onSuccess: invalidate,
    }),
  };
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export function usePromotions(query: PromotionQuery = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: [...billingKeys.promotions(activeCompanyId ?? 'none'), query],
    queryFn: ({ signal }) => promotionsService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    placeholderData: keepPreviousData,
  });
}

export function usePromotion(promotionId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<Promotion>({
    queryKey: [...billingKeys.promotions(activeCompanyId ?? 'none'), promotionId ?? 'none'],
    queryFn: ({ signal }) => promotionsService.get(activeCompanyId!, promotionId!, signal),
    enabled: Boolean(activeCompanyId && promotionId),
  });
}

export function useSavePromotion(promotionId: string | null) {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return useMutation<Promotion, unknown, PromotionInput>({
    mutationFn: (input) =>
      promotionId
        ? promotionsService.update(activeCompanyId!, promotionId, input)
        : promotionsService.create(activeCompanyId!, input),
    onSuccess: invalidate,
  });
}

/** Activate or pause one promotion from the list. */
export function useSetPromotionStatus() {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return useMutation<Promotion, unknown, { promotionId: string; status: PromotionStatus }>({
    mutationFn: ({ promotionId, status }) =>
      promotionsService.update(activeCompanyId!, promotionId, { status }),
    onSuccess: invalidate,
  });
}

/**
 * Check a code for a booking not yet made. A mutation, like the quote: a
 * price must never be served from a cache.
 */
export function useValidatePromotion() {
  const { activeCompanyId } = useSession();

  return useMutation({
    mutationFn: (input: {
      code: string;
      branchId: string;
      serviceId: string;
      employeeId?: string;
      customerId?: string;
    }) => promotionsService.validate(activeCompanyId!, input),
  });
}

export function useArchivePromotion() {
  const { activeCompanyId } = useSession();
  const invalidate = useMoneyInvalidator();

  return useMutation<void, unknown, string>({
    mutationFn: (promotionId) => promotionsService.remove(activeCompanyId!, promotionId),
    onSuccess: invalidate,
  });
}

/**
 * Price a promotion without committing it.
 *
 * A mutation rather than a query even though it changes nothing: it is a POST
 * (the body carries a basket), and it is fired on a button press rather than on
 * render. Modelling it as a query would mean caching a price, which is the one
 * thing a quote must not be.
 */
export function useQuotePromotion() {
  const { activeCompanyId } = useSession();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) => promotionsService.quote(activeCompanyId!, input),
  });
}
