import { apiClient } from './api-client';

export type CalendarProvider = 'google' | 'microsoft';
export type CalendarConnectionStatus = 'ACTIVE' | 'NEEDS_REAUTH' | 'ERROR';

export interface CalendarProviderInfo {
  provider: CalendarProvider;
  label: string;
  /** False when this server has no OAuth credentials for it: it cannot be connected. */
  configured: boolean;
  scopes: string[];
}

/** A connection as the API shows it. Tokens never leave the server. */
export interface CalendarConnection {
  id: string;
  employeeId: string;
  provider: CalendarProvider;
  status: CalendarConnectionStatus;
  accountEmail: string | null;
  calendarId: string;
  calendarName: string | null;
  calendarTimeZone: string | null;
  syncCompleted: boolean;
  useForAvailability: boolean;
  lastSyncAt: string | null;
  busySyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Events whose last sync attempt failed. */
  failedEvents: number;
  createdAt: string;
}

export interface CalendarEmployee {
  employeeId: string;
  displayName: string;
  /** The employee linked to the signed-in user. */
  isSelf: boolean;
  connection: CalendarConnection | null;
}

export interface CalendarOverview {
  /** Appointments go to the calendar; busy times come back; nothing else does. */
  syncDirection: 'one-way';
  providers: CalendarProviderInfo[];
  encryptionAvailable: boolean;
  employees: CalendarEmployee[];
}

export interface CalendarSyncStatus {
  connection: CalendarConnection;
  queue: { pending: number; failed: number };
  recentErrors: Array<{ appointmentId: string; error: string | null; at: string | null }>;
}

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string | null;
}

const base = (companyId: string) => `/companies/${companyId}/calendar-connections`;

export const calendarService = {
  overview: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<CalendarOverview>(base(companyId), { signal }),

  /** The provider's consent URL. The browser is sent there; it comes back to /calendar/callback. */
  start: (companyId: string, input: { provider: CalendarProvider; employeeId: string }) =>
    apiClient.post<{ authorizationUrl: string; expiresAt: string }>(
      `${base(companyId)}/oauth/start`,
      input,
    ),

  complete: (companyId: string, input: { state: string; code: string }) =>
    apiClient.post<CalendarSyncStatus>(`${base(companyId)}/oauth/callback`, input),

  calendars: (companyId: string, connectionId: string, signal?: AbortSignal) =>
    apiClient.get<CalendarChoice[]>(`${base(companyId)}/${connectionId}/calendars`, { signal }),

  update: (
    companyId: string,
    connectionId: string,
    input: { calendarId?: string; syncCompleted?: boolean; useForAvailability?: boolean },
  ) => apiClient.patch<CalendarSyncStatus>(`${base(companyId)}/${connectionId}`, input),

  status: (companyId: string, connectionId: string, signal?: AbortSignal) =>
    apiClient.get<CalendarSyncStatus>(`${base(companyId)}/${connectionId}/sync`, { signal }),

  resync: (companyId: string, connectionId: string) =>
    apiClient.post<CalendarSyncStatus & { queued: number }>(
      `${base(companyId)}/${connectionId}/sync`,
      {},
    ),

  disconnect: (companyId: string, connectionId: string) =>
    apiClient.delete<{ disconnected: true; upcomingEventsRemoved: number }>(
      `${base(companyId)}/${connectionId}`,
    ),
};
