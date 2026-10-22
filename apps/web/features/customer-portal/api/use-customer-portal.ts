'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import {
  customerApiClient,
  customerSession,
  refreshSession,
  type CustomerSessionState,
} from '@/services/customer-api-client';
import {
  customerPortalService,
  type PortalAppointmentScope,
  type PortalProfileInput,
} from '@/services/customer-portal.service';

export const portalKeys = {
  all: (slug: string) => ['customer-portal', slug] as const,
  me: (slug: string) => [...portalKeys.all(slug), 'me'] as const,
  appointments: (slug: string, scope: string, offset: number) =>
    [...portalKeys.all(slug), 'appointments', scope, offset] as const,
  appointment: (slug: string, id: string) => [...portalKeys.all(slug), 'appointment', id] as const,
  options: (slug: string, id: string, date: string) =>
    [...portalKeys.all(slug), 'options', id, date] as const,
  payments: (slug: string, offset: number) => [...portalKeys.all(slug), 'payments', offset] as const,
  giftCards: (slug: string) => [...portalKeys.all(slug), 'gift-cards'] as const,
  giftCardHistory: (slug: string, id: string, offset: number) =>
    [...portalKeys.all(slug), 'gift-card', id, offset] as const,
};

const SERVER_SNAPSHOT: CustomerSessionState = { slug: null, status: 'unknown' };

/**
 * The portal session for one business. On first use it tries the refresh
 * cookie, so a reload keeps the customer signed in; until that answers the
 * status is `unknown` and nothing may redirect or render data.
 */
export function useCustomerSession(slug: string): CustomerSessionState {
  const state = useSyncExternalStore(
    (listener) => customerSession.subscribe(listener),
    () => customerSession.snapshot(),
    () => SERVER_SNAPSHOT,
  );

  useEffect(() => {
    customerSession.use(slug);
    if (customerSession.snapshot().status === 'unknown') void refreshSession(true);
  }, [slug]);

  return state.slug === slug ? state : { slug, status: 'unknown' };
}

function useSignedIn(slug: string) {
  return useCustomerSession(slug).status === 'signed-in';
}

export function useRequestCode(slug: string) {
  return useMutation({ mutationFn: (email: string) => customerApiClient.requestCode(slug, email) });
}

export function useVerifyCode(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, code }: { email: string; code: string }) => customerApiClient.verify(slug, email, code),
    // Nothing from a previous visitor on this device survives a new sign-in.
    onMutate: () => queryClient.removeQueries({ queryKey: portalKeys.all(slug) }),
  });
}

export function useCustomerSignOut(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => customerApiClient.logout(slug),
    onSettled: () => queryClient.removeQueries({ queryKey: portalKeys.all(slug) }),
  });
}

export function useCustomerProfile(slug: string) {
  return useQuery({
    queryKey: portalKeys.me(slug),
    queryFn: ({ signal }) => customerPortalService.me(signal),
    enabled: useSignedIn(slug),
  });
}

export function useUpdateProfile(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PortalProfileInput) => customerPortalService.updateMe(input),
    onSuccess: (profile) => queryClient.setQueryData(portalKeys.me(slug), profile),
  });
}

export function useCustomerAppointments(slug: string, scope: PortalAppointmentScope, offset: number, limit = 10) {
  return useQuery({
    queryKey: portalKeys.appointments(slug, scope, offset),
    queryFn: ({ signal }) => customerPortalService.appointments(scope, { limit, offset }, signal),
    enabled: useSignedIn(slug),
    placeholderData: keepPreviousData,
  });
}

export function useCustomerAppointment(slug: string, id: string) {
  return useQuery({
    queryKey: portalKeys.appointment(slug, id),
    queryFn: ({ signal }) => customerPortalService.appointment(id, signal),
    enabled: useSignedIn(slug),
  });
}

export function useCancelAppointment(slug: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => customerPortalService.cancel(id, reason),
    onSuccess: (detail) => {
      queryClient.setQueryData(portalKeys.appointment(slug, id), detail);
      return queryClient.invalidateQueries({ queryKey: portalKeys.all(slug) });
    },
  });
}

export function useRescheduleOptions(slug: string, id: string, date: string | null) {
  return useQuery({
    queryKey: portalKeys.options(slug, id, date ?? 'none'),
    queryFn: ({ signal }) => customerPortalService.rescheduleOptions(id, date!, signal),
    enabled: useSignedIn(slug) && Boolean(date),
  });
}

export function useRescheduleAppointment(slug: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (startsAt: string) => customerPortalService.reschedule(id, startsAt),
    onSuccess: (detail) => {
      queryClient.setQueryData(portalKeys.appointment(slug, detail.id), detail);
      return queryClient.invalidateQueries({ queryKey: portalKeys.all(slug) });
    },
  });
}

export function useCustomerPayments(slug: string, offset: number, limit = 10) {
  return useQuery({
    queryKey: portalKeys.payments(slug, offset),
    queryFn: ({ signal }) => customerPortalService.payments({ limit, offset }, signal),
    enabled: useSignedIn(slug),
    placeholderData: keepPreviousData,
  });
}

export function useCustomerGiftCards(slug: string) {
  return useQuery({
    queryKey: portalKeys.giftCards(slug),
    queryFn: ({ signal }) => customerPortalService.giftCards(signal),
    enabled: useSignedIn(slug),
  });
}

export function useGiftCardHistory(slug: string, id: string | null, offset: number, limit = 10) {
  return useQuery({
    queryKey: portalKeys.giftCardHistory(slug, id ?? 'none', offset),
    queryFn: ({ signal }) => customerPortalService.giftCardHistory(id!, { limit, offset }, signal),
    enabled: useSignedIn(slug) && Boolean(id),
    placeholderData: keepPreviousData,
  });
}
