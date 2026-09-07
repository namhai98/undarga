import { apiClient } from './api-client';

export type BranchStatus = 'ACTIVE' | 'TEMPORARILY_CLOSED' | 'INACTIVE';

export interface Branch {
  id: string;
  code: string;
  name: string;
  status: BranchStatus;
  timezoneName: string;
  currencyCode: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  postalCode: string | null;
  countryCode: string | null;
  /**
   * Strings, not numbers. The column is Decimal(9,6) and a JS number cannot
   * hold six decimal places of longitude without rounding — parsing these into
   * floats on the client would undo the reason the column exists.
   */
  latitude: string | null;
  longitude: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Null means "inherit the company", not zero. */
export interface BranchSettings {
  slotGranularityMin: number | null;
  bookingLeadTimeMin: number | null;
  maxAdvanceBookingDays: number | null;
  cancellationWindowHours: number | null;
  allowOnlineBooking: boolean | null;
  requireDeposit: boolean | null;
  depositPercentBps: number | null;
}

export interface BusinessHoursDay {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  isClosed: boolean;
  /** `HH:MM`, 24-hour. */
  opensAt: string | null;
  closesAt: string | null;
  /**
   * Derived by the database from the times — an overnight day such as
   * 22:00 → 06:00. Read-only: never send it.
   */
  crossesMidnight: boolean;
  effectiveFrom: string;
}

export interface CreateBranchInput {
  code: string;
  name: string;
  /**
   * Required, with no client-side fallback to the company default. The BRANCH
   * timezone is what bookings are calculated against, so the UI should prefill
   * the company's and let a human confirm it rather than quietly assume.
   */
  timezoneName: string;
  currencyCode?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  district?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  sortOrder?: number;
}

/**
 * Branches within a company.
 *
 * Both ids live in the path and neither is a client-side authority claim: the
 * server scopes every branch query by the resolved company, so a branch id from
 * another tenant simply 404s.
 */
export const branchesService = {
  list: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{ items: Branch[]; total: number }>(`/companies/${companyId}/branches`, {
      signal,
    }),

  get: (companyId: string, branchId: string, signal?: AbortSignal) =>
    apiClient.get<Branch>(`/companies/${companyId}/branches/${branchId}`, { signal }),

  create: (companyId: string, input: CreateBranchInput) =>
    apiClient.post<Branch>(`/companies/${companyId}/branches`, input),

  update: (companyId: string, branchId: string, input: Partial<CreateBranchInput> & { status?: BranchStatus }) =>
    apiClient.patch<Branch>(`/companies/${companyId}/branches/${branchId}`, input),

  /** Soft delete — the branch stops appearing, its bookings keep resolving. */
  remove: (companyId: string, branchId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/branches/${branchId}`),

  getSettings: (companyId: string, branchId: string, signal?: AbortSignal) =>
    apiClient.get<BranchSettings>(`/companies/${companyId}/branches/${branchId}/settings`, {
      signal,
    }),

  updateSettings: (companyId: string, branchId: string, input: Partial<BranchSettings>) =>
    apiClient.patch<BranchSettings>(
      `/companies/${companyId}/branches/${branchId}/settings`,
      input,
    ),

  getBusinessHours: (companyId: string, branchId: string, signal?: AbortSignal) =>
    apiClient.get<{ days: BusinessHoursDay[] }>(
      `/companies/${companyId}/branches/${branchId}/business-hours`,
      { signal },
    ),

  /**
   * Replaces the whole week. Days omitted become CLOSED — the server treats
   * silence about Sunday as closed on Sunday, so a partial payload is a bug
   * rather than a partial update.
   */
  putBusinessHours: (
    companyId: string,
    branchId: string,
    input: {
      effectiveFrom?: string;
      days: Array<{ dayOfWeek: number; isClosed?: boolean; opensAt?: string; closesAt?: string }>;
    },
  ) =>
    apiClient.put<{ days: BusinessHoursDay[] }>(
      `/companies/${companyId}/branches/${branchId}/business-hours`,
      input,
    ),
};
