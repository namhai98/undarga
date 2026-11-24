import { apiClient } from './api-client';

export type TimeOffType =
  | 'VACATION'
  | 'SICK'
  | 'PERSONAL'
  | 'UNPAID'
  | 'TRAINING'
  | 'PUBLIC_HOLIDAY'
  | 'OTHER';

export type TimeOffStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface TimeOffConflict {
  appointmentId: string;
  appointmentNumber: string;
  startsAt: string;
  endsAt?: string;
}

export interface TimeOff {
  id: string;
  employeeId: string;
  employeeName: string;
  type: TimeOffType;
  status: TimeOffStatus;
  startsAt: string;
  endsAt: string;
  isPaid: boolean;
  reason: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Booked appointments it overlaps (only after `allowConflicts`). */
  conflicts?: TimeOffConflict[];
}

export interface TimeOffQuery {
  employeeId?: string;
  status?: TimeOffStatus;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface CreateTimeOffInput {
  /** Omit to request time off for yourself (the staff profile linked to your login). */
  employeeId?: string;
  type: TimeOffType;
  startsAt: string;
  endsAt: string;
  isPaid?: boolean;
  reason?: string | null;
  /** Record it even though it overlaps booked appointments. */
  allowConflicts?: boolean;
}

export interface UpdateTimeOffInput {
  type?: TimeOffType;
  startsAt?: string;
  endsAt?: string;
  isPaid?: boolean;
  reason?: string | null;
  status?: 'APPROVED' | 'REJECTED' | 'CANCELLED';
  rejectionReason?: string | null;
  allowConflicts?: boolean;
}

/**
 * Employee time off. Approved time off removes those times from availability
 * on every booking path; the server decides who may approve.
 */
export const timeOffService = {
  list: (companyId: string, query: TimeOffQuery = {}, signal?: AbortSignal) =>
    apiClient.get<{ items: TimeOff[]; total: number; limit: number; offset: number }>(
      `/companies/${companyId}/time-off`,
      { query: { ...query }, signal },
    ),

  create: (companyId: string, input: CreateTimeOffInput) =>
    apiClient.post<TimeOff>(`/companies/${companyId}/time-off`, input),

  update: (companyId: string, id: string, input: UpdateTimeOffInput) =>
    apiClient.patch<TimeOff>(`/companies/${companyId}/time-off/${id}`, input),

  cancel: (companyId: string, id: string) =>
    apiClient.delete<TimeOff>(`/companies/${companyId}/time-off/${id}`),
};
