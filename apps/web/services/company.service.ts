import { apiClient } from './api-client';

export interface Company {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  status: string;
  defaultTimezoneName: string;
  currencyCode: string;
  locale: string;
  registrationNumber: string | null;
  taxNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanySettings {
  slotGranularityMin: number;
  bookingLeadTimeMin: number;
  maxAdvanceBookingDays: number;
  cancellationWindowHours: number;
  holdTtlSeconds: number;
  autoConfirmBookings: boolean;
  allowOnlineBooking: boolean;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  requireDeposit: boolean;
  /** Basis points: 10000 = 100%. Integers — no float ever touches money. */
  depositPercentBps: number;
  noShowFeePercentBps: number;
  lateCancelFeePercentBps: number;
  reminderOffsetsMinutes: number[];
  defaultLocale: string;
}

export interface CompanyBranding {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  fontFamily: string | null;
  bookingPageHeadline: string | null;
  bookingPageBlurb: string | null;
  emailFromName: string | null;
  emailReplyTo: string | null;
}

/**
 * A company, administered from inside it.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CALL TAKES A companyId
 * ---------------------------------------------------------------------------
 *
 * The routes are `/companies/:companyId/...`, so the id has to be in the URL.
 * That is not the client asserting authority: the server validates it against
 * the caller's memberships and answers 404 for a company they do not belong to.
 * Passing the wrong one is an error, never an escalation.
 *
 * The caller should pass the ACTIVE company from the session rather than
 * anything a user typed — see `useCompany`.
 */
export const companyService = {
  get: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<Company>(`/companies/${companyId}`, { signal }),

  update: (companyId: string, input: Partial<Pick<Company,
    'displayName' | 'legalName' | 'contactEmail' | 'contactPhone' | 'defaultTimezoneName' | 'locale'
  >>) => apiClient.patch<Company>(`/companies/${companyId}`, input),

  /** One-way. There is no self-service reactivation — see the API docs. */
  deactivate: (companyId: string, reason?: string) =>
    apiClient.post<Company>(`/companies/${companyId}/deactivate`, reason ? { reason } : {}),

  getSettings: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<CompanySettings>(`/companies/${companyId}/settings`, { signal }),

  updateSettings: (companyId: string, input: Partial<CompanySettings>) =>
    apiClient.patch<CompanySettings>(`/companies/${companyId}/settings`, input),

  getBranding: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<CompanyBranding>(`/companies/${companyId}/branding`, { signal }),

  updateBranding: (companyId: string, input: Partial<CompanyBranding>) =>
    apiClient.patch<CompanyBranding>(`/companies/${companyId}/branding`, input),
};
