'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  publicBookingService,
  type PublicBookingConfirmation,
  type PublicBookingInput,
} from '@/services/public-booking.service';

/**
 * Keyed by slug, not by a signed-in company: the page is the same for every
 * visitor, and a staff member browsing it must not see their own tenant's
 * cache.
 */
export const publicBookingKeys = {
  all: (slug: string) => ['public-booking', slug] as const,
  company: (slug: string) => [...publicBookingKeys.all(slug), 'company'] as const,
  services: (slug: string, branchId: string) =>
    [...publicBookingKeys.all(slug), 'services', branchId] as const,
  employees: (slug: string, branchId: string, serviceId: string) =>
    [...publicBookingKeys.all(slug), 'employees', branchId, serviceId] as const,
  availability: (slug: string, q: { branchId: string; serviceId: string; date: string; employeeId?: string }) =>
    [...publicBookingKeys.all(slug), 'availability', q] as const,
};

export function usePublicCompany(slug: string) {
  return useQuery({
    queryKey: publicBookingKeys.company(slug),
    queryFn: ({ signal }) => publicBookingService.company(slug, signal),
    retry: false,
  });
}

export function usePublicServices(slug: string, branchId: string | null) {
  return useQuery({
    queryKey: publicBookingKeys.services(slug, branchId ?? 'none'),
    queryFn: ({ signal }) => publicBookingService.services(slug, branchId!, signal),
    enabled: Boolean(branchId),
  });
}

export function usePublicEmployees(slug: string, branchId: string | null, serviceId: string | null) {
  return useQuery({
    queryKey: publicBookingKeys.employees(slug, branchId ?? 'none', serviceId ?? 'none'),
    queryFn: ({ signal }) => publicBookingService.employees(slug, branchId!, serviceId!, signal),
    enabled: Boolean(branchId && serviceId),
  });
}

export function usePublicAvailability(
  slug: string,
  q: { branchId: string | null; serviceId: string | null; date: string | null; employeeId?: string | null },
) {
  const query = {
    branchId: q.branchId ?? '',
    serviceId: q.serviceId ?? '',
    date: q.date ?? '',
    ...(q.employeeId ? { employeeId: q.employeeId } : {}),
  };
  return useQuery({
    queryKey: publicBookingKeys.availability(slug, query),
    queryFn: ({ signal }) => publicBookingService.availability(slug, query, signal),
    enabled: Boolean(q.branchId && q.serviceId && q.date),
    placeholderData: keepPreviousData,
    // Times go stale as other people book; refetch rather than trust a copy.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** A button-press check, so a mutation: a price preview must never be cached. */
export function usePreviewPublicPromotion(slug: string) {
  return useMutation({
    mutationFn: (input: { code: string; branchId: string; serviceId: string; employeeId?: string }) =>
      publicBookingService.previewPromotion(slug, input),
  });
}

export function useCreatePublicBooking(slug: string) {
  const queryClient = useQueryClient();
  const refreshTimes = () =>
    queryClient.invalidateQueries({ queryKey: [...publicBookingKeys.all(slug), 'availability'] });

  return useMutation<PublicBookingConfirmation, unknown, PublicBookingInput>({
    mutationFn: (input) => publicBookingService.book(slug, input),
    onSuccess: () => void refreshTimes(),
    // A lost race means the times on screen were stale.
    onError: () => void refreshTimes(),
  });
}
