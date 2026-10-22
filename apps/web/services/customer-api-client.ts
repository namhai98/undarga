import { clientEnv } from '@/lib/env';
import { ApiError } from './api-error';

/**
 * ===========================================================================
 * THE CUSTOMER PORTAL'S OWN SESSION
 * ===========================================================================
 *
 * A third client, beside the staff one and the operator console's, for the
 * same reason the console has its own: one shared token store would make the
 * sessions sign each other out, and a staff token must never ride on a
 * customer request (or the reverse). The API refuses that anyway — different
 * audiences — but here it cannot even be attempted.
 *
 *   - The access token lives in memory only.
 *   - The refresh token is an HttpOnly cookie scoped by the API to
 *     `/api/v1/customer/auth/<slug>`. JavaScript never sees it, and it is sent
 *     only to that business's auth routes — so a reload restores the session
 *     (unlike the console), and two businesses' portals do not collide.
 *   - A 401 refreshes once and retries; if that fails the session is over.
 */

export type CustomerSessionStatus = 'unknown' | 'signed-in' | 'signed-out';

export interface CustomerSessionState {
  slug: string | null;
  status: CustomerSessionStatus;
}

type Listener = () => void;

class CustomerSessionStore {
  private token: string | null = null;
  private expiresAt = 0;
  private state: CustomerSessionState = { slug: null, status: 'unknown' };
  private listeners = new Set<Listener>();

  /** Stable between changes, as `useSyncExternalStore` requires. */
  snapshot(): CustomerSessionState {
    return this.state;
  }

  get slug(): string | null {
    return this.state.slug;
  }

  get accessToken(): string | null {
    // A token past its expiry is treated as absent; the next call refreshes.
    if (this.token && Date.now() >= this.expiresAt) this.token = null;
    return this.token;
  }

  /** Switch to a business's portal. A different business starts unknown. */
  use(slug: string): void {
    if (this.state.slug === slug) return;
    this.token = null;
    this.expiresAt = 0;
    this.setState({ slug, status: 'unknown' });
  }

  signIn(slug: string, accessToken: string, expiresIn: number): void {
    this.token = accessToken;
    this.expiresAt = Date.now() + expiresIn * 1000 - 5_000;
    this.setState({ slug, status: 'signed-in' });
  }

  signOut(): void {
    this.token = null;
    this.expiresAt = 0;
    this.setState({ slug: this.state.slug, status: 'signed-out' });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(next: CustomerSessionState) {
    if (next.slug === this.state.slug && next.status === this.state.status) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const customerSession = new CustomerSessionStore();

const base = clientEnv.apiUrl.replace(/\/+$/, '');
const authPath = (slug: string) => `/customer/auth/${encodeURIComponent(slug)}`;

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Send no access token (sign-in routes). */
  anonymous?: boolean;
}

async function send<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: unknown,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.anonymous) {
    const token = customerSession.accessToken ?? (await refreshSession());
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
    // The refresh cookie rides only on the auth routes it is scoped to.
    credentials: 'include',
  });

  if (response.status === 401 && !options.anonymous && !retried) {
    if (await refreshSession(true)) return send<T>(method, path, body, options, true);
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; details?: Record<string, unknown>; requestId?: string } }
    | null;

  if (!response.ok) {
    if (response.status === 401 && !options.anonymous) customerSession.signOut();
    throw new ApiError({
      code: payload?.error?.code ?? 'UNKNOWN',
      message: payload?.error?.message ?? 'The request failed.',
      status: response.status,
      details: payload?.error?.details,
      requestId: payload?.error?.requestId,
    });
  }
  return payload?.data as T;
}

let inFlight: Promise<string | null> | null = null;

/**
 * Restore or renew the session from the refresh cookie. Single-flighted: the
 * API rotates refresh tokens, and two concurrent refreshes would present the
 * same token twice — which it treats as theft and revokes.
 */
export function refreshSession(force = false): Promise<string | null> {
  const slug = customerSession.slug;
  if (!slug) return Promise.resolve(null);
  if (!force && customerSession.snapshot().status === 'signed-out') return Promise.resolve(null);

  inFlight ??= (async () => {
    try {
      const response = await fetch(`${base}${authPath(slug)}/refresh`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) {
        customerSession.signOut();
        return null;
      }
      const payload = (await response.json()) as { data: { accessToken: string; expiresIn: number } };
      customerSession.signIn(slug, payload.data.accessToken, payload.data.expiresIn);
      return payload.data.accessToken;
    } catch {
      customerSession.signOut();
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export const customerApiClient = {
  get: <T>(path: string, options?: RequestOptions) => send<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => send<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => send<T>('PATCH', path, body, options),

  requestCode: (slug: string, email: string) =>
    send<{ sent: true; expiresInSeconds: number }>('POST', `${authPath(slug)}/request-code`, { email }, { anonymous: true }),

  async verify(slug: string, email: string, code: string) {
    const session = await send<{ accessToken: string; expiresIn: number }>(
      'POST',
      `${authPath(slug)}/verify`,
      { email, code },
      { anonymous: true },
    );
    customerSession.signIn(slug, session.accessToken, session.expiresIn);
  },

  async logout(slug: string) {
    try {
      await send<void>('POST', `${authPath(slug)}/logout`, undefined);
    } finally {
      // Local sign-out even if the network blinks.
      customerSession.signOut();
    }
  },
};
