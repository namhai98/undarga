import type { Paged } from './customers.service';
import { platformApiClient, platformTokenStore } from './platform-api-client';

/**
 * The operator console's API surface.
 *
 * Everything here goes through `platformApiClient`, which holds its own session
 * and cannot send a company header. Nothing in this file touches the staff
 * client, and nothing in the staff app imports from here.
 */

export type CompanyStatus = 'PENDING_SETUP' | 'ACTIVE' | 'SUSPENDED' | 'CANCELED';

/** `SubscriptionStatus` spells it CANCELLED; `CompanyStatus` spells it CANCELED. */
export type SubscriptionStatus =
  | 'TRIAL'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'GRACE'
  | 'SUSPENDED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface PlatformCompanySummary {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  status: CompanyStatus;
  contactEmail: string | null;
  currencyCode: string;
  createdAt: string;
  suspendedAt: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  planKey: string | null;
  planName: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Size, not contents. An operator sizes a tenant; they do not read it. */
  userCount: number;
  branchCount: number;
  employeeCount: number;
}

export interface PlatformCompanyDetail extends PlatformCompanySummary {
  contactPhone: string | null;
  defaultTimezoneName: string;
  locale: string;
  updatedAt: string;
  deletedAt: string | null;
  counts: {
    branches: number;
    employees: number;
    services: number;
    customers: number;
    appointments: number;
    activeUsers: number;
  };
  subscription: {
    id: string;
    status: SubscriptionStatus;
    planKey: string;
    planName: string;
    quantity: number;
    trialEndsAt: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: string | null;
  } | null;
  /** Action and actor only. The payloads are a tenant's business. */
  recentActivity: Array<{
    id: string;
    action: string;
    resourceType: string;
    actorType: string;
    actorLabel: string;
    occurredAt: string;
  }>;
}

export interface PlatformCompanyQuery {
  search?: string;
  status?: CompanyStatus;
  subscriptionStatus?: SubscriptionStatus;
  planKey?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: 'createdAt' | 'displayName' | 'status';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface PlatformCompanyUser {
  membershipId: string;
  userAccountId: string;
  email: string;
  fullName: string | null;
  accountStatus: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  membershipStatus: string;
  isOwner: boolean;
  roles: string[];
  joinedAt: string | null;
  invitedAt: string | null;
}

export interface PlatformSubscriptionView {
  companyId: string;
  subscription:
    | (PlatformCompanyDetail['subscription'] & {
        cancelReason?: string | null;
        expiredAt?: string | null;
        provider?: string | null;
        startedAt?: string;
      })
    | null;
  periodKey: string;
  usage: Array<{
    metric: string;
    used: number;
    limit: number | null;
    /** Null when the plan has no numeric cap — show "unlimited", not 0%. */
    percentUsed: number | null;
    overLimit: boolean;
    updatedAt: string;
  }>;
  entitlements: Array<{
    featureKey: string;
    limitInt: number | null;
    limitBool: boolean | null;
    overridden: boolean;
  }>;
  history: Array<{ metric: string; periodKey: string; value: number }>;
}

export interface PlatformDashboard {
  windowDays: number;
  companies: {
    total: number;
    active: number;
    suspended: number;
    /** `CANCELED` in the schema. */
    disabled: number;
    pendingSetup: number;
    newInWindow: number;
    byStatus: Record<string, number>;
  };
  subscriptions: {
    total: number;
    trial: number;
    active: number;
    pastDue: number;
    grace: number;
    suspended: number;
    cancelled: number;
    expired: number;
    trialsEndingWithin7Days: number;
    byStatus: Record<string, number>;
    topPlans: Array<{ planKey: string | null; planName: string | null; companies: number }>;
  };
  users: { total: number; activeMemberships: number };
  appointments: { total: number; inWindow: number };
}

export interface PlatformAuditEntry {
  id: string;
  companyId: string | null;
  companySlug: string | null;
  companyName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  /** Operator-authored, and only on `platform.*` actions. */
  reason: string | null;
  occurredAt: string;
  requestId: string | null;
}

export interface PlatformAuditQuery {
  companyId?: string;
  action?: string;
  actorType?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const platformService = {
  /**
   * Sign in to the operator realm.
   *
   * The response carries a refresh token the console deliberately drops: there
   * is no platform refresh endpoint to spend it at, so holding it would only
   * widen what an XSS could take.
   */
  async login(email: string, password: string, mfaCode?: string) {
    const session = await platformApiClient.post<{
      accessToken: string;
      expiresIn: number;
      user?: { id: string; email: string; fullName: string };
      permissions?: string[];
    }>(
      '/platform/auth/login',
      { email, password, ...(mfaCode ? { mfaCode } : {}) },
      { anonymous: true },
    );

    platformTokenStore.set({
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
    });

    return session;
  },

  /** Whether you have a second factor, and whether the server can store one. */
  mfaStatus: (signal?: AbortSignal) =>
    platformApiClient.get<{ enrolled: boolean; available: boolean }>('/platform/auth/mfa', {
      signal,
    }),

  /** Returns the secret ONCE, for an authenticator app. */
  mfaSetup: () =>
    platformApiClient.post<{ secret: string; otpauthUri: string }>('/platform/auth/mfa/setup'),

  mfaConfirm: (code: string) =>
    platformApiClient.post<{ enrolled: true }>('/platform/auth/mfa/confirm', { code }),

  async logout() {
    try {
      await platformApiClient.post<void>('/platform/auth/logout');
    } finally {
      // Local sign-out happens even if the server call fails. A console that
      // refuses to let go of a token because the network blinked is worse than
      // one that drops it and lets the server session expire on its own.
      platformTokenStore.clear();
    }
  },

  dashboard: (windowDays = 30, signal?: AbortSignal) =>
    platformApiClient.get<PlatformDashboard>('/platform/dashboard', {
      query: { windowDays },
      signal,
    }),

  listCompanies: (query: PlatformCompanyQuery = {}, signal?: AbortSignal) =>
    platformApiClient.get<Paged<PlatformCompanySummary>>('/platform/companies', {
      query: { ...query },
      signal,
    }),

  getCompany: (companyId: string, signal?: AbortSignal) =>
    platformApiClient.get<PlatformCompanyDetail>(`/platform/companies/${companyId}`, { signal }),

  /** A reason is required by the API and goes on the audit trail. */
  changeStatus: (companyId: string, status: CompanyStatus, reason: string) =>
    platformApiClient.patch<PlatformCompanyDetail>(`/platform/companies/${companyId}/status`, {
      status,
      reason,
    }),

  listCompanyUsers: (
    companyId: string,
    query: { status?: string; search?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    platformApiClient.get<Paged<PlatformCompanyUser>>(`/platform/companies/${companyId}/users`, {
      query: { ...query },
      signal,
    }),

  getSubscription: (companyId: string, signal?: AbortSignal) =>
    platformApiClient.get<PlatformSubscriptionView>(
      `/platform/companies/${companyId}/subscription`,
      { signal },
    ),

  listAuditLogs: (query: PlatformAuditQuery = {}, signal?: AbortSignal) =>
    platformApiClient.get<Paged<PlatformAuditEntry>>('/platform/audit-logs', {
      query: { ...query },
      signal,
    }),
};
