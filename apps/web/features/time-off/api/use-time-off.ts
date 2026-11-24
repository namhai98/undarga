'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  timeOffService,
  type CreateTimeOffInput,
  type TimeOffQuery,
  type UpdateTimeOffInput,
} from '@/services/time-off.service';

export const timeOffKeys = {
  all: (companyId: string) => ['time-off', companyId] as const,
  list: (companyId: string, query: TimeOffQuery) =>
    [...timeOffKeys.all(companyId), 'list', query] as const,
};

export function useTimeOff(query: TimeOffQuery = {}) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: timeOffKeys.list(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => timeOffService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    placeholderData: keepPreviousData,
  });
}

/** Time off changes availability, so slot lists go stale with it. */
function useInvalidate() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: timeOffKeys.all(activeCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: ['availability', activeCompanyId] }),
    ]);
}

export function useCreateTimeOff() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateTimeOffInput) => timeOffService.create(activeCompanyId!, input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateTimeOff() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTimeOffInput & { id: string }) =>
      timeOffService.update(activeCompanyId!, id, input),
    onSuccess: () => invalidate(),
  });
}
