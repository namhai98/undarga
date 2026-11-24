import { apiClient } from './api-client';

/**
 * The company's booking rules. Services may override notice, advance window,
 * cancellation deadline and the concurrency cap on their own form; the
 * server resolves service → branch → company → default and enforces them on
 * every booking path. Nothing here is checked only in the browser.
 */
export interface BookingSettings {
  minimumBookingNoticeMinutes: number;
  maximumAdvanceBookingDays: number;
  cancellationDeadlineHours: number;
  reschedulingAllowed: boolean;
  /** As stored: null means "same as the cancellation deadline". */
  rescheduleDeadlineHours: number | null;
  /** What actually applies. */
  effectiveRescheduleDeadlineHours: number;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
}

export type UpdateBookingSettingsInput = Partial<
  Omit<BookingSettings, 'effectiveRescheduleDeadlineHours'>
>;

export const bookingSettingsService = {
  get: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<BookingSettings>(`/companies/${companyId}/booking-settings`, { signal }),

  update: (companyId: string, input: UpdateBookingSettingsInput) =>
    apiClient.patch<BookingSettings>(`/companies/${companyId}/booking-settings`, input),
};
