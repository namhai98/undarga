'use client';

import { useQuery } from '@tanstack/react-query';
import { healthService, type ReadinessResult } from '@/services/health.service';

/** Query keys are namespaced by feature so a feature can invalidate its own. */
export const systemStatusKeys = {
  all: ['system-status'] as const,
  readiness: () => [...systemStatusKeys.all, 'readiness'] as const,
};

/**
 * Live readiness of the API and its dependencies.
 *
 * The signal comes from TanStack Query rather than the component so the request
 * is cancelled when the component unmounts — the client threads it through to
 * `fetch`.
 */
export function useReadiness() {
  return useQuery<ReadinessResult>({
    queryKey: systemStatusKeys.readiness(),
    queryFn: ({ signal }) => healthService.readiness(signal),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}
