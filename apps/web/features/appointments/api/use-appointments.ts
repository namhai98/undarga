'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  appointmentsService,
  type AppointmentDetail,
  type AppointmentQuery,
  type CreateAppointmentInput,
  type StatusAction,
} from '@/services/appointments.service';

/** Namespaced by company; the query object is part of the list key. */
export const appointmentKeys = {
  all: (companyId: string) => ['appointments', companyId] as const,
  list: (companyId: string, query: AppointmentQuery) =>
    [...appointmentKeys.all(companyId), 'list', query] as const,
  detail: (companyId: string, appointmentId: string) =>
    [...appointmentKeys.all(companyId), appointmentId] as const,
};

export function useAppointments(query: AppointmentQuery = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: appointmentKeys.list(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => appointmentsService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    placeholderData: keepPreviousData,
  });
}

export function useAppointment(appointmentId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<AppointmentDetail>({
    queryKey: appointmentKeys.detail(activeCompanyId ?? 'none', appointmentId ?? 'none'),
    queryFn: ({ signal }) => appointmentsService.get(activeCompanyId!, appointmentId!, signal),
    enabled: Boolean(activeCompanyId && appointmentId),
  });
}

/**
 * Anything that books, moves or releases a slot changes availability and the
 * customer's history too, so those caches go stale with the appointment list.
 * Invalidate rather than patch: reproducing the server's ordering and slot
 * arithmetic on the client is how the two drift apart.
 */
function useInvalidateBookings() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: appointmentKeys.all(activeCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: ['availability', activeCompanyId] }),
      queryClient.invalidateQueries({ queryKey: ['customers', activeCompanyId] }),
    ]);
}

export function useCreateAppointment() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidateBookings();

  return useMutation<AppointmentDetail, unknown, CreateAppointmentInput>({
    mutationFn: (input) => appointmentsService.create(activeCompanyId!, input),
    onSuccess: () => invalidate(),
    // A lost race (SLOT_TAKEN) means the slot list on screen is stale.
    onError: () => invalidate(),
  });
}

export function useAppointmentAction(appointmentId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateBookings();

  return useMutation<AppointmentDetail, unknown, { action: StatusAction; reason?: string }>({
    mutationFn: ({ action, reason }) =>
      appointmentsService.act(activeCompanyId!, appointmentId, action, reason),
    onSuccess: (appointment) => {
      queryClient.setQueryData(appointmentKeys.detail(activeCompanyId!, appointmentId), appointment);
      void invalidate();
    },
  });
}

export function useCancelAppointment(appointmentId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateBookings();

  return useMutation<AppointmentDetail, unknown, string>({
    mutationFn: (reason) => appointmentsService.cancel(activeCompanyId!, appointmentId, reason),
    onSuccess: (appointment) => {
      queryClient.setQueryData(appointmentKeys.detail(activeCompanyId!, appointmentId), appointment);
      void invalidate();
    },
  });
}

export function useRescheduleAppointment(appointmentId: string) {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidateBookings();

  return useMutation<
    AppointmentDetail,
    unknown,
    { startsAt: string; employeeId?: string; reason?: string }
  >({
    mutationFn: (input) => appointmentsService.reschedule(activeCompanyId!, appointmentId, input),
    onSuccess: () => invalidate(),
    onError: () => invalidate(),
  });
}
