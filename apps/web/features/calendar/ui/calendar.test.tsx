import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { sendBrowserTo } from '../model/calendar-display';
import { CalendarCallback } from './calendar-callback';
import { CalendarIntegrationPage } from './calendar-integration-page';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../model/calendar-display', async (original) => ({
  ...(await original<typeof import('../model/calendar-display')>()),
  sendBrowserTo: vi.fn(),
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  employeeId: 'e-1',
  provider: 'google',
  status: 'ACTIVE',
  accountEmail: 'ari@example.com',
  calendarId: 'primary',
  calendarName: 'Ari',
  calendarTimeZone: 'Asia/Ulaanbaatar',
  syncCompleted: true,
  useForAvailability: true,
  lastSyncAt: '2026-10-22T02:00:00.000Z',
  busySyncedAt: '2026-10-22T02:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  failedEvents: 0,
  createdAt: '2026-10-20T00:00:00.000Z',
  ...overrides,
});

const overview = (employees: unknown[], overrides: Record<string, unknown> = {}) => ({
  syncDirection: 'one-way',
  encryptionAvailable: true,
  providers: [
    { provider: 'google', label: 'Google Calendar', configured: true, scopes: [] },
    { provider: 'microsoft', label: 'Microsoft Outlook', configured: false, scopes: [] },
  ],
  employees,
  ...overrides,
});

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });
const MANAGER = ['schedule:read', 'schedule:write:any'];

