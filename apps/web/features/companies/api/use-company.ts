'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  companyService,
  type Company,
  type CompanyBranding,
  type CompanySettings,
} from '@/services/company.service';

/**
 * Keys carry the company id.
 *
 * Not decoration: switching company clears the cache, but if a clear were ever
 * missed, a key that could not tell two tenants apart would serve the previous
 * company's settings under the new company's name. With the id in the key the
 * worst case degrades to a cache miss.
 */
export const companyKeys = {
  all: ['company'] as const,
  detail: (companyId: string) => [...companyKeys.all, companyId] as const,
  settings: (companyId: string) => [...companyKeys.detail(companyId), 'settings'] as const,
  branding: (companyId: string) => [...companyKeys.detail(companyId), 'branding'] as const,
};

/**
 * The company the session is currently in.
 *
 * The id comes from the session, never from a prop or the URL. That is a UX
 * decision rather than a security one — the server validates the id against
 * memberships regardless — but taking it from one place means a screen cannot
 * accidentally render company A's name over company B's data.
 */
export function useCompany() {
  const { activeCompanyId } = useSession();

  return useQuery<Company>({
    queryKey: companyKeys.detail(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => companyService.get(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useCompanySettings() {
  const { activeCompanyId } = useSession();

  return useQuery<CompanySettings>({
    queryKey: companyKeys.settings(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => companyService.getSettings(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useCompanyBranding() {
  const { activeCompanyId } = useSession();

  return useQuery<CompanyBranding>({
    queryKey: companyKeys.branding(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => companyService.getBranding(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useUpdateCompany() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof companyService.update>[1]) =>
      companyService.update(activeCompanyId!, input),
    onSuccess: (company) => {
      // Write the response straight into the cache rather than refetching: the
      // PATCH already returned the authoritative row.
      queryClient.setQueryData(companyKeys.detail(company.id), company);
    },
  });
}

export function useUpdateCompanySettings() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Partial<CompanySettings>) =>
      companyService.updateSettings(activeCompanyId!, input),
    onSuccess: (settings) => {
      queryClient.setQueryData(companyKeys.settings(activeCompanyId!), settings);
    },
  });
}

export function useUpdateCompanyBranding() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Partial<CompanyBranding>) =>
      companyService.updateBranding(activeCompanyId!, input),
    onSuccess: (branding) => {
      queryClient.setQueryData(companyKeys.branding(activeCompanyId!), branding);
    },
  });
}
