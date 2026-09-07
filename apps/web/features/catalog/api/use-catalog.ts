'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import { employeeKeys } from '@/features/employees';
import {
  catalogService,
  type CategoryInput,
  type ServiceCategory,
  type ServiceCategoryDetail,
  type ServiceDetail,
  type ServiceInput,
  type ServiceQuery,
} from '@/services/catalog.service';

/** Namespaced by company; the query object is part of the list key. */
export const catalogKeys = {
  all: (companyId: string) => ['catalog', companyId] as const,
  categories: (companyId: string) => [...catalogKeys.all(companyId), 'categories'] as const,
  services: (companyId: string) => [...catalogKeys.all(companyId), 'services'] as const,
  serviceList: (companyId: string, query: ServiceQuery) =>
    [...catalogKeys.services(companyId), 'list', query] as const,
  service: (companyId: string, serviceId: string) =>
    [...catalogKeys.services(companyId), serviceId] as const,
};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function useServiceCategories() {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: catalogKeys.categories(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => catalogService.listCategories(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

/**
 * The two-level tree, built here rather than served nested.
 *
 * The API returns a flat list with `parentId` — a table needs it flat and a
 * picker needs it grouped, and flattening a nested response back out is the
 * more annoying of the two directions.
 */
export function useCategoryTree(): Array<ServiceCategory & { children: ServiceCategory[] }> {
  const { data } = useServiceCategories();
  const items = data?.items ?? [];

  return items
    .filter((c) => c.parentId === null)
    .map((parent) => ({
      ...parent,
      children: items.filter((c) => c.parentId === parent.id),
    }));
}

export function useCreateCategory() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<ServiceCategoryDetail, unknown, CategoryInput>({
    mutationFn: (input) => catalogService.createCategory(activeCompanyId!, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: catalogKeys.categories(activeCompanyId!) }),
  });
}

export function useUpdateCategory() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<
    ServiceCategoryDetail,
    unknown,
    { categoryId: string; input: Partial<CategoryInput> }
  >({
    mutationFn: ({ categoryId, input }) =>
      catalogService.updateCategory(activeCompanyId!, categoryId, input),
    // The whole catalog, not just the categories: renaming one changes the
    // `categoryName` denormalised into every service row of the list response.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: catalogKeys.all(activeCompanyId!) }),
  });
}

export function useDeleteCategory() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, string>({
    mutationFn: (categoryId) => catalogService.deleteCategory(activeCompanyId!, categoryId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: catalogKeys.categories(activeCompanyId!) }),
  });
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export function useServices(query: ServiceQuery = {}) {
  const { activeCompanyId } = useSession();

  return useQuery({
    queryKey: catalogKeys.serviceList(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => catalogService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    // Keep the previous page on screen while the next loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
  });
}

export function useService(serviceId: string | null) {
  const { activeCompanyId } = useSession();

  return useQuery<ServiceDetail>({
    queryKey: catalogKeys.service(activeCompanyId ?? 'none', serviceId ?? 'none'),
    queryFn: ({ signal }) => catalogService.get(activeCompanyId!, serviceId!, signal),
    enabled: Boolean(activeCompanyId && serviceId),
  });
}

export function useCreateService() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<ServiceDetail, unknown, ServiceInput>({
    mutationFn: (input) => catalogService.create(activeCompanyId!, input),
    // Invalidate rather than write in: a new service changes which page it
    // belongs on and where it sorts, and reproducing the server's ordering on
    // the client is how the two drift apart.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all(activeCompanyId!) });
      // Creating with `employeeIds` wrote employee_service rows, which the
      // staff screen reads.
      void queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });
    },
  });
}

export function useUpdateService(serviceId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<ServiceDetail, unknown, Partial<ServiceInput>>({
    mutationFn: (input) => catalogService.update(activeCompanyId!, serviceId, input),
    onSuccess: (service) => {
      queryClient.setQueryData(catalogKeys.service(activeCompanyId!, serviceId), service);
      void queryClient.invalidateQueries({ queryKey: catalogKeys.services(activeCompanyId!) });
    },
  });
}

export function useDeleteService() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, string>({
    mutationFn: (serviceId) => catalogService.remove(activeCompanyId!, serviceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all(activeCompanyId!) });
      void queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });
    },
  });
}

/**
 * Where a service is offered, and who provides it.
 *
 * The employee half writes the same `employee_service` row that the staff
 * screen writes from the other direction, so both caches are invalidated.
 * Skipping the second one is how a screen ends up showing a stale assignment
 * that the database no longer agrees with.
 */
export function useServiceAssignments(serviceId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: catalogKeys.services(activeCompanyId!) });
    void queryClient.invalidateQueries({ queryKey: employeeKeys.all(activeCompanyId!) });
  };

  return {
    assignBranch: useMutation({
      mutationFn: (branchId: string) =>
        catalogService.assignBranch(activeCompanyId!, serviceId, { branchId }),
      onSuccess: invalidate,
    }),
    removeBranch: useMutation({
      mutationFn: (branchId: string) =>
        catalogService.removeBranch(activeCompanyId!, serviceId, branchId),
      onSuccess: invalidate,
    }),
    assignEmployee: useMutation({
      mutationFn: (employeeId: string) =>
        catalogService.assignEmployee(activeCompanyId!, serviceId, { employeeId }),
      onSuccess: invalidate,
    }),
    removeEmployee: useMutation({
      mutationFn: (employeeId: string) =>
        catalogService.removeEmployee(activeCompanyId!, serviceId, employeeId),
      onSuccess: invalidate,
    }),
  };
}
