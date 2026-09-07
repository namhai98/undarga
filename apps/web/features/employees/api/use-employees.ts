'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  employeesService,
  type CreateEmployeeInput,
  type EmployeeDetail,
  type EmployeeQuery,
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) }),
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
