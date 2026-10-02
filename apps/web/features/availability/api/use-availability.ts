'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  availabilityService,
  type AvailabilityDay,
  type AvailabilityQuery,
} from '@/services/availability.service';
import { catalogService, type ServiceSummary } from '@/services/catalog.service';

/** Namespaced by company; every query field is part of the key. */
export const availabilityKeys = {
  all: (companyId: string) => ['availability', companyId] as const,
  day: (companyId: string, query: AvailabilityQuery) =>
    [...availabilityKeys.all(companyId), query] as const,
};

/**
 * Availability for one branch / service / date. Disabled until branch, service
 * and date are all chosen — a partial query is not a real question.
 */
export function useAvailability(query: Partial<AvailabilityQuery>) {
  const { activeCompanyId } = useSession();
  const ready = Boolean(query.branchId && query.serviceId && query.date);

  return useQuery<AvailabilityDay>({
    queryKey: availabilityKeys.day(activeCompanyId ?? 'none', query as AvailabilityQuery),
    queryFn: ({ signal }) =>
      availabilityService.getDay(activeCompanyId!, query as AvailabilityQuery, signal),
    enabled: Boolean(activeCompanyId) && ready,
    // Availability is advisory and cheap to refetch; keep it fresh but don't
    // blank the grid while the next day loads.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** Active services, for the picker. Bookability is still decided server-side. */
export function useBookableServices() {
  const { activeCompanyId } = useSession();

  return useQuery<{ items: ServiceSummary[] }>({
    queryKey: [...availabilityKeys.all(activeCompanyId ?? 'none'), 'services'] as const,
    queryFn: ({ signal }) =>
      catalogService.list(activeCompanyId!, { status: 'ACTIVE', limit: 100 }, signal),
    enabled: Boolean(activeCompanyId),
  });
}
