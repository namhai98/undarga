'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { platformTokenStore } from '@/services/platform-api-client';
import {
  platformService,
  type CompanyStatus,
  type PlatformAuditQuery,
  type PlatformCompanyQuery,
} from '@/services/platform.service';

export const platformKeys = {
  all: ['platform'] as const,
  dashboard: (windowDays: number) => [...platformKeys.all, 'dashboard', windowDays] as const,
  companies: () => [...platformKeys.all, 'companies'] as const,
  companyList: (query: PlatformCompanyQuery) =>
    [...platformKeys.companies(), 'list', query] as const,
  company: (companyId: string) => [...platformKeys.companies(), companyId] as const,
  companyUsers: (companyId: string, query: Record<string, unknown>) =>
    [...platformKeys.company(companyId), 'users', query] as const,
  companySubscription: (companyId: string) =>
    [...platformKeys.company(companyId), 'subscription'] as const,
  audit: (query: PlatformAuditQuery) => [...platformKeys.all, 'audit', query] as const,
};

/**
 * Whether an operator is signed in.
 *
 * `useSyncExternalStore` rather than a context: the store is a module-level
 * singleton that the API client writes to directly — it clears itself on a 401
 * — and a provider would have to mirror that state, leaving two sources of
 * truth for one boolean.
 *
 * The server snapshot is `false`, so the console renders as signed-out during
 * SSR and never flashes a dashboard to someone who is not logged in.
 */
export function usePlatformSession(): boolean {
  return useSyncExternalStore(
    (listener) => platformTokenStore.subscribe(listener),
    () => platformTokenStore.isAuthenticated,
    () => false,
  );
}

export function usePlatformLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      email,
      password,
      mfaCode,
    }: {
      email: string;
      password: string;
      mfaCode?: string;
    }) => platformService.login(email, password, mfaCode),
    /**
     * Cleared BEFORE the request, not after it.
     *
     * A fresh session must not read a previous operator's cached data — but
     * doing this in `onSuccess` runs it at the exact moment the token lands,
     * which is the moment every `enabled: signedIn` query starts fetching.
     * `removeQueries` aborts those in-flight requests, and the console then
     * sits on a skeleton forever because nothing retriggers them.
     *
     * In `onMutate` the cache is already empty when the token arrives, so the
     * first render after sign-in fetches cleanly.
     */
    onMutate: () => {
      queryClient.removeQueries({ queryKey: platformKeys.all });
    },
  });
}

export function usePlatformLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => platformService.logout(),
    // `removeQueries`, not `invalidateQueries`: invalidating keeps the data in
    // the cache and refetches it, which on a signed-out console means a brief
    // render of the previous operator's tenant list.
    onSettled: () => queryClient.removeQueries({ queryKey: platformKeys.all }),
  });
}

export function usePlatformDashboard(windowDays = 30) {
  const signedIn = usePlatformSession();

  return useQuery({
    queryKey: platformKeys.dashboard(windowDays),
    queryFn: ({ signal }) => platformService.dashboard(windowDays, signal),
    enabled: signedIn,
    staleTime: 30_000,
  });
}

export function usePlatformCompanies(query: PlatformCompanyQuery = {}) {
  const signedIn = usePlatformSession();

  return useQuery({
    queryKey: platformKeys.companyList(query),
    queryFn: ({ signal }) => platformService.listCompanies(query, signal),
    enabled: signedIn,
    placeholderData: keepPreviousData,
  });
}

export function usePlatformCompany(companyId: string | null) {
  const signedIn = usePlatformSession();

  return useQuery({
    queryKey: platformKeys.company(companyId ?? 'none'),
    queryFn: ({ signal }) => platformService.getCompany(companyId!, signal),
    enabled: signedIn && Boolean(companyId),
  });
}

export function usePlatformCompanyUsers(
  companyId: string | null,
  query: { status?: string; search?: string; limit?: number; offset?: number } = {},
) {
  const signedIn = usePlatformSession();

  return useQuery({
    queryKey: platformKeys.companyUsers(companyId ?? 'none', query),
    queryFn: ({ signal }) => platformService.listCompanyUsers(companyId!, query, signal),
    enabled: signedIn && Boolean(companyId),
    placeholderData: keepPreviousData,
  });
}

export function usePlatformSubscription(companyId: string | null) {
  const signedIn = usePlatformSession();

  return useQuery({
    queryKey: platformKeys.companySubscription(companyId ?? 'none'),
    queryFn: ({ signal }) => platformService.getSubscription(companyId!, signal),
    enabled: signedIn && Boolean(companyId),
  });
}

/**
 * Suspend, reactivate or switch a company off.
 *
 * Invalidates the dashboard and the audit trail as well as the company: a
 * status change moves a dashboard tile and writes an audit row, and a console
 * where the figure does not move after an operator acts reads as a failed
 * action rather than a stale cache.
 */
export function useChangeCompanyStatus(companyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ status, reason }: { status: CompanyStatus; reason: string }) =>
      platformService.changeStatus(companyId, status, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: platformKeys.all }),
  });
}

export function usePlatformAuditLogs(query: PlatformAuditQuery = {}) {
  const signedIn = usePlatformSession();

  return useQuery({
    queryKey: platformKeys.audit(query),
    queryFn: ({ signal }) => platformService.listAuditLogs(query, signal),
    enabled: signedIn,
    placeholderData: keepPreviousData,
  });
}
