'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  onlinePaymentsService,
  type OnlinePaymentBase,
  type SimulatedOutcome,
} from '@/services/online-payments.service';

export const onlinePaymentKeys = {
  all: ['online-payments'] as const,
  one: (id: string) => [...onlinePaymentKeys.all, id] as const,
  public: (slug: string, id: string) => [...onlinePaymentKeys.all, 'public', slug, id] as const,
};

/** Poll while the outcome is unknown; stop once the provider has answered. */
export const POLL_MS = 3_000;
export function isOpen(status: OnlinePaymentBase['status'] | undefined): boolean {
  return status === 'PENDING' || status === 'PROCESSING';
}

/**
 * One online payment, re-read every few seconds while it is open.
 *
 * Each read asks the server, which re-checks with the provider when its last
 * answer is stale — so this is how the screen learns the outcome even if the
 * provider's webhook is slow. It never sets a status itself.
 */
export function useOnlinePayment(id: string | null) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: onlinePaymentKeys.one(id ?? 'none'),
    queryFn: ({ signal }) => onlinePaymentsService.get(id!, signal),
    enabled: Boolean(id && activeCompanyId),
    refetchInterval: (query) => (isOpen(query.state.data?.status) ? POLL_MS : false),
  });
}

export function useStartAppointmentPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: onlinePaymentsService.startForAppointment,
    onSuccess: (payment) => queryClient.setQueryData(onlinePaymentKeys.one(payment.id), payment),
  });
}

export function usePayInvoice() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, idempotencyKey }: { invoiceId: string; idempotencyKey: string }) =>
      onlinePaymentsService.payInvoice(activeCompanyId!, invoiceId, idempotencyKey),
    onSuccess: (payment) => queryClient.setQueryData(onlinePaymentKeys.one(payment.id), payment),
  });
}

export function useCancelOnlinePayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => onlinePaymentsService.cancel(id),
    onSuccess: (payment) => queryClient.setQueryData(onlinePaymentKeys.one(payment.id), payment),
  });
}

export function useRefundOnlinePayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; amountMinor?: string; reason: string }) =>
      onlinePaymentsService.refund(id, input),
    // A refund moves the appointment's balance and the payments list too.
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** Development only (PAYMENT_PROVIDER=mock). */
export function useSimulatePayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: SimulatedOutcome }) =>
      onlinePaymentsService.simulate(id, outcome),
    onSuccess: (payment) => queryClient.setQueryData(onlinePaymentKeys.one(payment.id), payment),
  });
}

// -- Public ------------------------------------------------------------------

export function usePublicPayment(slug: string, id: string | null, token: string) {
  return useQuery({
    queryKey: onlinePaymentKeys.public(slug, id ?? 'none'),
    queryFn: ({ signal }) => onlinePaymentsService.getPublic(slug, id!, token, signal),
    enabled: Boolean(id),
    refetchInterval: (query) => (isOpen(query.state.data?.status) ? POLL_MS : false),
  });
}

export function useStartPublicPayment(slug: string, token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (idempotencyKey: string) => onlinePaymentsService.startPublic(slug, token, idempotencyKey),
    onSuccess: (payment) => queryClient.setQueryData(onlinePaymentKeys.public(slug, payment.id), payment),
  });
}

export function useSimulatePublicPayment(slug: string, token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: SimulatedOutcome }) =>
      onlinePaymentsService.simulatePublic(slug, id, token, outcome),
    onSuccess: (payment) => queryClient.setQueryData(onlinePaymentKeys.public(slug, payment.id), payment),
  });
}
