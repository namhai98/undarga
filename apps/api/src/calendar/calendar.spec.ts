import { belongsOnCalendar, contentHash, eventFor } from './calendar-sync.service';
import { CalendarProviderError, emailFromIdToken, errorFor } from './providers/calendar-provider';
import { GoogleCalendarProvider, googleEventId } from './providers/google-calendar.provider';
import { MicrosoftCalendarProvider } from './providers/microsoft-calendar.provider';

/** The real adapters against a mocked fetch. Nothing reaches a network. */

type Respond = (url: string, init: RequestInit) => Response;
function fakeFetch(respond: Respond) {
  return jest.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(respond(input instanceof Request ? input.url : input.toString(), init ?? {})),
  );
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idToken = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

const event = {
  idempotencyKey: 'abc123def4567890abc123def4567890abc12345',
  appointmentId: '018f0000-0000-7000-8000-000000000001',
  summary: 'Haircut · Downtown',
  description: 'Booking A-0001 — Confirmed.',
  location: 'Downtown, 1 Main St',
  start: new Date('2026-11-02T01:00:00.000Z'),
  end: new Date('2026-11-02T02:00:00.000Z'),
  timeZone: 'Asia/Ulaanbaatar',
};

describe('GoogleCalendarProvider', () => {
  const client = { clientId: 'cid', clientSecret: 'secret' };

  it('asks only for event and calendar-list access, offline, with PKCE', () => {
    const url = new URL(
      new GoogleCalendarProvider(client).authorizationUrl({
        state: 'st',
        codeChallenge: 'ch',
        redirectUri: 'https://app.test/calendar/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/calendar/callback');
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('exchanges the code with the verifier and reads the account email', async () => {
    const fetch = fakeFetch(() =>
      json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        id_token: idToken({ email: 'ari@example.com' }),
      }),
    );
    const tokens = await new GoogleCalendarProvider(client, fetch).exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'https://app.test/cb',
    });
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', accountEmail: 'ari@example.com' });
    const form = new URLSearchParams(fetch.mock.calls[0]![1]!.body as string);
    expect(form.get('code_verifier')).toBe('v');
    expect(form.get('grant_type')).toBe('authorization_code');
  });

  it('turns a revoked refresh token into an AUTH error', async () => {
    const fetch = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(new GoogleCalendarProvider(client, fetch).refresh('rt')).rejects.toMatchObject({ kind: 'AUTH' });
  });

  it('creates with a deterministic id and adopts an existing one on 409', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetch = fakeFetch((url, init) => {
      calls.push({ url, method: init.method!, body: JSON.parse((init.body as string) ?? '{}') });
      return init.method === 'POST' ? json({ error: { message: 'duplicate' } }, 409) : json({ id: 'x' });
    });
    const id = await new GoogleCalendarProvider(client, fetch).createEvent('at', 'primary', event);
    expect(id).toBe(googleEventId(event.idempotencyKey));
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(calls[0]!.body).toMatchObject({
      id,
      summary: 'Haircut · Downtown',
      start: { dateTime: '2026-11-02T01:00:00.000Z', timeZone: 'Asia/Ulaanbaatar' },
      visibility: 'private',
      extendedProperties: { private: { undargaAppointmentId: event.appointmentId } },
    });
    expect(calls[1]!.url).toContain(`/events/${id}`);
    expect(/^[0-9a-v]{5,1024}$/.test(id)).toBe(true);
  });

  it('treats an already deleted event as deleted', async () => {
    const fetch = fakeFetch(() => json({}, 410));
    await expect(new GoogleCalendarProvider(client, fetch).deleteEvent('at', 'primary', 'e')).resolves.toBeUndefined();
  });

  it('reads busy periods as times only, skipping free, declined, cancelled and our own events', async () => {
    const fetch = fakeFetch((url) => {
      expect(new URL(url).searchParams.get('fields')).not.toMatch(/summary|description/);
      return json({
        timeZone: 'Asia/Ulaanbaatar',
        items: [
          { id: '1', start: { dateTime: '2026-11-02T03:00:00Z' }, end: { dateTime: '2026-11-02T04:00:00Z' } },
          { id: '2', transparency: 'transparent', start: { dateTime: '2026-11-02T05:00:00Z' }, end: { dateTime: '2026-11-02T06:00:00Z' } },
          { id: '3', status: 'cancelled', start: { dateTime: '2026-11-02T05:00:00Z' }, end: { dateTime: '2026-11-02T06:00:00Z' } },
          {
            id: '4',
            extendedProperties: { private: { undargaAppointmentId: 'x' } },
            start: { dateTime: '2026-11-02T07:00:00Z' },
            end: { dateTime: '2026-11-02T08:00:00Z' },
          },
          {
            id: '5',
            attendees: [{ self: true, responseStatus: 'declined' }],
            start: { dateTime: '2026-11-02T09:00:00Z' },
            end: { dateTime: '2026-11-02T10:00:00Z' },
          },
          // All day in the calendar's zone (UTC+8): local midnight is 16:00Z the day before.
          { id: '6', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } },
        ],
      });
    });
    const busy = await new GoogleCalendarProvider(client, fetch).listBusy('at', 'primary', {
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-10T00:00:00Z'),
      calendarTimeZone: null,
    });
    expect(busy.map((b) => [b.start.toISOString(), b.end.toISOString()])).toEqual([
      ['2026-11-02T03:00:00.000Z', '2026-11-02T04:00:00.000Z'],
      ['2026-11-02T16:00:00.000Z', '2026-11-03T16:00:00.000Z'],
    ]);
  });
});

