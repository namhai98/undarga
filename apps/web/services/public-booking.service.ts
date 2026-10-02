import { apiClient } from './api-client';

/**
 * The public booking page's API. Every call is `anonymous`: no bearer token is
 * attached, and a visitor who happens to be signed in as staff is treated
 * exactly like everyone else.
 *
 * Nothing here decides what is bookable. The server filters every list and
 * re-validates every booking; the page only renders what it is given.
 */

export interface PublicBranch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
}

export interface PublicCompany {
  slug: string;
  name: string;
  locale: string;
  currencyCode: string;
  branding: {
    primaryColor: string;
    accentColor: string;
    headline: string | null;
    blurb: string | null;
  } | null;
  branches: PublicBranch[];
}

export interface PublicCategory {
  id: string;
  name: string;
}

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  /** Minor units as a string — format with `formatMoney`, never parse. */
  priceMinor: string;
  currencyCode: string;
  requiresEmployee: boolean;
  color: string | null;
  categoryId: string | null;
}

export interface PublicEmployee {
  id: string;
  name: string;
  jobTitle: string | null;
}

export interface PublicSlot {
  /** ISO-8601 with the branch offset. Send it back verbatim when booking. */
  startAt: string;
  endAt: string;
  employeeIds: string[];
}

export type PublicUnavailableReason =
  | 'BRANCH_CLOSED'
  | 'SERVICE_NOT_OFFERED_AT_BRANCH'
  | 'NO_ELIGIBLE_EMPLOYEE'
  | 'NO_ELIGIBLE_RESOURCE'
  | 'DATE_IN_PAST'
  | 'BEYOND_BOOKING_WINDOW';

export interface PublicAvailability {
  date: string;
  timezone: string;
  durationMin: number;
  unavailableReason: PublicUnavailableReason | null;
  slots: PublicSlot[];
}

export interface PublicBookingInput {
  branchId: string;
  serviceId: string;
  employeeId?: string;
  startsAt: string;
  customer: { firstName: string; lastName?: string; phone: string; email?: string };
  note?: string;
  /** Re-checked and priced by the server; the booking fails if it no longer applies. */
  promotionCode?: string;
}

/** A code checked against a basket. Never shows the customer anything internal. */
export interface PublicPromotionPreview {
  valid: boolean;
  reason: string | null;
  message: string | null;
  originalMinor: string;
  discountMinor: string;
  finalMinor: string;
  currencyCode: string;
  promotion: { name: string; code: string } | null;
}

export interface PublicBookingConfirmation {
  /** The reference a customer quotes. There is no other id. */
  appointmentNumber: string;
  status: 'CONFIRMED' | 'PENDING';
  startsAt: string;
  endsAt: string;
  timezone: string;
  branch: { name: string; address: string | null; phone: string | null };
  service: { name: string; durationMin: number };
  employee: { name: string } | null;
  /** As recorded at booking time: `amountMinor` is what is owed. */
  price: { originalMinor: string; discountMinor: string; amountMinor: string; currencyCode: string };
  promotion: { name: string; code: string | null } | null;
  customer: { firstName: string };
}

const base = (slug: string) => `/public/companies/${encodeURIComponent(slug)}`;

export const publicBookingService = {
  company: (slug: string, signal?: AbortSignal) =>
    apiClient.get<PublicCompany>(base(slug), { anonymous: true, signal }),

  services: (slug: string, branchId: string, signal?: AbortSignal) =>
    apiClient.get<{ categories: PublicCategory[]; services: PublicService[] }>(
      `${base(slug)}/branches/${branchId}/services`,
      { anonymous: true, signal },
    ),

  employees: (slug: string, branchId: string, serviceId: string, signal?: AbortSignal) =>
    apiClient.get<PublicEmployee[]>(
      `${base(slug)}/branches/${branchId}/services/${serviceId}/employees`,
      { anonymous: true, signal },
    ),

  availability: (
    slug: string,
    query: { branchId: string; serviceId: string; date: string; employeeId?: string },
    signal?: AbortSignal,
  ) =>
    apiClient.get<PublicAvailability>(`${base(slug)}/availability`, {
      anonymous: true,
      query: { ...query },
      signal,
    }),

  /** Advisory only: the booking itself re-validates the code. */
  previewPromotion: (
    slug: string,
    input: { code: string; branchId: string; serviceId: string; employeeId?: string },
  ) =>
    apiClient.post<PublicPromotionPreview>(`${base(slug)}/promotions/validate`, input, {
      anonymous: true,
    }),

  /** Never retried by the client: a retried POST is how you double-book. */
  book: (slug: string, input: PublicBookingInput) =>
    apiClient.post<PublicBookingConfirmation>(`${base(slug)}/bookings`, input, { anonymous: true }),
};
