import { apiClient } from './api-client';

/**
 * Company onboarding (docs/ONBOARDING.md).
 *
 * No call here sends a company id the API would trust on its own: creating
 * one has no company yet, the two company routes go through the API's
 * membership check on `:companyId`, and `status` re-verifies whatever it is
 * asked about.
 */

export type OnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type OnboardingStep = 'COMPANY' | 'BRANCH' | 'BUSINESS_SETTINGS' | 'SERVICES';

export interface OnboardingStatusView {
  status: OnboardingStatus;
  company: {
    id: string;
    slug: string;
    displayName: string;
    status: string;
    defaultTimezoneName: string;
    currencyCode: string;
  } | null;
  steps: { company: boolean; branch: boolean; businessSettings: boolean; services: boolean };
  nextStep: OnboardingStep | null;
  /** Whether this member holds the permissions to finish the wizard. */
  canManage: boolean;
  completedAt: string | null;
}

export interface OnboardingHoursDay {
  dayOfWeek: number;
  isClosed: boolean;
  opensAt?: string;
  closesAt?: string;
}

export interface OnboardingBranchInput {
  name: string;
  timezoneName: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
}

export interface OnboardingBusinessInput {
  currencyCode: string;
  contactEmail?: string;
  contactPhone?: string;
  registrationNumber?: string;
  taxNumber?: string;
  businessHours?: OnboardingHoursDay[];
}

export interface CreateOnboardingCompanyInput {
  company: { displayName: string; legalName?: string; slug: string };
  branch: OnboardingBranchInput;
  business: OnboardingBusinessInput;
}

export interface OnboardingSetupInput {
  company: { displayName: string; legalName?: string };
  branch: OnboardingBranchInput;
  business: OnboardingBusinessInput;
}

export interface InitialServiceInput {
  name: string;
  category?: string;
  durationMin: number;
  priceMinor: string;
  isActive: boolean;
}

export interface CreatedOnboardingCompany {
  company: {
    id: string;
    slug: string;
    displayName: string;
    defaultTimezoneName: string;
    currencyCode: string;
  };
  branch: { id: string; code: string; name: string; timezoneName: string };
  subscription: { status: string; planKey: string; planName: string; trialEndsAt: string | null } | null;
  onboarding: { status: OnboardingStatus; nextStep: OnboardingStep | null };
}

export const onboardingService = {
  status: (companyId?: string | null, signal?: AbortSignal) =>
    apiClient.get<OnboardingStatusView>('/onboarding/status', {
      query: companyId ? { companyId } : {},
      signal,
    }),

  slugAvailability: (slug: string, signal?: AbortSignal) =>
    apiClient.get<{ slug: string; available: boolean; reason: string | null }>(
      '/onboarding/slug-availability',
      { query: { slug }, signal },
    ),

  createCompany: (input: CreateOnboardingCompanyInput) =>
    apiClient.post<CreatedOnboardingCompany>('/onboarding/company', input),

  setup: (companyId: string, input: OnboardingSetupInput) =>
    apiClient.post<{ onboarding: OnboardingStatusView }>(
      `/onboarding/companies/${companyId}/setup`,
      input,
    ),

  complete: (companyId: string, services: InitialServiceInput[]) =>
    apiClient.post<{ services: Array<{ id: string; name: string }>; onboarding: OnboardingStatusView }>(
      `/onboarding/companies/${companyId}/complete`,
      { services },
    ),
};
