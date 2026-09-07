import { apiClient } from './api-client';

export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'INACTIVE' | 'TERMINATED';

export interface EmployeeAccount {
  userAccountId: string;
  /**
   * Null until the person accepts their invitation.
   *
   * The account row is only visible to the tenant connection once they are a
   * member of this company, so between linking and accepting there is a real
   * account with no readable address. `status` says which state it is in.
   */
  email: string | null;
  status: string;
}

export interface EmployeeSummary {
  id: string;
  employeeCode: string | null;
  displayName: string;
  status: EmployeeStatus;
  isBookable: boolean;
  acceptsWalkIns: boolean;
  calendarColor: string | null;
  hiredOn: string | null;
  jobTitle: string | null;
  branchIds: string[];
  primaryBranchId: string | null;
  account: EmployeeAccount | null;
  hasAccount: boolean;
}

export interface EmployeeDetail extends EmployeeSummary {
  /** What a booking page may render. */
  publicProfile: {
    displayName: string;
    jobTitle: string | null;
    bio: string | null;
    avatarFileId: string | null;
    languages: string[];
    specialties: string[];
  };
  /** Staff-only. Never merge this into publicProfile. */
  privateProfile: { phone: string | null; emergencyContact: string | null };
  branches: Array<{ branchId: string; name: string | null; code: string | null; isPrimary: boolean }>;
  services: Array<{
    serviceId: string;
    name: string | null;
    durationOverrideMin: number | null;
    /** Minor units as a string — never parse this into a float. */
    priceOverrideMinor: string | null;
    proficiency: number | null;
  }>;
}

export interface EmployeeQuery {
  search?: string;
  status?: EmployeeStatus;
  branchId?: string;
  serviceId?: string;
  hasAccount?: 'true' | 'false';
  sortBy?: 'displayName' | 'employeeCode' | 'createdAt' | 'status';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface EmployeeProfileInput {
  jobTitle?: string | null;
  bio?: string | null;
  languages?: string[];
  specialties?: string[];
  phone?: string | null;
  emergencyContact?: string | null;
}

export interface CreateEmployeeInput {
  displayName: string;
  employeeCode?: string;
  status?: EmployeeStatus;
  isBookable?: boolean;
  acceptsWalkIns?: boolean;
  calendarColor?: string | null;
  hiredOn?: string;
  branchIds?: string[];
  profile?: EmployeeProfileInput;
}

/**
 * Employees — the people a company books work against.
 *
 * Distinct from users: `services/auth.service.ts` deals with logins, this deals
 * with staff. An employee may have no login at all, which is why `account` is
 * nullable rather than assumed.
 */
export const employeesService = {
  list: (companyId: string, query: EmployeeQuery = {}, signal?: AbortSignal) =>
    apiClient.get<{ items: EmployeeSummary[]; total: number; limit: number; offset: number }>(
      `/companies/${companyId}/employees`,
      { query: { ...query }, signal },
    ),

  get: (companyId: string, employeeId: string, signal?: AbortSignal) =>
    apiClient.get<EmployeeDetail>(`/companies/${companyId}/employees/${employeeId}`, { signal }),

  create: (companyId: string, input: CreateEmployeeInput) =>
    apiClient.post<EmployeeDetail>(`/companies/${companyId}/employees`, input),

  update: (companyId: string, employeeId: string, input: Partial<CreateEmployeeInput>) =>
    apiClient.patch<EmployeeDetail>(`/companies/${companyId}/employees/${employeeId}`, input),

  /** Soft delete — history keeps resolving, the person stops being bookable. */
  remove: (companyId: string, employeeId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/employees/${employeeId}`),

  assignBranch: (companyId: string, employeeId: string, branchId: string, isPrimary?: boolean) =>
    apiClient.post<{ items: Array<{ branchId: string; name: string; isPrimary: boolean }> }>(
      `/companies/${companyId}/employees/${employeeId}/branches`,
      { branchId, ...(isPrimary === undefined ? {} : { isPrimary }) },
    ),

  removeBranch: (companyId: string, employeeId: string, branchId: string) =>
    apiClient.delete<void>(
      `/companies/${companyId}/employees/${employeeId}/branches/${branchId}`,
    ),

  assignService: (companyId: string, employeeId: string, serviceId: string) =>
    apiClient.post<unknown>(`/companies/${companyId}/employees/${employeeId}/services`, {
      serviceId,
    }),

  removeService: (companyId: string, employeeId: string, serviceId: string) =>
    apiClient.delete<void>(
      `/companies/${companyId}/employees/${employeeId}/services/${serviceId}`,
    ),

  /** Returns a one-time invitation link. Never a password. */
  linkAccount: (companyId: string, employeeId: string, email: string, roleKeys: string[]) =>
    apiClient.post<{
      employeeId: string;
      userAccountId: string;
      invitation: { id: string; token: string; acceptUrl?: string; expiresAt: string };
    }>(`/companies/${companyId}/employees/${employeeId}/account`, { email, roleKeys }),

  unlinkAccount: (companyId: string, employeeId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/employees/${employeeId}/account`),
};
