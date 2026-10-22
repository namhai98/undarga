import { parsePlainDate, startOfLocalDay } from '../../common/time/zoned-time';
import {
  CalendarProviderError,
  call,
  defaultFetch,
  detailOf,
  emailFromIdToken,
  errorFor,
  tokenRequest,
  type BusyPeriod,
  type CalendarEventInput,
  type CalendarProvider,
  type CalendarSummary,
  type Fetch,
  type OAuthTokens,
} from './calendar-provider';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const MAX_PAGES = 10;

/**
 * Google Calendar API v3.
 *
 * Scopes: `calendar.events` (create/update/delete our events and read event
 * times for busy periods) and `calendar.calendarlist.readonly` (to offer a
 * choice of calendar), plus `openid email` to show which account connected.
 * No full `calendar` scope: this never manages calendars or sharing.
 *
 * Events carry a deterministic id (base32hex, derived from connection +
 * appointment), so a retried create collides (409) instead of duplicating, and
 * `extendedProperties.private.undargaAppointmentId`, so busy-period reads can
 * leave our own events out.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google' as const;
  readonly scopes = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ] as const;

  constructor(
    private readonly client: { clientId: string; clientSecret: string },
    private readonly fetchImpl: Fetch = defaultFetch,
  ) {}

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.client.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      // offline + consent: Google only issues a refresh token on consent.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    const tokens = await tokenRequest(this.fetchImpl, 'Google', TOKEN_URL, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
    });
    return { ...tokens, accountEmail: emailFromIdToken(tokens.idToken) };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const { idToken: _ignored, ...tokens } = await tokenRequest(
      this.fetchImpl,
      'Google',
      TOKEN_URL,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
      },
    );
    return tokens;
  }

  async revoke(tokens: { accessToken: string; refreshToken: string | null }): Promise<void> {
    // Revoking the refresh token revokes the whole grant.
    await call(this.fetchImpl, 'Google', REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }).toString(),
    }).catch(() => undefined);
  }

  async listCalendars(accessToken: string): Promise<CalendarSummary[]> {
    const params = new URLSearchParams({
      minAccessRole: 'writer',
      fields: 'items(id,summary,primary,timeZone)',
    });
    const body = await this.json<{
      items?: Array<{ id: string; summary?: string; primary?: boolean; timeZone?: string }>;
    }>(accessToken, `${API}/users/me/calendarList?${params.toString()}`, { method: 'GET' });
    return (body.items ?? []).map((c) => ({
      id: c.id,
      name: c.summary ?? c.id,
      primary: c.primary === true,
      timeZone: c.timeZone ?? null,
    }));
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEventInput,
  ): Promise<string> {
    const id = googleEventId(event.idempotencyKey);
    try {
      const created = await this.json<{ id: string }>(
        accessToken,
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
        { method: 'POST', body: JSON.stringify({ id, ...this.body(event) }) },
      );
      return created.id;
    } catch (error) {
      // Already created by an earlier attempt whose answer was lost: adopt it.
      if (error instanceof CalendarProviderError && error.kind === 'CONFLICT') {
        await this.updateEvent(accessToken, calendarId, id, event);
        return id;
      }
      throw error;
    }
  }

  async updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
  ): Promise<void> {
    await this.json(
      accessToken,
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      // A deleted event with our id comes back as "cancelled": restore it.
      { method: 'PATCH', body: JSON.stringify({ ...this.body(event), status: 'confirmed' }) },
    );
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    try {
      await this.json(
        accessToken,
        `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof CalendarProviderError && error.kind === 'NOT_FOUND') return;
      throw error;
    }
  }

  async listBusy(
    accessToken: string,
    calendarId: string,
    window: { from: Date; to: Date; calendarTimeZone: string | null },
  ): Promise<BusyPeriod[]> {
    const busy: BusyPeriod[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        timeMin: window.from.toISOString(),
        timeMax: window.to.toISOString(),
        singleEvents: 'true',
        showDeleted: 'false',
        maxResults: '250',
        // Times and flags only: no titles, descriptions or attendee lists.
        fields:
          'timeZone,nextPageToken,items(id,status,transparency,start,end,extendedProperties/private,attendees(self,responseStatus))',
        ...(pageToken ? { pageToken } : {}),
      });
      const body = await this.json<GoogleEventsPage>(
        accessToken,
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { method: 'GET' },
      );
      const zone = body.timeZone ?? window.calendarTimeZone ?? 'UTC';
      for (const item of body.items ?? []) {
        if (item.status === 'cancelled' || item.transparency === 'transparent') continue;
        if (item.extendedProperties?.private?.undargaAppointmentId) continue;
        if (item.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
        const start = instantOf(item.start, zone);
        const end = instantOf(item.end, zone);
        if (start && end && end > start) busy.push({ start, end });
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return busy;
  }

  private body(event: CalendarEventInput) {
    return {
      summary: event.summary,
      description: event.description,
      ...(event.location ? { location: event.location } : {}),
      start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
      end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
      transparency: 'opaque',
      // Only the employee sees the details if they share their calendar.
      visibility: 'private',
      extendedProperties: { private: { undargaAppointmentId: event.appointmentId } },
    };
  }

  private async json<T = unknown>(accessToken: string, url: string, init: RequestInit): Promise<T> {
    const response = await call(this.fetchImpl, 'Google', url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw errorFor('Google', response.status, await detailOf(response));
    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => ({}))) as T;
  }
}

interface GoogleEventsPage {
  timeZone?: string;
  nextPageToken?: string;
  items?: Array<{
    id: string;
    status?: string;
    transparency?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    extendedProperties?: { private?: Record<string, string> };
    attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  }>;
}

/** A timed event's instant, or an all-day event's local midnight in the calendar's zone. */
function instantOf(
  value: { dateTime?: string; date?: string } | undefined,
  zone: string,
): Date | null {
  if (!value) return null;
  if (value.dateTime) {
    const d = new Date(value.dateTime);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (value.date) {
    try {
      return startOfLocalDay(parsePlainDate(value.date), zone);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Google event ids: 5–1024 characters of base32hex (a–v, 0–9). Hex is a
 * subset, so a SHA-256 hex digest prefixed with `ud` qualifies.
 */
export function googleEventId(idempotencyKey: string): string {
  return `ud${idempotencyKey.toLowerCase().replace(/[^0-9a-v]/g, '')}`.slice(0, 64);
}
