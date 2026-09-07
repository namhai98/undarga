import { apiClient } from './api-client';

export type CatalogStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface ServiceCategory {
  id: string;
  /** Null for a top-level category. Nesting is capped at one level. */
  parentId: string | null;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  status: CatalogStatus;
  /** Live services in this category — what makes the delete button honest. */
  serviceCount: number;
}

export interface ServiceCategoryDetail extends ServiceCategory {
  children: Array<{ id: string; name: string; status: CatalogStatus; sortOrder: number }>;
}

export interface CategoryInput {
  name: string;
  parentId?: string | null;
  description?: string | null;
  color?: string | null;
  sortOrder?: number;
  status?: CatalogStatus;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Every money field is a STRING of minor units.
 *
 * The columns are BigInt. Above 2^53 a JS number silently rounds, and a price
 * is exactly the value that must not — so nothing here is ever parsed into a
 * float. Formatting for display divides by the currency's minor unit as a
 * string operation; arithmetic, when it arrives, uses BigInt.
 */
export interface ServiceSummary {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  status: CatalogStatus;
  isOnlineBookable: boolean;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** bufferBefore + duration + bufferAfter — the window a booking occupies. */
  totalOccupiedMin: number;
  priceMinor: string;
  currencyCode: string;
  requiresDeposit: boolean;
  depositMinor: string | null;
  requiresEmployee: boolean;
  requiresResource: boolean;
  color: string | null;
  sortOrder: number;
  branchCount: number;
  employeeCount: number;
}

export interface ServiceDetail extends ServiceSummary {
  category: { id: string; name: string; parentId: string | null } | null;
  branches: Array<{
    branchId: string;
    name: string | null;
    code: string | null;
    isAvailable: boolean;
    priceOverrideMinor: string | null;
    durationOverrideMin: number | null;
  }>;
  employees: Array<{
    employeeId: string;
    displayName: string | null;
    employeeStatus: string | null;
    durationOverrideMin: number | null;
    priceOverrideMinor: string | null;
    proficiency: number | null;
  }>;
  resourceRequirements: Array<{
    resourceTypeId: string;
    name: string | null;
    kind: string | null;
    quantity: number;
  }>;
}

export interface ServiceQuery {
  search?: string;
  categoryId?: string;
  branchId?: string;
  employeeId?: string;
  status?: CatalogStatus;
  /** A string, because it travels as a query parameter. */
  isOnlineBookable?: 'true' | 'false';
  sortBy?: 'name' | 'createdAt' | 'durationMin' | 'priceMinor' | 'sortOrder';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ServiceInput {
  name: string;
  code?: string | null;
  description?: string | null;
  categoryId?: string | null;
  status?: CatalogStatus;
  isOnlineBookable?: boolean;
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  priceMinor: string;
  currencyCode?: string;
  requiresDeposit?: boolean;
  depositMinor?: string | null;
  requiresEmployee?: boolean;
  requiresResource?: boolean;
  color?: string | null;
  sortOrder?: number;
  branchIds?: string[];
  employeeIds?: string[];
}

export interface ServiceBranchLink {
  branchId: string;
  code: string | null;
  name: string;
  branchStatus: string;
  isAvailable: boolean;
  priceOverrideMinor: string | null;
  durationOverrideMin: number | null;
}

export interface ServiceEmployeeLink {
  employeeId: string;
  displayName: string;
  employeeStatus: string;
  isBookable: boolean;
  durationOverrideMin: number | null;
  priceOverrideMinor: string | null;
  proficiency: number | null;
}

/**
 * The catalog: what a company sells, and how it is grouped.
 *
 * `/services/:id/employees` and `/employees/:id/services` are two doors onto
 * the same `employee_service` row — see `employees.service.ts`. Either may be
 * called; both invalidate the other's cache.
 */
export const catalogService = {
  listCategories: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{ items: ServiceCategory[] }>(
      `/companies/${companyId}/service-categories`,
      { signal },
    ),

  getCategory: (companyId: string, categoryId: string, signal?: AbortSignal) =>
    apiClient.get<ServiceCategoryDetail>(
      `/companies/${companyId}/service-categories/${categoryId}`,
      { signal },
    ),

  createCategory: (companyId: string, input: CategoryInput) =>
    apiClient.post<ServiceCategoryDetail>(`/companies/${companyId}/service-categories`, input),

  updateCategory: (companyId: string, categoryId: string, input: Partial<CategoryInput>) =>
    apiClient.patch<ServiceCategoryDetail>(
      `/companies/${companyId}/service-categories/${categoryId}`,
      input,
    ),

  /** Refused with a count while the category still holds services or children. */
  deleteCategory: (companyId: string, categoryId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/service-categories/${categoryId}`),

  list: (companyId: string, query: ServiceQuery = {}, signal?: AbortSignal) =>
    apiClient.get<{ items: ServiceSummary[]; total: number; limit: number; offset: number }>(
      `/companies/${companyId}/services`,
      { query: { ...query }, signal },
    ),

  get: (companyId: string, serviceId: string, signal?: AbortSignal) =>
    apiClient.get<ServiceDetail>(`/companies/${companyId}/services/${serviceId}`, { signal }),

  create: (companyId: string, input: ServiceInput) =>
    apiClient.post<ServiceDetail>(`/companies/${companyId}/services`, input),

  update: (companyId: string, serviceId: string, input: Partial<ServiceInput>) =>
    apiClient.patch<ServiceDetail>(`/companies/${companyId}/services/${serviceId}`, input),

  /** Soft delete — appointment history keeps resolving. */
  remove: (companyId: string, serviceId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/services/${serviceId}`),

  assignBranch: (
    companyId: string,
    serviceId: string,
    input: {
      branchId: string;
      isAvailable?: boolean;
      priceOverrideMinor?: string | null;
      durationOverrideMin?: number | null;
    },
  ) =>
    apiClient.post<{ items: ServiceBranchLink[] }>(
      `/companies/${companyId}/services/${serviceId}/branches`,
      input,
    ),

  removeBranch: (companyId: string, serviceId: string, branchId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/services/${serviceId}/branches/${branchId}`),

  assignEmployee: (
    companyId: string,
    serviceId: string,
    input: {
      employeeId: string;
      durationOverrideMin?: number | null;
      priceOverrideMinor?: string | null;
      proficiency?: number | null;
    },
  ) =>
    apiClient.post<{ items: ServiceEmployeeLink[] }>(
      `/companies/${companyId}/services/${serviceId}/employees`,
      input,
    ),

  removeEmployee: (companyId: string, serviceId: string, employeeId: string) =>
    apiClient.delete<void>(
      `/companies/${companyId}/services/${serviceId}/employees/${employeeId}`,
    ),
};
