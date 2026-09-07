'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  branchesService,
  type Branch,
  type BranchSettings,
  type BusinessHoursDay,
  type CreateBranchInput,
} from '@/services/branches.service';

/** Namespaced by company, for the same reason company keys are. */
export const branchKeys = {
  all: (companyId: string) => ['branches', companyId] as const,
  list: (companyId: string) => [...branchKeys.all(companyId), 'list'] as const,
  detail: (companyId: string, branchId: string) =>
    [...branchKeys.all(companyId), branchId] as const,
  settings: (companyId: string, branchId: string) =>
    [...branchKeys.detail(companyId, branchId), 'settings'] as const,
  businessHours: (companyId: string, branchId: string) =>
    [...branchKeys.detail(companyId, branchId), 'business-hours'] as const,
};

export function useBranches() {
  const { activeCompanyId } = useSession();

  return useQuery<{ items: Branch[]; total: number }>({
    queryKey: branchKeys.list(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => branchesService.list(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useBranch(branchId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<Branch>({
    queryKey: branchKeys.detail(activeCompanyId ?? 'none', branchId ?? 'none'),
    queryFn: ({ signal }) => branchesService.get(activeCompanyId!, branchId!, signal),
    enabled: Boolean(activeCompanyId && branchId),
  });
}

export function useBranchSettings(branchId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<BranchSettings>({
    queryKey: branchKeys.settings(activeCompanyId ?? 'none', branchId ?? 'none'),
    queryFn: ({ signal }) => branchesService.getSettings(activeCompanyId!, branchId!, signal),
    enabled: Boolean(activeCompanyId && branchId),
  });
}

export function useBusinessHours(branchId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<{ days: BusinessHoursDay[] }>({
    queryKey: branchKeys.businessHours(activeCompanyId ?? 'none', branchId ?? 'none'),
    queryFn: ({ signal }) => branchesService.getBusinessHours(activeCompanyId!, branchId!, signal),
    enabled: Boolean(activeCompanyId && branchId),
  });
}

export function useCreateBranch() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateBranchInput) => branchesService.create(activeCompanyId!, input),
    // Invalidate rather than write into the cache: a new branch changes the
    // ORDER of the list (sortOrder, then name), and reproducing the server's
    // ordering on the client is how the two drift apart.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: branchKeys.list(activeCompanyId!) }),
  });
}

export function useUpdateBranch(branchId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof branchesService.update>[2]) =>
      branchesService.update(activeCompanyId!, branchId, input),
    onSuccess: (branch) => {
      queryClient.setQueryData(branchKeys.detail(activeCompanyId!, branchId), branch);
      void queryClient.invalidateQueries({ queryKey: branchKeys.list(activeCompanyId!) });
    },
  });
}

export function useDeleteBranch() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (branchId: string) => branchesService.remove(activeCompanyId!, branchId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: branchKeys.all(activeCompanyId!) }),
  });
}

export function usePutBusinessHours(branchId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof branchesService.putBusinessHours>[2]) =>
      branchesService.putBusinessHours(activeCompanyId!, branchId, input),
    onSuccess: (hours) => {
      queryClient.setQueryData(branchKeys.businessHours(activeCompanyId!, branchId), hours);
    },
  });
}