type Handler = (url: URL, init?: RequestInit) => Response | undefined;
function api(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    return Promise.resolve(handler(url, init) ?? apiError(404, 'RESOURCE_NOT_FOUND', 'Not found'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;
const call = (mock: ReturnType<typeof api>, method: string, suffix: string) =>
  mock.mock.calls.find(
    ([input, init]) => (init?.method ?? 'GET') === method && String(input).endsWith(suffix),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(sendBrowserTo).mockReset();
  replace.mockReset();
});

// =============================================================================
describe('Calendar integration page', () => {
  it('shows providers, who is connected, and never a token', async () => {
    api((url) =>
      url.pathname.endsWith('/calendar-connections')
        ? json(
            envelope(
              overview([
                { employeeId: 'e-1', displayName: 'Ari', isSelf: false, connection: connection() },
                { employeeId: 'e-2', displayName: 'Bea', isSelf: true, connection: null },
              ]),
            ),
          )
        : undefined,
    );
    renderWithProviders(<CalendarIntegrationPage />, { session: session(MANAGER) });

    expect(await screen.findByText('Google Calendar: available')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Outlook: not set up on this server')).toBeInTheDocument();
    expect(screen.getByText(/one-way/)).toBeInTheDocument();

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/ari@example.com/)).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    // Only configured providers are offered.
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Microsoft Outlook' })).toBeNull();
  });

  it('starts OAuth and sends the browser to the provider', async () => {
    const fetchMock = api((url, init) => {
      if (url.pathname.endsWith('/oauth/start') && init?.method === 'POST') {
        return json(
          envelope({
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            expiresAt: '',
          }),
        );
      }
      if (url.pathname.endsWith('/calendar-connections')) {
        return json(
          envelope(
            overview([{ employeeId: 'e-2', displayName: 'Bea', isSelf: true, connection: null }]),
          ),
        );
      }
      return undefined;
    });
    renderWithProviders(<CalendarIntegrationPage />, { session: session(MANAGER) });

    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() =>
      expect(sendBrowserTo).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      ),
    );
    expect(bodyOf(call(fetchMock, 'POST', '/oauth/start')![1])).toEqual({
      provider: 'google',
      employeeId: 'e-2',
    });
  });

  it('asks for reconnection when the grant is gone, and hides syncing', async () => {
    api((url) =>
      url.pathname.endsWith('/calendar-connections')
        ? json(
            envelope(
              overview([
                {
                  employeeId: 'e-1',
                  displayName: 'Ari',
                  isSelf: false,
                  connection: connection({
                    status: 'NEEDS_REAUTH',
                    lastError: 'The calendar access was revoked or expired.',
                  }),
                },
              ]),
            ),
          )
        : undefined,
    );
    renderWithProviders(<CalendarIntegrationPage />, { session: session(MANAGER) });

    expect(await screen.findByText('Reconnect this calendar')).toBeInTheDocument();
    expect(screen.getByText(/revoked or expired/)).toBeInTheDocument();
    expect(screen.getByText('Needs reconnecting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('changes options, syncs now and disconnects after confirmation', async () => {
    const fetchMock = api((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/c-1') && method === 'PATCH')
        return json(envelope({ connection: connection() }));
      if (url.pathname.endsWith('/c-1/sync') && method === 'POST')
        return json(envelope({ connection: connection(), queued: 2 }));
      if (url.pathname.endsWith('/c-1') && method === 'DELETE')
        return json(envelope({ disconnected: true, upcomingEventsRemoved: 2 }));
      if (url.pathname.endsWith('/calendar-connections')) {
        return json(
          envelope(
            overview([
              { employeeId: 'e-1', displayName: 'Ari', isSelf: false, connection: connection() },
            ]),
          ),
        );
      }
      return undefined;
    });
    renderWithProviders(<CalendarIntegrationPage />, { session: session(MANAGER) });

    await userEvent.click(
      await screen.findByLabelText('Use busy times in this calendar to block bookings'),
    );
    await waitFor(() => expect(call(fetchMock, 'PATCH', '/c-1')).toBeDefined());
    expect(bodyOf(call(fetchMock, 'PATCH', '/c-1')![1])).toEqual({ useForAvailability: false });

    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(call(fetchMock, 'POST', '/c-1/sync')).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(call(fetchMock, 'DELETE', '/c-1')).toBeUndefined();
    expect(screen.getByText(/stored access is deleted/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() => expect(call(fetchMock, 'DELETE', '/c-1')).toBeDefined());
  });

  it('says so when the server cannot store calendar access, or nothing can be managed', async () => {
    api((url) =>
      url.pathname.endsWith('/calendar-connections')
        ? json(envelope(overview([], { encryptionAvailable: false })))
        : undefined,
    );
    renderWithProviders(<CalendarIntegrationPage />, { session: session(['schedule:read']) });
    expect(
      await screen.findByText('Calendar connections are not available yet'),
    ).toBeInTheDocument();
    expect(screen.getByText('No calendars you can manage')).toBeInTheDocument();
  });

  it('is not available without schedule:read', () => {
    api(() => undefined);
    renderWithProviders(<CalendarIntegrationPage />, { session: session([]) });
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });
});

// =============================================================================
describe('Calendar OAuth callback', () => {
  it('posts the code and state once, then leaves the page', async () => {
    const fetchMock = api((url, init) =>
      url.pathname.endsWith('/oauth/callback') && init?.method === 'POST'
        ? json(
            envelope({
              connection: connection(),
              queue: { pending: 1, failed: 0 },
              recentErrors: [],
            }),
          )
        : undefined,
    );
    renderWithProviders(<CalendarCallback code="c0de" state="st4te-st4te-st4te-st4te" error="" />, {
      session: session(MANAGER),
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/calendar?connected=1'));
    const posts = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/oauth/callback'),
    );
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]![1])).toEqual({ code: 'c0de', state: 'st4te-st4te-st4te-st4te' });
  });

  it('explains a declined consent without calling the API', () => {
    const fetchMock = api(() => undefined);
    renderWithProviders(<CalendarCallback code="" state="s" error="access_denied" />, {
      session: session(MANAGER),
    });
    expect(
      screen.getByText('Access was not granted, so the calendar was not connected.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server’s reason for a rejected state', async () => {
    api(() =>
      apiError(
        400,
        'CALENDAR_OAUTH_INVALID',
        'This calendar authorisation link is invalid or has expired. Start again.',
      ),
    );
    renderWithProviders(<CalendarCallback code="c" state="st4te-st4te-st4te-st4te" error="" />, {
      session: session(MANAGER),
    });
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to calendar settings' })).toHaveAttribute(
      'href',
      '/calendar',
    );
  });
});
