import { apiClient } from './api-client';

export type CustomerStatus = 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';

/**
 * One company's record of a person — not the person.
 *
 * The same human may exist in another tenant as a completely separate record
 * with a different name spelling and different notes. That is why the same
 * phone number is legal in two companies and refused twice within one.
 */
export interface Customer {
  id: string;
  firstName: string;
  lastName: string | null;
  /** Composed by the API so eight screens do not each join the two halves. */
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  /** `YYYY-MM-DD`, never a Date — a birthday has no timezone. */
  birthDate: string | null;
  gender: string | null;
  locale: string | null;
  status: CustomerStatus;
  tags: string[];
  preferredEmployeeId: string | null;
  preferredEmployeeName: string | null;

  /**
   * Projections of the appointment and payment tables. Read-only: the API
   * refuses them in a request body, because a client that could set them could
   * make a customer's history disagree with the ledger.
   */
  loyaltyPoints: number;
  totalVisits: number;
  totalNoShows: number;
  /** Minor units as a string — never parse this into a float. */
  totalSpentMinor: string;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  appointmentCount: number;

  createdAt: string;
  updatedAt: string;
}

export interface CustomerQuery {
  search?: string;
  status?: CustomerStatus;
  tag?: string;
  preferredEmployeeId?: string;
  /** A string, because it travels as a query parameter. */
  hasVisited?: 'true' | 'false';
  sortBy?: 'firstName' | 'lastName' | 'createdAt' | 'lastVisitAt' | 'totalVisits';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CustomerInput {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  birthDate?: string | null;
  gender?: string | null;
  locale?: string | null;
  tags?: string[];
  preferredEmployeeId?: string | null;
  status?: CustomerStatus;
}

export interface CustomerAppointment {
  id: string;
  appointmentNumber: string;
  status: string;
  paymentStatus: string;
  startsAt: string;
  endsAt: string;
  branchId: string;
  branchName: string;
  /** Minor units as a string. */
  totalMinor: string;
  currencyCode: string;
  services: Array<{ serviceId: string; name: string; employeeName: string | null }>;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Customers.
 *
 * A duplicate phone or email comes back as a `CONFLICT` whose `details` carry
 * `field` plus `existingCustomerId` — enough for the form to offer "open that
 * customer" instead of leaving somebody to search for a record they were just
 * told exists.
 */
export const customersService = {
  list: (companyId: string, query: CustomerQuery = {}, signal?: AbortSignal) =>
    apiClient.get<Paged<Customer>>(`/companies/${companyId}/customers`, {
      query: { ...query },
      signal,
    }),

  get: (companyId: string, customerId: string, signal?: AbortSignal) =>
    apiClient.get<Customer>(`/companies/${companyId}/customers/${customerId}`, { signal }),

  create: (companyId: string, input: CustomerInput) =>
    apiClient.post<Customer>(`/companies/${companyId}/customers`, input),

  update: (companyId: string, customerId: string, input: Partial<CustomerInput>) =>
    apiClient.patch<Customer>(`/companies/${companyId}/customers/${customerId}`, input),

  /** Soft delete — appointment and payment history keeps resolving. */
  remove: (companyId: string, customerId: string) =>
    apiClient.delete<void>(`/companies/${companyId}/customers/${customerId}`),

  /** Requires `appointment:read:any`, which `customer:read` does not imply. */
  appointments: (
    companyId: string,
    customerId: string,
    query: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    apiClient.get<Paged<CustomerAppointment>>(
      `/companies/${companyId}/customers/${customerId}/appointments`,
      { query: { ...query }, signal },
    ),
};
