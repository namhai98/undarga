import {
  call,
  CalendarProviderError,
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

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 10;
/** `transactionId` prefix: how our events are recognised when reading busy periods. */
const OURS = 'undarga-';

/**
 * Microsoft Graph calendar (Outlook / Microsoft 365).
 *
 * Scopes: `Calendars.ReadWrite` (our events, and event times for busy
 * periods), `offline_access` (a refresh token), `openid email` (which account).
 *
 * Creates carry `transactionId`, which Graph uses to drop a duplicate create
 * sent by a retry. All times are exchanged in UTC (`Prefer: outlook.timezone`)
 * so no Windows-zone mapping is needed; the event still shows in the
 * employee's own calendar zone.
 *
 * Graph has no endpoint to revoke one delegated grant; disconnecting deletes
 * the tokens here, and the user can remove the app at
 * https://myapps.microsoft.com.
 */
export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly name = 'microsoft' as const;
  readonly scopes = [
    'openid',
    'email',
    'offline_access',
    'https://graph.microsoft.com/Calendars.ReadWrite',
  ] as const;

  constructor(
    private readonly client: { clientId: string; clientSecret: string; tenant: string },
    private readonly fetchImpl: Fetch = defaultFetch,
  ) {}

  private get authority() {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.client.tenant)}/oauth2/v2.0`;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.client.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: this.scopes.join(' '),
      prompt: 'select_account',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.authority}/authorize?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    const tokens = await tokenRequest(this.fetchImpl, 'Microsoft', `${this.authority}/token`, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      scope: this.scopes.join(' '),
    });
    return { ...tokens, accountEmail: emailFromIdToken(tokens.idToken) };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    // Microsoft rotates refresh tokens: the new one replaces the old.
    const { idToken: _ignored, ...tokens } = await tokenRequest(
      this.fetchImpl,
      'Microsoft',
      `${this.authority}/token`,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        scope: this.scopes.join(' '),
      },
    );
    return tokens;
  }

  async revoke(): Promise<void> {
    // See the class comment: nothing to call.
  }

  async listCalendars(accessToken: string): Promise<CalendarSummary[]> {
    const body = await this.json<{
      value?: Array<{ id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean }>;
    }>(accessToken, `${GRAPH}/me/calendars?$select=id,name,isDefaultCalendar,canEdit`, {
      method: 'GET',
    });
    return (body.value ?? [])
      .filter((c) => c.canEdit !== false)
      .map((c) => ({
        id: c.id,
        name: c.name ?? c.id,
        primary: c.isDefaultCalendar === true,
        timeZone: null,
      }));
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEventInput,
  ): Promise<string> {
    const created = await this.json<{ id: string }>(accessToken, `${eventsOf(calendarId)}`, {
      method: 'POST',
      body: JSON.stringify({
        ...this.body(event),
        transactionId: `${OURS}${event.idempotencyKey}`.slice(0, 64),
      }),
    });
    return created.id;
  }

  async updateEvent(
    accessToken: string,
    _calendarId: string,
    eventId: string,
    event: CalendarEventInput,
  ): Promise<void> {
    await this.json(accessToken, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(this.body(event)),
    });
  }

  async deleteEvent(accessToken: string, _calendarId: string, eventId: string): Promise<void> {
    try {
      await this.json(accessToken, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      if (error instanceof CalendarProviderError && error.kind === 'NOT_FOUND') return;
      throw error;
    }
  }

  async listBusy(
    accessToken: string,
    calendarId: string,
    window: { from: Date; to: Date },
  ): Promise<BusyPeriod[]> {
    const base =
      calendarId === 'primary'
        ? `${GRAPH}/me/calendar`
        : `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}`;
    const params = new URLSearchParams({
      startDateTime: window.from.toISOString(),
      endDateTime: window.to.toISOString(),
      // Times and flags only: no subjects, bodies or attendees.
      $select: 'id,start,end,showAs,isCancelled,transactionId',
      $top: '250',
    });
    let url: string | undefined = `${base}/calendarView?${params.toString()}`;
    const busy: BusyPeriod[] = [];
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const body: GraphEventsPage = await this.json<GraphEventsPage>(accessToken, url, {
        method: 'GET',
      });
      for (const item of body.value ?? []) {
        if (item.isCancelled) continue;
        if (item.showAs === 'free' || item.showAs === 'workingElsewhere') continue;
        if (item.transactionId?.startsWith(OURS)) continue;
        const start = utc(item.start?.dateTime);
        const end = utc(item.end?.dateTime);
        if (start && end && end > start) busy.push({ start, end });
      }
      url = body['@odata.nextLink'];
    }
    return busy;
  }

  private body(event: CalendarEventInput) {
    return {
      subject: event.summary,
      body: { contentType: 'text', content: event.description },
      start: { dateTime: utcWall(event.start), timeZone: 'UTC' },
      end: { dateTime: utcWall(event.end), timeZone: 'UTC' },
      ...(event.location ? { location: { displayName: event.location } } : {}),
      showAs: 'busy',
      sensitivity: 'private',
      isReminderOn: false,
    };
  }

  private async json<T = unknown>(accessToken: string, url: string, init: RequestInit): Promise<T> {
    const response = await call(this.fetchImpl, 'Microsoft', url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!response.ok) throw errorFor('Microsoft', response.status, await detailOf(response));
    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => ({}))) as T;
  }
}

interface GraphEventsPage {
  value?: Array<{
    id: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    showAs?: string;
    isCancelled?: boolean;
    transactionId?: string | null;
  }>;
  '@odata.nextLink'?: string;
}

function eventsOf(calendarId: string): string {
  return calendarId === 'primary'
    ? `${GRAPH}/me/calendar/events`
    : `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`;
}

/** Graph's UTC wall time: `2026-10-22T09:00:00.0000000`, no offset. */
function utcWall(instant: Date): string {
  return instant.toISOString().replace('Z', '');
}

function utc(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
