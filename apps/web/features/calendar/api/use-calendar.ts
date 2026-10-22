'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import { calendarService, type CalendarProvider } from '@/services/calendar.service';

export const calendarKeys = {
  all: (companyId: string) => ['calendar', companyId] as const,
  overview: (companyId: string) => [...calendarKeys.all(companyId), 'overview'] as const,
  calendars: (companyId: string, connectionId: string) =>
    [...calendarKeys.all(companyId), 'calendars', connectionId] as const,
  status: (companyId: string, connectionId: string) =>
    [...calendarKeys.all(companyId), 'status', connectionId] as const,
};

export function useCalendarOverview() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: calendarKeys.overview(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => calendarService.overview(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useCalendarChoices(connectionId: string, enabled: boolean) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: calendarKeys.calendars(activeCompanyId ?? 'none', connectionId),
    queryFn: ({ signal }) => calendarService.calendars(activeCompanyId!, connectionId, signal),
    enabled: Boolean(activeCompanyId) && enabled,
    staleTime: 60_000,
  });
}

export function useCalendarStatus(connectionId: string, enabled: boolean) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: calendarKeys.status(activeCompanyId ?? 'none', connectionId),
    queryFn: ({ signal }) => calendarService.status(activeCompanyId!, connectionId, signal),
    enabled: Boolean(activeCompanyId) && enabled,
  });
}

/** Returns the consent URL; the caller sends the browser there. */
export function useStartCalendarConnection() {
  const { activeCompanyId } = useSession();
  return useMutation({
    mutationFn: (input: { provider: CalendarProvider; employeeId: string }) =>
      calendarService.start(activeCompanyId!, input),
  });
}

export function useCompleteCalendarConnection() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { state: string; code: string }) =>
      calendarService.complete(activeCompanyId!, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: calendarKeys.all(activeCompanyId!) }),
  });
}

function useConnectionMutation<TInput, TResult>(
  call: (companyId: string, input: TInput) => Promise<TResult>,
) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => call(activeCompanyId!, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: calendarKeys.all(activeCompanyId!) }),
  });
}

export function useUpdateCalendarConnection() {
  return useConnectionMutation(
    (
      companyId,
      input: {
        connectionId: string;
        calendarId?: string;
        syncCompleted?: boolean;
        useForAvailability?: boolean;
      },
    ) => {
      const { connectionId, ...change } = input;
      return calendarService.update(companyId, connectionId, change);
    },
  );
}

export function useResyncCalendar() {
  return useConnectionMutation((companyId, connectionId: string) =>
    calendarService.resync(companyId, connectionId),
  );
}

export function useDisconnectCalendar() {
  return useConnectionMutation((companyId, connectionId: string) =>
    calendarService.disconnect(companyId, connectionId),
  );
}
