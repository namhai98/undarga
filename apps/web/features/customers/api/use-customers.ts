'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCan, useSession } from '@/features/auth';
import {
  customersService,
  type Customer,
  type CustomerInput,
  type CustomerQuery,
} from '@/services/customers.service';

/** Namespaced by company; the query object is part of the list key. */
export const customerKeys = {
  all: (companyId: string) => ['customers', companyId] as const,
  list: (companyId: string, query: CustomerQuery) =>
    [...customerKeys.all(companyId), 'list', query] as const,
  detail: (companyId: string, customerId: string) =>
    [...customerKeys.all(companyId), customerId] as const,
  appointments: (companyId: string, customerId: string) =>
    [...customerKeys.detail(companyId, customerId), 'appointments'] as const,
};

export function useCustomers(query: CustomerQuery = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: customerKeys.list(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => customersService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    // Keep the previous page on screen while the next loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
  });
}

export function useCustomer(customerId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<Customer>({
    queryKey: customerKeys.detail(activeCompanyId ?? 'none', customerId ?? 'none'),
    queryFn: ({ signal }) => customersService.get(activeCompanyId!, customerId!, signal),
    enabled: Boolean(activeCompanyId && customerId),
  });
}

/**
 * A customer's booking history.
 *
 * Gated on `appointment:read:any`, which `customer:read` does not imply — so
 * the query is disabled rather than fired and 403'd. Firing it anyway would put
 * a red error panel on the detail page of every stylist who is allowed to see
 * the customer but not their whole history.
 */
export function useCustomerAppointments(customerId: string | null, limit = 20) {
  const { activeCompanyId } = useSession();
  const canRead = useCan('appointment:read:any');

  return useQuery({
    queryKey: [...customerKeys.appointments(activeCompanyId ?? 'none', customerId ?? 'none'), limit],
    queryFn: ({ signal }) =>
      customersService.appointments(activeCompanyId!, customerId!, { limit }, signal),
    enabled: Boolean(activeCompanyId && customerId && canRead),
  });
}

export function useCreateCustomer() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<Customer, unknown, CustomerInput>({
    mutationFn: (input) => customersService.create(activeCompanyId!, input),
    // Invalidate rather than write in: a new customer changes which page it
    // belongs on and where it sorts, and reproducing the server's ordering on
    // the client is how the two drift apart.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customerKeys.all(activeCompanyId!) }),
  });
}

export function useUpdateCustomer(customerId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<Customer, unknown, Partial<CustomerInput>>({
    mutationFn: (input) => customersService.update(activeCompanyId!, customerId, input),
    onSuccess: (customer) => {
      queryClient.setQueryData(customerKeys.detail(activeCompanyId!, customerId), customer);
      void queryClient.invalidateQueries({ queryKey: customerKeys.all(activeCompanyId!) });
    },
  });
}

export function useDeleteCustomer() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, string>({
    mutationFn: (customerId) => customersService.remove(activeCompanyId!, customerId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customerKeys.all(activeCompanyId!) }),
  });
}

export type { Customer };
