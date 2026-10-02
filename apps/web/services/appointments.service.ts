import { apiClient } from './api-client';

export type AppointmentStatus =
  | 'HOLD'
  | 'PENDING'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'EXPIRED';

export type BookingSource = 'ONLINE' | 'WALK_IN' | 'PHONE' | 'STAFF' | 'API' | 'IMPORT';

export interface AppointmentSummary {
  id: string;
  appointmentNumber: string;
  status: AppointmentStatus;
  paymentStatus: string;
  source: BookingSource;
  /**
   * ISO-8601 with the BRANCH offset, e.g. `2026-10-06T09:00:00+08:00`. Render
   * the wall-clock part as-is — it is the time the customer was told.
   */
  startsAt: string;
  endsAt: string;
  timezone: string;
  branch: { id: string; name: string };
  customer: { id: string; name: string; phone: string | null; email: string | null };
  /** Booking-time service name — later renames do not reach it. */
  service: { id: string; name: string } | null;
  employee: { id: string; name: string } | null;
  resources: Array<{ id: string; name: string }>;
  /** Minor units as a string. Format with `formatMoney`, never parse. */
  totalMinor: string;
  currencyCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppointmentHistoryEntry {
  id: string;
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus;
  actorType: string;
  actorLabel: string | null;
  reason: string | null;
  changedAt: string;
}

export interface AppointmentLink {
  id: string;
  appointmentNumber: string;
  startsAt: string;
}

export interface AppointmentDetail extends AppointmentSummary {
  customerNote: string | null;
  internalNote: string | null;
  /** Before discounts. `totalMinor` is what is owed. */
  subtotalMinor: string;
  discountMinor: string;
  /** Promotions as they were when applied — later edits to a promotion do not change these. */
  promotions: AppointmentPromotion[];
  /** The buffered window the booking occupies — for display only. */
  reservedFrom: string | null;
  reservedTo: string | null;
  durationMin: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  snapshot: Record<string, unknown> | null;
  confirmedAt: string | null;
  checkedInAt: string | null;
  completedAt: string | null;
  noShowAt: string | null;
  cancellation: {
    cancelledAt: string;
    reason: string | null;
    byType: string | null;
    byId: string | null;
  } | null;
  rescheduledFrom: AppointmentLink | null;
  rescheduledTo: AppointmentLink | null;
  history: AppointmentHistoryEntry[];
  version: number;
}

export interface AppointmentPromotion {
  promotionId: string;
  name: string;
  code: string | null;
  discountMinor: string;
}

export interface AppointmentQuery {
  branchId?: string;
  employeeId?: string;
  resourceId?: string;
  serviceId?: string;
  customerId?: string;
  /** Comma-separated statuses. */
  status?: string;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CreateAppointmentInput {
  branchId: string;
  serviceId: string;
  customerId: string;
  /** Omit to let the server assign the first eligible employee. */
  employeeId?: string;
  resourceId?: string;
  /** Exactly the `startAt` the availability endpoint returned. */
  startsAt: string;
  source?: BookingSource;
  customerNote?: string | null;
  internalNote?: string | null;
  /** Checked and priced by the server inside the booking; the booking fails if it no longer applies. */
  promotionCode?: string;
}

export type StatusAction = 'confirm' | 'start' | 'complete' | 'no-show';

/**
 * Appointments.
 *
 * Every write is re-validated by the server against the availability engine
 * and a database constraint; nothing here decides whether a time is free.
 */
export const appointmentsService = {
  list: (companyId: string, query: AppointmentQuery = {}, signal?: AbortSignal) =>
    apiClient.get<{ items: AppointmentSummary[]; total: number; limit: number; offset: number }>(
      `/companies/${companyId}/appointments`,
      { query: { ...query }, signal },
    ),

  get: (companyId: string, appointmentId: string, signal?: AbortSignal) =>
    apiClient.get<AppointmentDetail>(`/companies/${companyId}/appointments/${appointmentId}`, {
      signal,
    }),

  create: (companyId: string, input: CreateAppointmentInput) =>
    apiClient.post<AppointmentDetail>(`/companies/${companyId}/appointments`, input),

  act: (companyId: string, appointmentId: string, action: StatusAction, reason?: string) =>
    apiClient.post<AppointmentDetail>(
      `/companies/${companyId}/appointments/${appointmentId}/${action}`,
      reason ? { reason } : {},
    ),

  cancel: (companyId: string, appointmentId: string, reason: string) =>
    apiClient.post<AppointmentDetail>(
      `/companies/${companyId}/appointments/${appointmentId}/cancel`,
      { reason },
    ),

  /** Returns the NEW appointment; the original becomes CANCELLED. */
  reschedule: (
    companyId: string,
    appointmentId: string,
    input: { startsAt: string; employeeId?: string; resourceId?: string; reason?: string },
  ) =>
    apiClient.post<AppointmentDetail>(
      `/companies/${companyId}/appointments/${appointmentId}/reschedule`,
      input,
    ),
};
