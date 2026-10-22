import { clientEnv } from '@/lib/env';
import { ApiError } from './api-error';

/**
 * ===========================================================================
 * THE OPERATOR CONSOLE'S OWN SESSION
 * ===========================================================================
 *
 * A separate client and a separate token store, deliberately — not a flag on
 * the staff one.
 *
 * ---------------------------------------------------------------------------
 * 1. ONE SHARED STORE WOULD MAKE THE TWO SESSIONS FIGHT
 * ---------------------------------------------------------------------------
 *
 * `token-store.ts` is a module-level singleton. If the console wrote to it,
 * signing into the platform would sign you out of the staff app in the same
 * tab, and signing back into a company would silently end the console session.
 * An operator who is also a member of a company — common, in a small
 * business — would find the two logging each other out all day.
 *
 * Two stores means two sessions that coexist, and it means the staff client is
 * structurally incapable of putting a platform token on a company request.
 *
 * ---------------------------------------------------------------------------
 * 2. THERE IS NO PLATFORM REFRESH ENDPOINT
 * ---------------------------------------------------------------------------
 *
 * The API exposes `POST /platform/auth/login` and `POST /platform/auth/logout`
 * and nothing else. No refresh route exists, and the refresh COOKIE is scoped
 * to `/api/v1/auth` — the staff path — so a platform session cannot be revived
 * from one even in principle.
 *
 * The consequence is stated plainly rather than papered over: **reloading the
 * console signs an operator out.** That is a real limitation (see
 * docs/PLATFORM-ADMIN.md), and the honest version of it is a login screen on
 * reload, not a client that pretends to refresh and fails confusingly.
 *
 * Fifteen minutes of cross-tenant read access, in memory only, is also the
 * smallest blast radius available without building session persistence this
 * phase does not need.
 *
 * ---------------------------------------------------------------------------
 * 3. NO COMPANY HEADER, EVER
 * ---------------------------------------------------------------------------
 *
 * `X-Company-Id` is how the staff client selects a tenant. This client cannot
 * send it. Platform routes are `@PlatformOnly`, so `TenantGuard` short-circuits
 * and a company header would be ignored — but not sending one at all means
 * there is no code path here that could be mistaken for tenant selection.
 */

export interface PlatformSession {
  accessToken: string;
  expiresIn: number;
}

type Listener = (session: PlatformSession | null) => void;

class PlatformTokenStore {
  private session: PlatformSession | null = null;
  private listeners = new Set<Listener>();
  /** Wall-clock ms at which the access token expires. */
  private expiresAt = 0;

  get accessToken(): string | null {
    // Expiry is checked on read rather than on a timer: a timer in a background
    // tab is throttled, and a token believed live for a minute after it died
    // produces a confusing 401 instead of a clean sign-out.
    if (this.session && Date.now() >= this.expiresAt) this.clear();
    return this.session?.accessToken ?? null;
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  set(session: PlatformSession): void {
    this.session = session;
    this.expiresAt = Date.now() + session.expiresIn * 1000;
    this.emit();
  }

  clear(): void {
    if (this.session === null) return;
    this.session = null;
    this.expiresAt = 0;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.session);
  }
}

export const platformTokenStore = new PlatformTokenStore();

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  anonymous?: boolean;
}

const base = clientEnv.apiUrl.replace(/\/+$/, '');

async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (!options.anonymous) {
    const token = platformTokenStore.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; details?: Record<string, unknown>; requestId?: string } }
    | null;

  if (!response.ok) {
    // A 401 here means the fifteen minutes are up, or the token was never a
    // platform one. Either way the console session is over; clearing it is what
    // makes the guard send the operator back to the login screen rather than
    // leaving a dead page that 401s on every tab they click.
    if (response.status === 401) platformTokenStore.clear();

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

export const platformApiClient = {
  get: <T>(path: string, options?: RequestOptions) => send<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    send<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    send<T>('PATCH', path, body, options),
};
