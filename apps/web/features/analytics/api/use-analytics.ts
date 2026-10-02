'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCan, useSession } from '@/features/auth';
import {
  analyticsService,
  type DashboardSummary,
  type ReportName,
  type ReportQuery,
} from '@/services/analytics.service';

export const analyticsKeys = {
  all: (companyId: string) => ['analytics', companyId] as const,
  dashboard: (companyId: string, date: string, branchId?: string) =>
    [...analyticsKeys.all(companyId), 'dashboard', date, branchId ?? 'all'] as const,
  report: (companyId: string, name: string, query: ReportQuery) =>
    [...analyticsKeys.all(companyId), 'report', name, query] as const,
};

/**
 * The dashboard. "Today" is the company's today, worked out by the server from
 * its timezone, so no date is sent unless one is asked for.
 */
export function useDashboard(options: { date?: string; branchId?: string } = {}) {
  const { activeCompanyId } = useSession();
  const canRead = useCan('report:read');

  return useQuery<DashboardSummary>({
    queryKey: analyticsKeys.dashboard(
      activeCompanyId ?? 'none',
      options.date ?? 'today',
      options.branchId,
    ),
    queryFn: ({ signal }) =>
      analyticsService.dashboard(
        activeCompanyId!,
        {
          ...(options.date ? { date: options.date } : {}),
          ...(options.branchId ? { branchId: options.branchId } : {}),
        },
        signal,
      ),
    // No request for a role that would only be refused.
    enabled: Boolean(activeCompanyId) && canRead,
    // A snapshot, not a live feed. Thirty seconds stops a tab left open all day
    // re-running a dozen aggregates on every focus.
    staleTime: 30_000,
  });
}

/**
 * One hook for every report. They share a filter shape and a cache shape, so
 * one hook means one place to fix when the filter grows a field.
 */
export function useReport<T>(name: ReportName, query: ReportQuery, enabled = true) {
  const { activeCompanyId } = useSession();

  return useQuery<T>({
    queryKey: analyticsKeys.report(activeCompanyId ?? 'none', name, query),
    queryFn: ({ signal }) => analyticsService[name](activeCompanyId!, query, signal) as Promise<T>,
    enabled: Boolean(activeCompanyId) && enabled,
    // Keep the last result on screen while a filter change loads.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
