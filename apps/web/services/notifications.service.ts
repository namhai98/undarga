import { apiClient } from './api-client';

export type NotificationChannel = 'EMAIL' | 'SMS' | 'PUSH';
export type NotificationStatus =
  | 'PENDING'
  | 'SCHEDULED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'RETRYING'
  | 'CANCELLED'
  /** The provider never answered. Not retried automatically; a person may retry it. */
  | 'UNKNOWN';

export interface NotificationRow {
  id: string;
  type: string;
  channel: NotificationChannel | 'IN_APP';
  status: NotificationStatus;
  recipientType: string;
  /** Masked by the API. A staff member checking delivery does not need the address. */
  recipientAddress: string;
  subject: string | null;
  preview: string | null;
  appointmentId: string | null;
  scheduledFor: string;
  /** When the provider accepted it. Accepted is not delivered. */
  sentAt: string | null;
  /** Only set when the provider confirmed delivery. */
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  provider: string | null;
  /** The provider's own word for the latest state: `accepted`, `delivered`, `bounce`… */
  providerStatus: string | null;
  providerEventAt: string | null;
  /** FAILED and UNKNOWN can be sent again by hand. */
  retryable: boolean;
  createdAt: string;
}

export interface NotificationDetail extends NotificationRow {
  body: string | null;
  templateId: string | null;
  customTemplate: boolean;
  providerMessageId: string | null;
}

export interface NotificationQuery {
  status?: string;
  channel?: string;
  type?: string;
  appointmentId?: string;
  limit?: number;
  offset?: number;
}

export interface NotificationTypeInfo {
  type: string;
  label: string;
  category: 'TRANSACTIONAL' | 'REMINDER' | 'BILLING' | 'MARKETING';
  audience: 'CUSTOMER' | 'COMPANY_OWNER';
  variables: string[];
  defaultChannels: NotificationChannel[];
  defaults: Record<NotificationChannel, { subject?: string; body: string }>;
}

export interface NotificationSettings {
  channels: { email: boolean; sms: boolean; push: boolean };
  reminders: { enabled: boolean; offsetsMinutes: number[] };
  /** Effective: the company's choice where it made one, the default elsewhere. */
  eventChannels: Record<string, NotificationChannel[]>;
  catalog: NotificationTypeInfo[];
  channelsAvailable: NotificationChannel[];
  variables: string[];
}

export interface NotificationSettingsUpdate {
  channels?: Partial<NotificationSettings['channels']>;
  reminders?: Partial<NotificationSettings['reminders']>;
  eventChannels?: Record<string, NotificationChannel[]>;
}

export interface NotificationTemplate {
  id: string;
  type: string;
  typeLabel: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  subject?: string | null;
  body?: string;
  isActive?: boolean;
}

export interface TemplatePreview {
  subject: string | null;
  body: string;
  length: number;
  sample: Record<string, string>;
}

export interface CustomerNotificationPreferences {
  customerId: string;
  enabled: { email: boolean; sms: boolean; push: boolean };
  /** Whether a deliverable address is on file for each channel. */
  reachable: { email: boolean; sms: boolean; push: boolean };
}

export type ProviderStatus = 'UNVERIFIED' | 'CONNECTED' | 'FAILED';

/** One channel's sender. Secrets never come back: only `secretHint` (`••••abcd`). */
export interface ProviderChannelView {
  channel: NotificationChannel;
  /** Who sends right now. `none`: nothing is sent on this channel. */
  active: 'company' | 'platform' | 'none';
  platformProvider: string | null;
  supportedProviders: string[];
  company: {
    id: string;
    provider: string;
    isEnabled: boolean;
    status: ProviderStatus;
    lastCheckedAt: string | null;
    lastError: string | null;
    secretHint: string;
    settings: Record<string, string>;
    /** Paste into the provider's webhook settings (SendGrid). Null without a public base URL. */
    receiptUrl: string | null;
    updatedAt: string;
  } | null;
}

export interface NotificationProviders {
  /** False when the server has no encryption key: own accounts cannot be saved. */
  companyAccountsAvailable: boolean;
  channels: ProviderChannelView[];
}

