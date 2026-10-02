'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authKeys, useCan, useSession } from '@/features/auth';
import {
  subscriptionService,
  type InvoiceStatus,
  type SubscriptionOverview,
} from '@/services/subscription.service';

export const subscriptionKeys = {
  all: (companyId: string) => ['subscription', companyId] as const,
  overview: (companyId: string) => [...subscriptionKeys.all(companyId), 'overview'] as const,
  invoices: (companyId: string, query: object) =>
    [...subscriptionKeys.all(companyId), 'invoices', query] as const,
};

export function useSubscription() {
  const { activeCompanyId } = useSession();
  const canRead = useCan('settings:billing:read');
  return useQuery({
    queryKey: subscriptionKeys.overview(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => subscriptionService.get(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId) && canRead,
  });
}

export function useInvoices(
  query: { status?: InvoiceStatus; limit?: number; offset?: number } = {},
) {
  const { activeCompanyId } = useSession();
  const canRead = useCan('settings:billing:read');
  return useQuery({
    queryKey: subscriptionKeys.invoices(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => subscriptionService.invoices(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId) && canRead,
    placeholderData: keepPreviousData,
  });
}

type Action =
  | { kind: 'startTrial'; planKey: string }
  | { kind: 'changePlan'; planKey: string }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'reactivate' };

/**
 * Every subscription change. Afterwards the overview is replaced with the
 * server's answer, invoices are refetched, and so is the session context —
 * the company may have just become read-only, or stopped being.
 */
export function useSubscriptionAction() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation<SubscriptionOverview, unknown, Action>({
    mutationFn: (action) => {
      const id = activeCompanyId!;
      switch (action.kind) {
        case 'startTrial':
          return subscriptionService.startTrial(id, action.planKey);
        case 'changePlan':
          return subscriptionService.changePlan(id, action.planKey);
        case 'cancel':
          return subscriptionService.cancel(id, action.reason);
        case 'reactivate':
          return subscriptionService.reactivate(id);
      }
    },
    onSuccess: (overview) => {
      queryClient.setQueryData(subscriptionKeys.overview(activeCompanyId!), overview);
      void queryClient.invalidateQueries({
        queryKey: [...subscriptionKeys.all(activeCompanyId!), 'invoices'],
      });
      void queryClient.invalidateQueries({ queryKey: authKeys.context(activeCompanyId) });
    },
  });
}
