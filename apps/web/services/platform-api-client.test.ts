import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { platformApiClient, platformTokenStore } from './platform-api-client';
import { tokenStore } from './token-store';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

/**
 * The console's session must be genuinely separate from the staff one.
 *
 * This is the file that would catch a later refactor that "simplified" the two
 * clients into one — at which point an operator who is also a company member
 * would find the two signing each other out all day, and a platform token could
 * reach a company route.
 */
describe('platformTokenStore', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    platformTokenStore.clear();
    tokenStore.clear('signed-out');
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(envelope({ ok: true }))));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    platformTokenStore.clear();
    tokenStore.clear('signed-out');
  });

  it('does not touch the staff session', () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });

    expect(platformTokenStore.isAuthenticated).toBe(true);
    // The whole reason there are two stores.
    expect(tokenStore.isAuthenticated).toBe(false);
  });

  it('is not touched by the staff session', () => {
    tokenStore.set({ accessToken: 'staff-token', expiresIn: 900 }, 'signed-in');

    expect(tokenStore.isAuthenticated).toBe(true);
    expect(platformTokenStore.isAuthenticated).toBe(false);
  });

  it('signing out of one leaves the other alone', () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });
    tokenStore.set({ accessToken: 'staff-token', expiresIn: 900 }, 'signed-in');

    tokenStore.clear('signed-out');

    expect(tokenStore.isAuthenticated).toBe(false);
    // An operator who is also a company member does not lose the console
    // because they signed out of their salon.
    expect(platformTokenStore.isAuthenticated).toBe(true);
  });

  it('treats an expired token as no token', () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: -1 });

    // Checked on read rather than on a timer: a timer in a background tab is
    // throttled, and a token believed live after it died produces a confusing
    // 401 instead of a clean sign-out.
    expect(platformTokenStore.accessToken).toBeNull();
  });

  it('notifies subscribers on sign-in and sign-out', () => {
    const listener = vi.fn();
    const unsubscribe = platformTokenStore.subscribe(listener);

    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });
    platformTokenStore.clear();

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('platformApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    platformTokenStore.clear();
    tokenStore.clear('signed-out');
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(envelope({ ok: true }))));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    platformTokenStore.clear();
    tokenStore.clear('signed-out');
  });

  /** The headers of the Nth fetch. Narrowed here so each test reads cleanly. */
  const headersOf = (index = 0): Record<string, string> => {
    const call = fetchMock.mock.calls[index];
    if (!call) throw new Error('fetch was not called');
    return (call[1] as RequestInit).headers as Record<string, string>;
  };

  const urlOf = (index = 0): string => {
    const call = fetchMock.mock.calls[index];
    if (!call) throw new Error('fetch was not called');
    return String(call[0]);
  };

  it('sends the platform token, not the staff one', async () => {
    tokenStore.set({ accessToken: 'staff-token', expiresIn: 900 }, 'signed-in');
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });

    await platformApiClient.get('/platform/dashboard');

    expect(headersOf().Authorization).toBe('Bearer platform-token');
  });

  it('sends no token at all when only the staff session exists', async () => {
    // The structural guarantee: this client cannot put a staff token on a
    // platform route even by accident, because it cannot see one.
    tokenStore.set({ accessToken: 'staff-token', expiresIn: 900 }, 'signed-in');

    await platformApiClient.get('/platform/dashboard');

    expect(headersOf().Authorization).toBeUndefined();
  });

  it('never sends a company header', async () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });

    await platformApiClient.get('/platform/companies/abc');

    const headers = headersOf();
    // There is no code path here that could be mistaken for tenant selection.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-company-id');
  });

  it('omits the token on an anonymous request', async () => {
    platformTokenStore.set({ accessToken: 'stale', expiresIn: 900 });

    await platformApiClient.post('/platform/auth/login', { email: 'a@b.c' }, { anonymous: true });

    expect(headersOf().Authorization).toBeUndefined();
  });

  it('clears the session on a 401 so the guard can send the operator back', async () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: { code: 'UNAUTHENTICATED', message: 'Token expired', requestId: 'r' } },
            401,
          ),
        ),
      ),
    );

    await expect(platformApiClient.get('/platform/dashboard')).rejects.toBeInstanceOf(ApiError);
    // Otherwise the console sits on a dead page that 401s on every tab.
    expect(platformTokenStore.isAuthenticated).toBe(false);
  });

  it('surfaces the API error code and message', async () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'VALIDATION_FAILED',
                message: 'A company cannot move from ACTIVE to PENDING_SETUP.',
                requestId: 'r',
              },
            },
            400,
          ),
        ),
      ),
    );

    await expect(
      platformApiClient.patch('/platform/companies/abc/status', { status: 'PENDING_SETUP' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'A company cannot move from ACTIVE to PENDING_SETUP.',
      status: 400,
    });

    // A 400 is not a session problem, so the operator stays signed in.
    expect(platformTokenStore.isAuthenticated).toBe(true);
  });

  it('puts query parameters on the URL and drops empty ones', async () => {
    platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });

    await platformApiClient.get('/platform/companies', {
      query: { search: 'acme', status: undefined, limit: 25, planKey: '' },
    });

    const url = urlOf();
    expect(url).toContain('search=acme');
    expect(url).toContain('limit=25');
    expect(url).not.toContain('status=');
    expect(url).not.toContain('planKey=');
  });
});