describe('MicrosoftCalendarProvider', () => {
  const client = { clientId: 'cid', clientSecret: 'secret', tenant: 'common' };

  it('asks for Calendars.ReadWrite and offline access, with PKCE', () => {
    const url = new URL(
      new MicrosoftCalendarProvider(client).authorizationUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://app.test/cb' }),
    );
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('creates in UTC with a transactionId, and reads busy periods without ours or free ones', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = fakeFetch((url, init) => {
      seen.push({ url, init });
      if (init.method === 'POST') return json({ id: 'graph-1' }, 201);
      return json({
        value: [
          { id: 'a', showAs: 'busy', start: { dateTime: '2026-11-02T03:00:00.0000000' }, end: { dateTime: '2026-11-02T04:00:00.0000000' } },
          { id: 'b', showAs: 'free', start: { dateTime: '2026-11-02T05:00:00.0000000' }, end: { dateTime: '2026-11-02T06:00:00.0000000' } },
          { id: 'c', showAs: 'busy', transactionId: 'undarga-x', start: { dateTime: '2026-11-02T07:00:00.0000000' }, end: { dateTime: '2026-11-02T08:00:00.0000000' } },
          { id: 'd', showAs: 'oof', isCancelled: true, start: { dateTime: '2026-11-02T09:00:00.0000000' }, end: { dateTime: '2026-11-02T10:00:00.0000000' } },
        ],
      });
    });
    const provider = new MicrosoftCalendarProvider(client, fetch);
    expect(await provider.createEvent('at', 'primary', event)).toBe('graph-1');
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(seen[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/calendar/events');
    expect(body).toMatchObject({
      transactionId: `undarga-${event.idempotencyKey}`,
      start: { dateTime: '2026-11-02T01:00:00.000', timeZone: 'UTC' },
      sensitivity: 'private',
    });

    const busy = await provider.listBusy('at', 'primary', {
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-10T00:00:00Z'),
    });
    expect(busy.map((b) => b.start.toISOString())).toEqual(['2026-11-02T03:00:00.000Z']);
    expect((seen[1]!.init.headers as Record<string, string>).Prefer).toBe('outlook.timezone="UTC"');
  });
});

describe('provider error mapping', () => {
  it('classifies HTTP answers', () => {
    expect(errorFor('G', 401, '').kind).toBe('AUTH');
    expect(errorFor('G', 429, '').kind).toBe('RATE_LIMIT');
    expect(errorFor('G', 403, 'Rate Limit Exceeded').kind).toBe('RATE_LIMIT');
    expect(errorFor('G', 403, 'Forbidden').kind).toBe('PERMANENT');
    expect(errorFor('G', 404, '').kind).toBe('NOT_FOUND');
    expect(errorFor('G', 503, '').kind).toBe('TRANSIENT');
    expect(new CalendarProviderError('TRANSIENT', 'x').retryable).toBe(true);
    expect(new CalendarProviderError('PERMANENT', 'x').retryable).toBe(false);
  });

  it('reads an email from an ID token, and nothing from garbage', () => {
    expect(emailFromIdToken(idToken({ preferred_username: 'a@b.test' }))).toBe('a@b.test');
    expect(emailFromIdToken('garbage')).toBeNull();
    expect(emailFromIdToken(null)).toBeNull();
  });
});

describe('calendar event content', () => {
  const appointment = {
    id: '018f0000-0000-7000-8000-0000000000aa',
    appointmentNumber: 'A-0042',
    status: 'CONFIRMED' as const,
    branch: { name: 'Downtown', timezoneName: 'Asia/Ulaanbaatar', addressLine1: '1 Main St', addressLine2: null, city: 'UB' },
    items: [
      {
        employeeId: 'emp-1',
        startsAt: new Date('2026-11-02T01:00:00Z'),
        endsAt: new Date('2026-11-02T02:00:00Z'),
        snapshot: { serviceName: 'Haircut', customerName: 'Sara Secret', customerPhone: '+97699112233' },
        service: { name: 'Haircut (current)' },
      },
      {
        employeeId: 'emp-2',
        startsAt: new Date('2026-11-02T02:00:00Z'),
        endsAt: new Date('2026-11-02T03:00:00Z'),
        snapshot: {},
        service: { name: 'Colour' },
      },
    ],
  };

  it('holds service, time, branch and booking number — never customer details', () => {
    const e = eventFor(appointment, 'emp-1', 'conn-1', 'primary')!;
    expect(e).toMatchObject({
      summary: 'Haircut · Downtown',
      location: 'Downtown, 1 Main St, UB',
      timeZone: 'Asia/Ulaanbaatar',
      start: new Date('2026-11-02T01:00:00Z'),
      end: new Date('2026-11-02T02:00:00Z'),
    });
    expect(e.description).toContain('A-0042');
    expect(JSON.stringify(e)).not.toMatch(/Sara|Secret|9911/);
  });

  it('covers only that employee’s part, and nothing for an employee not on it', () => {
    expect(eventFor(appointment, 'emp-2', 'conn-2', 'primary')!.summary).toBe('Colour · Downtown');
    expect(eventFor(appointment, 'emp-3', 'conn-3', 'primary')).toBeNull();
  });

  it('is stable per connection and calendar, and its hash changes with the content', () => {
    const a = eventFor(appointment, 'emp-1', 'conn-1', 'primary')!;
    const b = eventFor(appointment, 'emp-1', 'conn-1', 'primary')!;
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(eventFor(appointment, 'emp-1', 'conn-1', 'work')!.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash({ ...a, start: new Date('2026-11-02T01:30:00Z') })).not.toBe(contentHash(a));
  });

  it('keeps live appointments, and completed ones only when asked', () => {
    for (const status of ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS']) {
      expect(belongsOnCalendar(status, false)).toBe(true);
    }
    expect(belongsOnCalendar('COMPLETED', true)).toBe(true);
    expect(belongsOnCalendar('COMPLETED', false)).toBe(false);
    for (const status of ['CANCELLED', 'NO_SHOW', 'EXPIRED', 'HOLD']) {
      expect(belongsOnCalendar(status, true)).toBe(false);
    }
  });
});
