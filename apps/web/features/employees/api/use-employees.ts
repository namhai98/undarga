'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  employeesService,
  type CreateEmployeeInput,
  type EmployeeDetail,
  type EmployeeQuery,
  type EmployeeSchedule,
  type ScheduleInput,
  type EmployeeSummary,
} from '@/services/employees.service';

/** Namespaced by company; the query object is part of the list key. */
export const employeeKeys = {
  all: (companyId: string) => ['employees', companyId] as const,
  list: (companyId: string, query: EmployeeQuery) =>
    [...employeeKeys.all(companyId), 'list', query] as const,
  detail: (companyId: string, employeeId: string) =>
    [...employeeKeys.all(companyId), employeeId] as const,
};

export function useEmployees(query: EmployeeQuery = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: employeeKeys.list(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => employeesService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    // Keep the previous page on screen while the next one loads, so typing in
    // the search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
  });
}

export function useEmployee(employeeId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<EmployeeDetail>({
    queryKey: employeeKeys.detail(activeCompanyId ?? 'none', employeeId ?? 'none'),
    queryFn: ({ signal }) => employeesService.get(activeCompanyId!, employeeId!, signal),
    enabled: Boolean(activeCompanyId && employeeId),
  });
}

export function useCreateEmployee() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<EmployeeDetail, unknown, CreateEmployeeInput>({
    mutationFn: (input) => employeesService.create(activeCompanyId!, input),
    // Invalidate rather than write in: a new employee changes which page it
    // belongs on and where it sorts, and reproducing the server's ordering on
    // the client is how the two drift apart.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) }),
  });
}

export function useUpdateEmployee(employeeId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<EmployeeDetail, unknown, Partial<CreateEmployeeInput>>({
    mutationFn: (input) => employeesService.update(activeCompanyId!, employeeId, input),
    onSuccess: (employee) => {
      queryClient.setQueryData(employeeKeys.detail(activeCompanyId!, employeeId), employee);
      void queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });
    },
  });
}

export function useDeleteEmployee() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, string>({
    mutationFn: (employeeId) => employeesService.remove(activeCompanyId!, employeeId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) }),
  });
}

/** Branch assignment. Both directions invalidate the employee, not just the list. */
export function useEmployeeBranchAssignment(employeeId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });

  return {
    assign: useMutation({
      mutationFn: ({ branchId, isPrimary }: { branchId: string; isPrimary?: boolean }) =>
        employeesService.assignBranch(activeCompanyId!, employeeId, branchId, isPrimary),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (branchId: string) =>
        employeesService.removeBranch(activeCompanyId!, employeeId, branchId),
      onSuccess: invalidate,
    }),
  };
}

export type { EmployeeSummary };

/** Service assignment. Invalidates the employee so its `services` list refreshes. */
export function useEmployeeServiceAssignment(employeeId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });

  return {
    assign: useMutation({
      mutationFn: (serviceId: string) =>
        employeesService.assignService(activeCompanyId!, employeeId, serviceId),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (serviceId: string) =>
        employeesService.removeService(activeCompanyId!, employeeId, serviceId),
      onSuccess: invalidate,
    }),
  };
}

export function useEmployeeSchedule(employeeId: string, branchId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<EmployeeSchedule>({
    queryKey: [
      ...employeeKeys.detail(activeCompanyId ?? 'none', employeeId),
      'schedule',
      branchId ?? 'none',
    ],
    queryFn: ({ signal }) =>
      employeesService.getSchedule(activeCompanyId!, employeeId, branchId!, signal),
    enabled: Boolean(activeCompanyId && branchId),
  });
}

export function useSaveEmployeeSchedule(employeeId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<EmployeeSchedule, unknown, ScheduleInput>({
    mutationFn: (input) => employeesService.putSchedule(activeCompanyId!, employeeId, input),
    onSuccess: (schedule) => {
      queryClient.setQueryData(
        [...employeeKeys.detail(activeCompanyId!, employeeId), 'schedule', schedule.branchId],
        schedule,
      );
      // Availability depends on it.
      void queryClient.invalidateQueries({ queryKey: ['availability'] });
    },
  });
}

/** One-off days for the next 90 days. */
export function useScheduleExceptions(employeeId: string) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: [...employeeKeys.detail(activeCompanyId ?? 'none', employeeId), 'exceptions'],
    queryFn: ({ signal }) => employeesService.listExceptions(activeCompanyId!, employeeId, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useScheduleExceptionChanges(employeeId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: [...employeeKeys.detail(activeCompanyId!, employeeId), 'exceptions'],
    });
    void queryClient.invalidateQueries({ queryKey: ['availability'] });
  };
  return {
    put: useMutation({
      mutationFn: (input: Parameters<typeof employeesService.putException>[2]) =>
        employeesService.putException(activeCompanyId!, employeeId, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (exceptionId: string) =>
        employeesService.removeException(activeCompanyId!, employeeId, exceptionId),
      onSuccess: invalidate,
    }),
  };
}

/** Give the employee a login: an account, a membership and a one-time invitation link. */
export function useEmployeeAccount(employeeId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });
  return {
    link: useMutation({
      mutationFn: ({ email, roleKeys }: { email: string; roleKeys: string[] }) =>
        employeesService.linkAccount(activeCompanyId!, employeeId, email, roleKeys),
      onSuccess: invalidate,
    }),
    unlink: useMutation({
      mutationFn: () => employeesService.unlinkAccount(activeCompanyId!, employeeId),
      onSuccess: invalidate,
    }),
  };
}
