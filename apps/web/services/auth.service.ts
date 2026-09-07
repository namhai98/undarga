import { apiClient } from './api-client';
import type { AuthTokens } from './token-store';

/**
 * One company the signed-in user belongs to.
 *
 * Returned by `/auth/me` and by every endpoint that issues a session, so the
 * company picker never needs a separate request.
 */
export interface MembershipSummary {
  companyId: string;
  companySlug: string;
  companyName: string;
  isOwner: boolean;
}

/** What `/auth/login`, `/auth/refresh` and `/auth/switch-company` return. */
export interface AuthenticatedSession extends AuthTokens {
  tokenType: string;
  memberships: MembershipSummary[];
}

export interface CurrentUser {
  realm: 'staff';
  id: string;
  email: string;
  displayName: string;
  memberships: MembershipSummary[];
}

/**
 * The tenant-scoped half of the session: which company, and what may be done
 * in it.
 *
 * Separate from `/auth/me` because that route is tenant-less by design — it is
 * what you call to *decide* which company to enter, so it cannot know your
 * permissions, which only exist relative to a membership.
 */
export interface SessionContext {
  company: {
    id: string;
    slug: string;
    status: string;
    operationalStatus: string;
    defaultTimezoneName: string;
    currencyCode: string;
  };
  membership: {
    companyUserId: string;
    isOwner: boolean;
    roleKeys: string[];
    branchScope: string[] | null;
  } | null;
  permissions: string[];
  viaPlatformAccess: boolean;
}

/**
 * Authentication.
 *
 * No token handling lives here — the API client owns attachment and refresh,
 * and the refresh token is an HttpOnly cookie this code cannot see. These are
 * thin typed wrappers, in the same shape as `health.service.ts`.
 */
export const authService = {
  /**
   * `anonymous: true` because there is no session yet, and because a stale
   * bearer token from a previous user must not be attached to a login.
   */
  login: (email: string, password: string) =>
    apiClient.post<AuthenticatedSession>('/auth/login', { email, password }, { anonymous: true }),

  logout: () => apiClient.post<void>('/auth/logout'),

  me: (signal?: AbortSignal) => apiClient.get<CurrentUser>('/auth/me', { signal }),

  context: (signal?: AbortSignal) => apiClient.get<SessionContext>('/me/context', { signal }),

  /**
   * Change the active company.
   *
   * Issues a brand-new token pair and retires the old session, so a token is
   * only ever valid for one company. The caller must replace the stored tokens
   * AND clear cached data — see `useSwitchCompany`.
   */
  switchCompany: (companyId: string) =>
    apiClient.post<AuthenticatedSession>('/auth/switch-company', { companyId }),

  // ---------------------------------------------------------------------------
  // Account recovery
  //
  // All four are `anonymous`: the caller either has no session (forgot, reset,
  // verify) or is acting on a link rather than a session. Attaching a stale
  // bearer token would achieve nothing and, on reset, would be confusing.
  //
  // The two `request*` calls resolve with the same acknowledgement whether or
  // not the address has an account. That is the server's contract, and the UI
  // must not try to infer more from it — no "we could not find that address".
  // ---------------------------------------------------------------------------

  requestPasswordReset: (email: string) =>
    apiClient.post<Acknowledgement>('/auth/forgot-password', { email }, { anonymous: true }),

  resetPassword: (token: string, newPassword: string) =>
    apiClient.post<void>('/auth/reset-password', { token, newPassword }, { anonymous: true }),

  requestEmailVerification: (email: string) =>
    apiClient.post<Acknowledgement>('/auth/resend-verification', { email }, { anonymous: true }),

  verifyEmail: (token: string) =>
    apiClient.post<{ email: string }>('/auth/verify-email', { token }, { anonymous: true }),

  // ---------------------------------------------------------------------------
  // Authenticated
  // ---------------------------------------------------------------------------

  /** Keeps this session alive and revokes the user's others. */
  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.post<void>('/auth/change-password', { currentPassword, newPassword }),

  /** Ends every session including this one. The caller must then sign out locally. */
  logoutEverywhere: () => apiClient.post<{ revoked: number }>('/auth/logout-all'),
};

/** The deliberately uninformative reply from the two `request*` endpoints. */
export interface Acknowledgement {
  message: string;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  locale: string;
  status: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * The caller's own account.
 *
 * Separate from `authService` because it is about the person rather than the
 * session, and tenant-less: your name is yours across every company you belong
 * to.
 */
export const usersService = {
  me: (signal?: AbortSignal) => apiClient.get<UserProfile>('/users/me', { signal }),

  updateMe: (input: { fullName?: string; phone?: string | null; locale?: string }) =>
    apiClient.patch<UserProfile>('/users/me', input),
};