export type SaveProviderInput =
  | {
      provider: 'sendgrid';
      isEnabled?: boolean;
      /** Omit to keep the stored key. */
      secrets?: { apiKey: string };
      settings: { fromAddress: string; fromName?: string; webhookPublicKey?: string };
    }
  | {
      provider: 'twilio';
      isEnabled?: boolean;
      secrets?: { authToken: string };
      settings: { accountSid: string; fromNumber?: string; messagingServiceSid?: string };
    };

const base = (companyId: string) => `/companies/${companyId}`;

export const notificationsService = {
  list: (companyId: string, query: NotificationQuery = {}, signal?: AbortSignal) =>
    apiClient.get<{ items: NotificationRow[]; total: number; limit: number; offset: number }>(
      `${base(companyId)}/notifications`,
      { query: { ...query }, signal },
    ),

  get: (companyId: string, notificationId: string, signal?: AbortSignal) =>
    apiClient.get<NotificationDetail>(`${base(companyId)}/notifications/${notificationId}`, {
      signal,
    }),

  /** Send a FAILED or UNKNOWN message again (`settings:write`). */
  retry: (companyId: string, notificationId: string) =>
    apiClient.post<NotificationRow>(`${base(companyId)}/notifications/${notificationId}/retry`, {}),

  providers: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<NotificationProviders>(`${base(companyId)}/notification-providers`, { signal }),

  /** Needs `settings:write` and `billing:write` (the owner, by default). */
  saveProvider: (companyId: string, channel: 'EMAIL' | 'SMS', input: SaveProviderInput) =>
    apiClient.put<ProviderChannelView>(
      `${base(companyId)}/notification-providers/${channel}`,
      input,
    ),

  removeProvider: (companyId: string, channel: 'EMAIL' | 'SMS') =>
    apiClient.delete<ProviderChannelView>(`${base(companyId)}/notification-providers/${channel}`),

  verifyProvider: (companyId: string, channel: 'EMAIL' | 'SMS') =>
    apiClient.post<ProviderChannelView>(
      `${base(companyId)}/notification-providers/${channel}/verify`,
      {},
    ),

  stats: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{
      byStatus: Record<string, number>;
      byChannel: Record<string, number>;
      /** Events waiting to become notifications. Growing means the worker is not running. */
      pendingEvents: number;
    }>(`${base(companyId)}/notifications/stats`, { signal }),

  /** Process this company's queue now. The background worker also does this on a timer. */
  run: (companyId: string) =>
    apiClient.post<{
      reminders: number;
      dispatched: number;
      sent: number;
      failed: number;
      skipped: number;
    }>(`${base(companyId)}/notifications/run`, {}),

  settings: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<NotificationSettings>(`${base(companyId)}/notification-settings`, { signal }),

  updateSettings: (companyId: string, input: NotificationSettingsUpdate) =>
    apiClient.patch<NotificationSettings>(`${base(companyId)}/notification-settings`, input),

  templates: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{
      items: NotificationTemplate[];
      catalog: NotificationTypeInfo[];
      variables: string[];
    }>(`${base(companyId)}/notification-templates`, { signal }),

  createTemplate: (
    companyId: string,
    input: { type: string; channel: NotificationChannel } & TemplateInput & { body: string },
  ) => apiClient.post<NotificationTemplate>(`${base(companyId)}/notification-templates`, input),

  updateTemplate: (companyId: string, templateId: string, input: TemplateInput) =>
    apiClient.patch<NotificationTemplate>(
      `${base(companyId)}/notification-templates/${templateId}`,
      input,
    ),

  previewTemplate: (
    companyId: string,
    input: { type: string; channel: NotificationChannel; subject?: string | null; body: string },
  ) => apiClient.post<TemplatePreview>(`${base(companyId)}/notification-templates/preview`, input),

  customerPreferences: (companyId: string, customerId: string, signal?: AbortSignal) =>
    apiClient.get<CustomerNotificationPreferences>(
      `${base(companyId)}/customers/${customerId}/notification-preferences`,
      { signal },
    ),

  updateCustomerPreferences: (
    companyId: string,
    customerId: string,
    input: Partial<CustomerNotificationPreferences['enabled']>,
  ) =>
    apiClient.patch<CustomerNotificationPreferences>(
      `${base(companyId)}/customers/${customerId}/notification-preferences`,
      input,
    ),
};
