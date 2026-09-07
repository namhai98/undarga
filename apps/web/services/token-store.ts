import type { ApiErrorCode } from '@undarga/shared';

export interface AuthTokens {
  accessToken: string;
  expiresIn: number;
  activeCompanyId?: string;
}

export type AuthChangeReason = 'signed-in' | 'refreshed' | 'signed-out' | 'company-switched';

type Listener = (tokens: AuthTokens | null, reason: AuthChangeReason) => void;

/**
 * Where the session lives in the browser.
 *
 * ---------------------------------------------------------------------------
 * THE ACCESS TOKEN IS IN MEMORY; THE REFRESH TOKEN IS NOT HERE AT ALL
 * ---------------------------------------------------------------------------
 *
 * The access token is held in a module-level variable, never in `localStorage`
 * or `sessionStorage` — both are readable by any script on the page, so one XSS
 * anywhere in the dependency tree would hand it over.
 *
 * The refresh token, which is the valuable one, is not reachable from
 * JavaScript at all. The API sets it as an `HttpOnly; SameSite=Lax` cookie
 * scoped to `/api/v1/auth` and never returns it in a response body
 * (`SessionCookieService` on the API side has the full reasoning). So this
 * class has no `refreshToken` field to leak, and `AuthTokens` has no property
 * for one.
 *
 * That is what makes a page reload survivable: on startup the client holds
 * nothing, calls `/auth/refresh`, and the browser supplies the cookie. What an
 * XSS can still steal is fifteen minutes, one company and one session — which
 * is the trade this design makes deliberately.
 */
class TokenStore {
  private tokens: AuthTokens | null = null;
  private listeners = new Set<Listener>();
  /** Wall-clock ms at which the access token expires. */
  private expiresAt = 0;

  get(): AuthTokens | null {
    return this.tokens;
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  get isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  get activeCompanyId(): string | undefined {
    return this.tokens?.activeCompanyId;
  }

  /**
   * True shortly BEFORE the token actually expires.
   *
   * The 30-second skew means a request that takes a moment to reach the server
   * does not arrive with a token that expired in flight — which would surface
   * as a spurious 401 and an avoidable refresh round trip.
   */
  get isAccessTokenExpiring(): boolean {
    if (!this.tokens) return false;
    return Date.now() >= this.expiresAt - 30_000;
  }

  set(tokens: AuthTokens, reason: AuthChangeReason = 'signed-in'): void {
    this.tokens = tokens;
    this.expiresAt = Date.now() + tokens.expiresIn * 1000;
    this.emit(reason);
  }

  clear(reason: AuthChangeReason = 'signed-out'): void {
    this.tokens = null;
    this.expiresAt = 0;
    this.emit(reason);
  }

  /** Subscribe to session changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(reason: AuthChangeReason): void {
    for (const listener of this.listeners) listener(this.tokens, reason);
  }
}

/**
 * One instance per browser tab. Module-level rather than React context because
 * the API client is not a component and must read the token from plain
 * functions — including inside a TanStack Query `queryFn`.
 */
export const tokenStore = new TokenStore();

/** Error codes that mean the stored session is dead and must be discarded. */
export const UNRECOVERABLE_AUTH_CODES: readonly ApiErrorCode[] = [
  'SESSION_REVOKED',
  'REFRESH_TOKEN_REUSED',
  'TOKEN_AUDIENCE_MISMATCH',
];
