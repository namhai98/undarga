/**
 * One external calendar service (Google, Microsoft). Every adapter speaks
 * OAuth 2.0 authorization-code with PKCE, writes events this SaaS owns, and
 * reads busy periods. It never touches the database and never logs tokens.
 */
export type CalendarProviderName = 'google' | 'microsoft';
export const CALENDAR_PROVIDER_NAMES: readonly CalendarProviderName[] = ['google', 'microsoft'];

export interface OAuthTokens {
  accessToken: string;
  /** Null when the provider kept the existing one (Google does on refresh). */
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export interface CalendarSummary {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string | null;
}

/** What goes into an external event. No customer details — see the sync service. */
export interface CalendarEventInput {
  /** Deterministic per (connection, appointment): makes "create" safe to retry. */
  idempotencyKey: string;
  appointmentId: string;
  summary: string;
  description: string;
  location: string | null;
  start: Date;
  end: Date;
  /** IANA zone the event is shown in (the branch's). */
  timeZone: string;
}

export interface BusyPeriod {
  start: Date;
  end: Date;
}

export type ProviderErrorKind =
  /** Token rejected or revoked: the connection needs reauthorising. */
  | 'AUTH'
  /** Throttled: retry later. */
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  /** Create collided with an existing id: the event already exists. */
  | 'CONFLICT'
  /** Network, timeout, 5xx: retry later. */
  | 'TRANSIENT'
  /** Anything else: retrying will not help. */
  | 'PERMANENT';

export class CalendarProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CalendarProviderError';
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'TRANSIENT';
  }
}

export interface CalendarProvider {
  readonly name: CalendarProviderName;
  /** Exactly what is requested at consent. Nothing broader. */
  readonly scopes: readonly string[];

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokens & { accountEmail: string | null }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  /** Best effort: revoke the grant at the provider, where it supports that. */
  revoke(tokens: { accessToken: string; refreshToken: string | null }): Promise<void>;

  listCalendars(accessToken: string): Promise<CalendarSummary[]>;
  /** Idempotent on `event.idempotencyKey`. Returns the external id. */
  createEvent(accessToken: string, calendarId: string, event: CalendarEventInput): Promise<string>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
  ): Promise<void>;
  /** An event already gone is success. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
  /**
   * Busy periods in [from, to), excluding events this SaaS created, free
   * ("show as available") and declined events. Times only.
   */
  listBusy(
    accessToken: string,
    calendarId: string,
    window: { from: Date; to: Date; calendarTimeZone: string | null },
  ): Promise<BusyPeriod[]>;
}

export type Fetch = typeof fetch;
export const PROVIDER_TIMEOUT_MS = 15_000;
/** Looked up per call, so a test can replace the global. */
export const defaultFetch: Fetch = (input, init) => fetch(input, init);

/** Map an HTTP failure onto what it means for a caller. Never includes tokens. */
export function errorFor(provider: string, status: number, detail: string): CalendarProviderError {
  const text = `${provider} answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  if (status === 401) return new CalendarProviderError('AUTH', text, status);
  if (status === 429) return new CalendarProviderError('RATE_LIMIT', text, status);
  // Google reports quota exhaustion as 403 with a rate-limit reason.
  if (status === 403 && /rate ?limit|quota/i.test(detail)) {
    return new CalendarProviderError('RATE_LIMIT', text, status);
  }
  if (status === 404 || status === 410) return new CalendarProviderError('NOT_FOUND', text, status);
  if (status === 409) return new CalendarProviderError('CONFLICT', text, status);
  if (status >= 500) return new CalendarProviderError('TRANSIENT', text, status);
  return new CalendarProviderError('PERMANENT', text, status);
}

/** fetch with a timeout; a thrown transport error becomes TRANSIENT. */
export async function call(
  fetchImpl: Fetch,
  provider: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch {
    throw new CalendarProviderError('TRANSIENT', `${provider} could not be reached.`);
  }
}

/** The provider's own error text, if any, for the message. Not the request. */
export async function detailOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string; status?: string; code?: string };
      error_description?: string;
    };
    if (typeof body.error === 'string')
      return body.error_description ? `${body.error} (${body.error_description})` : body.error;
    return body.error?.message ?? body.error?.status ?? body.error?.code ?? '';
  } catch {
    return '';
  }
}

/** The OAuth token endpoint's answer, shared by both providers. */
export async function tokenRequest(
  fetchImpl: Fetch,
  provider: string,
  url: string,
  form: Record<string, string>,
): Promise<OAuthTokens & { idToken: string | null }> {
  const response = await call(fetchImpl, provider, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    // invalid_grant: the refresh token was revoked or expired — reauthorise.
    if (body.error === 'invalid_grant' || response.status === 401) {
      throw new CalendarProviderError(
        'AUTH',
        `${provider} refused the grant (${body.error ?? response.status}).`,
        response.status,
      );
    }
    if (response.status === 429)
      throw new CalendarProviderError('RATE_LIMIT', `${provider} is throttling.`, 429);
    if (response.status >= 500)
      throw new CalendarProviderError(
        'TRANSIENT',
        `${provider} token endpoint failed.`,
        response.status,
      );
    throw new CalendarProviderError(
      'PERMANENT',
      `${provider} token request failed (${body.error ?? response.status}).`,
      response.status,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt:
      typeof body.expires_in === 'number' ? new Date(Date.now() + body.expires_in * 1000) : null,
    scope: body.scope ?? null,
    idToken: body.id_token ?? null,
  };
}

/**
 * The email claim of an ID token received directly from the provider's token
 * endpoint over TLS (OIDC Core §3.1.3.7 allows skipping signature validation
 * there). Used for display only, never for authorisation.
 */
export function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as {
      email?: string;
      preferred_username?: string;
    };
    const email = payload.email ?? payload.preferred_username ?? null;
    return email && email.includes('@') ? email.slice(0, 320) : null;
  } catch {
    return null;
  }
}
