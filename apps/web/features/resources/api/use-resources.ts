'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  resourcesService,
  type ResourceKind,
  type ResourceWindow,
  type UnavailabilityReason,
} from '@/services/resources.service';

export const resourceKeys = {
  all: (companyId: string) => ['resources', companyId] as const,
  types: (companyId: string) => [...resourceKeys.all(companyId), 'types'] as const,
  list: (companyId: string, branchId: string) =>
    [...resourceKeys.all(companyId), 'list', branchId] as const,
  windows: (companyId: string, id: string) =>
    [...resourceKeys.all(companyId), id, 'windows'] as const,
  blocked: (companyId: string, id: string) =>
    [...resourceKeys.all(companyId), id, 'blocked'] as const,
};

export function useResourceTypes() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: resourceKeys.types(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => resourcesService.types(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useResources(branchId: string) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: resourceKeys.list(activeCompanyId ?? 'none', branchId),
    queryFn: ({ signal }) =>
      resourcesService.list(activeCompanyId!, branchId ? { branchId } : {}, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useResourceWindows(id: string) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: resourceKeys.windows(activeCompanyId ?? 'none', id),
    queryFn: ({ signal }) => resourcesService.availability(activeCompanyId!, id, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useResourceUnavailability(id: string) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: resourceKeys.blocked(activeCompanyId ?? 'none', id),
    queryFn: ({ signal }) => resourcesService.unavailability(activeCompanyId!, id, signal),
    enabled: Boolean(activeCompanyId),
  });
}

/** Every resource change can change which slots exist. */
function useResourceMutation<TInput, TResult>(
  call: (companyId: string, input: TInput) => Promise<TResult>,
) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => call(activeCompanyId!, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: resourceKeys.all(activeCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: ['availability', activeCompanyId] }),
      ]),
  });
}

export const useCreateResourceType = () =>
  useResourceMutation((companyId, input: { key: string; name: string; kind: ResourceKind }) =>
    resourcesService.createType(companyId, input),
  );

export const useCreateResource = () =>
  useResourceMutation(
    (companyId, input: { branchId: string; resourceTypeId: string; name: string }) =>
      resourcesService.create(companyId, input),
  );

export const useSaveResourceWindows = () =>
  useResourceMutation((companyId, input: { id: string; rules: ResourceWindow[] }) =>
    resourcesService.putAvailability(companyId, input.id, input.rules),
  );

export const useAddResourceUnavailability = () =>
  useResourceMutation(
    (
      companyId,
      input: {
        id: string;
        startsAt: string;
        endsAt: string;
        reason: UnavailabilityReason;
        note?: string | null;
        allowConflicts?: boolean;
      },
    ) => {
      const { id, ...body } = input;
      return resourcesService.addUnavailability(companyId, id, body);
    },
  );

export const useRemoveResourceUnavailability = () =>
  useResourceMutation((companyId, input: { id: string; unavailabilityId: string }) =>
    resourcesService.removeUnavailability(companyId, input.id, input.unavailabilityId),
  );
