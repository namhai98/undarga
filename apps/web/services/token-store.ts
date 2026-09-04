import type { ApiErrorCode } from '@undarga/shared';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  activeCompanyId?: string;
}

export type AuthChangeReason = 'signed-in' | 'refreshed' | 'signed-out' | 'company-switched';

type Listener = (tokens: AuthTokens | null, reason: AuthChangeReason) => void;

/**
 * Where the session lives in the browser.
 *
 * ---------------------------------------------------------------------------
 * IN MEMORY, DELIBERATELY — AND WHY THAT MEANS A RELOAD SIGNS YOU OUT
 * ---------------------------------------------------------------------------
 *
 * Tokens are held in a module-level variable. Nothing is written to
 * `localStorage` or `sessionStorage`, because both are readable by any script
 * on the page: one XSS — in our code or in any dependency — and an attacker
 * walks away with a 30-day refresh token. Access tokens expire in 15 minutes;
 * refresh tokens are the valuable ones.
 *
 * The cost is real and visible: refreshing the page loses the session. That is
 * a deliberate placeholder, not an oversight.
 *
 * THE FIX, WHICH IS AN API CHANGE AND IS NOT DONE YET:
 * the API should set the refresh token as an `HttpOnly; Secure; SameSite=Lax`
 * cookie instead of returning it in the JSON body, and `/auth/refresh` should
 * read it from there. JavaScript then cannot read it at all, and the session
 * survives a reload. That is listed as a blocking decision in the report —
 * shipping persistence via localStorage first would be the wrong order.
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
