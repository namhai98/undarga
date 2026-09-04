import { API_HEADERS, type ApiEnvelope } from '@undarga/shared';
import { clientEnv } from '@/lib/env';
import { ApiAbortError, ApiError, ApiNetworkError } from './api-error';
import { tokenStore, UNRECOVERABLE_AUTH_CODES, type AuthTokens } from './token-store';

export interface RequestOptions {
  /** Query string parameters. `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Extra headers. Cannot override Authorization. */
  headers?: Record<string, string>;
  /** Caller-supplied cancellation, composed with the internal timeout. */
  signal?: AbortSignal;
  /** Per-request timeout. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Target a specific company for this call. Omit to use the session's active
   * company. The server validates it against your memberships either way — a
   * company you do not belong to returns 404, not 403.
   */
  companyId?: string;
  /** Skip the Authorization header (login, refresh, health). */
  anonymous?: boolean;
  /** Makes an unsafe request safe to retry. Required for payment writes later. */
  idempotencyKey?: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

/**
 * The single place the browser talks to the API.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CENTRALISES, AND WHY EACH ONE MATTERS
 * ---------------------------------------------------------------------------
 *
 * TOKEN ATTACHMENT     One place decides whether a request is authenticated.
 *                      Scattered `fetch` calls end up with some routes sending
 *                      credentials and some not, discovered in production.
 *
 * REFRESH              A 401 triggers exactly one refresh, even if twenty
 *                      requests fail at once (see `refreshInFlight`). Without
 *                      single-flighting, a page with twenty widgets fires
 *                      twenty refreshes, and refresh-token ROTATION means
 *                      nineteen of them present an already-rotated token —
 *                      which the API treats as theft and kills the whole
 *                      session family. The bug looks like "users randomly
 *                      logged out".
 *
 * RETRIES              Only for idempotent methods, only for network failures
 *                      and 5xx. A POST is never retried: retrying "create
 *                      appointment" after a timeout is how you double-book.
 *
 * ENVELOPE UNWRAPPING  Callers get `T`, not `{ data: T }`.
 *
 * ERRORS               One typed `ApiError` with the shared error code, so UI
 *                      code branches on a compile-checked union.
 *
 * ---------------------------------------------------------------------------
 * NO SECRETS HERE
 * ---------------------------------------------------------------------------
 *
 * The only configuration this file reads is `NEXT_PUBLIC_API_URL`, which is
 * compiled into the browser bundle and is therefore public by definition. API
 * keys, signing secrets and database credentials live server-side and are
 * never referenced from `apps/web`.
 */
class ApiClient {
  private readonly baseUrl: string;
  /** Shared by every caller waiting on the same refresh. */
  private refreshInFlight: Promise<AuthTokens | null> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  // ---------------------------------------------------------------------------

  private async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
    isRetryAfterRefresh = false,
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const idempotent = method === 'GET';

    let lastError: unknown;

    for (let attempt = 0; attempt <= (idempotent ? MAX_RETRIES : 0); attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so a recovering server does not get
        // hit by every client at the same instant.
        const delay = 200 * 2 ** (attempt - 1) + Math.random() * 100;
        await sleep(delay);
      }

      try {
        const response = await this.send(method, url, body, options);

        if (response.status === 204) return undefined as T;

        const payload = await this.parseBody(response);

        if (response.ok) {
          return (payload as ApiEnvelope<T>).data;
        }

        const error = ApiError.fromResponse(response.status, payload);

        // A 401 gets exactly one refresh-and-retry. `isRetryAfterRefresh`
        // prevents an infinite loop when the refreshed token is also rejected.
        if (response.status === 401 && !options.anonymous && !isRetryAfterRefresh) {
          const refreshed = await this.refresh();
          if (refreshed) {
            return this.request<T>(method, path, body, options, true);
          }
        }

        // 5xx on an idempotent request is worth another go; 4xx never is.
        if (response.status >= 500 && idempotent && attempt < MAX_RETRIES) {
          lastError = error;
          continue;
        }

        throw error;
      } catch (caught) {
        if (caught instanceof ApiError || caught instanceof ApiAbortError) throw caught;

        // Network-level failure. Retry an idempotent request; otherwise give up
        // — we cannot know whether the server processed it.
        lastError = caught;
        if (!idempotent || attempt >= MAX_RETRIES) {
          throw new ApiNetworkError(caught);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new ApiNetworkError(lastError);
  }

  private async send(
    method: Method,
    url: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<Response> {
    const deadline = withDeadline(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };

    if (body !== undefined) headers['Content-Type'] = 'application/json';

    if (!options.anonymous) {
      const token = tokenStore.accessToken;
      // Assigned last so a caller cannot override it through `options.headers`.
      if (token) headers[API_HEADERS.AUTHORIZATION] = `Bearer ${token}`;
    }

    if (options.companyId) headers[API_HEADERS.COMPANY_ID] = options.companyId;
    if (options.idempotencyKey) headers[API_HEADERS.IDEMPOTENCY_KEY] = options.idempotencyKey;

    try {
      return await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: deadline.signal,
        // The refresh token will move to an HttpOnly cookie (see token-store.ts);
        // sending credentials now means that change needs no client edit.
        credentials: 'include',
      });
    } catch (error) {
      if (isAbortError(error) || deadline.signal.aborted) {
        throw new ApiAbortError(deadline.timedOut() ? 'timeout' : 'cancelled');
      }
      throw error;
    } finally {
      deadline.cleanup();
    }
  }

  /**
   * Exchange the refresh token for a new pair.
   *
   * Single-flighted: concurrent callers await the same promise. See the class
   * comment for why that is not an optimisation but a correctness requirement
   * under refresh-token rotation.
   */
  private async refresh(): Promise<AuthTokens | null> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<AuthTokens | null> {
    const current = tokenStore.get();
    if (!current?.refreshToken) {
      tokenStore.clear('signed-out');
      return null;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        credentials: 'include',
      });

      const payload = await this.parseBody(response);

      if (!response.ok) {
        const error = ApiError.fromResponse(response.status, payload);
        // Reuse detection or revocation: the session is gone for good.
        if (UNRECOVERABLE_AUTH_CODES.includes(error.code as never) || response.status === 401) {
          tokenStore.clear('signed-out');
        }
        return null;
      }

      const tokens = (payload as ApiEnvelope<AuthTokens>).data;
      tokenStore.set(tokens, 'refreshed');
      return tokens;
    } catch {
      // A network failure during refresh is not proof the session is invalid,
      // so the tokens are kept and the original request simply fails.
      return null;
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private async parseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return null;

    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deadline {
  signal: AbortSignal;
  /** True when the abort came from the timeout rather than the caller. */
  timedOut: () => boolean;
  cleanup: () => void;
}

/**
 * Combine the caller's cancellation with a per-request timeout.
 *
 * Hand-rolled rather than `AbortSignal.any([signal, AbortSignal.timeout(ms)])`
 * because both statics are recent — `AbortSignal.any` landed in Safari 17.4 —
 * and neither exists in jsdom, so the tidy version throws a TypeError before
 * `fetch` is even called. That failure surfaces as a *network* error, which is
 * exactly the wrong diagnosis to hand a developer.
 *
 * The timer is always cleared, so a fast response does not leave a pending
 * timeout holding the event loop open.
 */
function withDeadline(external: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export const apiClient = new ApiClient(clientEnv.apiUrl);
export type { ApiClient };
