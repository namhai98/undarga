import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '@/services/token-store';
import { makeQueryClient } from '@/test/render';
import { SessionProvider } from './session-provider';
import { useSession } from './use-session';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

function Probe() {
  const session = useSession();
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="email">{session.user?.email ?? '-'}</span>
      <span data-testid="companies">{session.memberships.length}</span>
      <span data-testid="permissions">{session.permissions.size}</span>
    </div>
  );
}

function mount({ strict = false } = {}) {
  const client = makeQueryClient();
  const tree = (
    <QueryClientProvider client={client}>
      <SessionProvider>
        <Probe />
      </SessionProvider>
    </QueryClientProvider>
  );

  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/**
 * Let every queued microtask and state update drain.
 *
 * The bootstrap chain is refresh -> token store -> two queries, and each link
 * resolves a promise React did not schedule. Without draining, a test finishes
 * while the last one is still in flight and React reports an update outside
 * `act` — a warning that is noise here, but noise that trains people to ignore
 * the warning when it means something.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SessionProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  const refreshCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'));

  describe('restoring a session on startup', () => {
    it('recovers the session from the refresh cookie', async () => {
      // The reload case. The client holds nothing; the cookie does the work.
      fetchMock.mockImplementation((url: string) => {
        const path = String(url);
        if (path.endsWith('/auth/refresh')) {
          return Promise.resolve(
            jsonResponse(
              200,
              envelope({
                accessToken: 'tok',
                expiresIn: 900,
                activeCompanyId: 'c1',
                memberships: [
                  { companyId: 'c1', companySlug: 'a', companyName: 'A', isOwner: false },
                ],
              }),
            ),
          );
        }
        if (path.endsWith('/auth/me')) {
          return Promise.resolve(
            jsonResponse(
              200,
              envelope({
                realm: 'staff',
                id: 'u1',
                email: 'a@example.com',
                displayName: 'A',
                memberships: [
                  { companyId: 'c1', companySlug: 'a', companyName: 'A', isOwner: false },
                ],
              }),
            ),
          );
        }
        return Promise.resolve(
          jsonResponse(
            200,
            envelope({
              company: { id: 'c1', slug: 'a', status: 'ACTIVE', operationalStatus: 'ACTIVE', defaultTimezoneName: 'UTC', currencyCode: 'MNT' },
              membership: { companyUserId: 'cu', isOwner: false, roleKeys: ['EMPLOYEE'], branchScope: null },
              permissions: ['appointment:read:own', 'service:read'],
              viaPlatformAccess: false,
            }),
          ),
        );
      });

      await act(async () => { mount(); });

      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
      await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('a@example.com'));
      await waitFor(() => expect(screen.getByTestId('permissions')).toHaveTextContent('2'));
      await settle();
    });

    it('sends the refresh cookie and no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));

      mount();

      await waitFor(() => expect(refreshCalls()).toHaveLength(1));
      const init = refreshCalls()[0]![1];
      // The cookie is the credential; without credentials:'include' it is not sent.
      expect(init.credentials).toBe('include');
      expect(init.body).toBeUndefined();
    });

    it('settles to anonymous when there is no session to restore', async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));

      mount();

      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
      // And it must not have asked for the user — there is nobody to ask about.
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/me'))).toHaveLength(0);
    });

    it('starts in loading, never in anonymous', async () => {
      // The property that stops the login screen flashing on every reload for a
      // user who is perfectly signed in.
      let release: (r: Response) => void = () => {};
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      );

      mount();

      expect(screen.getByTestId('status')).toHaveTextContent('loading');
      release(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    });
  });

  describe('StrictMode', () => {
    it('refreshes exactly once despite the double-invoked effect', async () => {
      /**
       * The regression this guards.
       *
       * StrictMode runs effects twice in development. Refresh tokens ROTATE, so
       * two bootstrap refreshes mean the second presents an already-rotated
       * token — which the API correctly treats as theft and answers by killing
       * the entire session family. The symptom is "users get randomly logged
       * out on page load", and the cause is three layers away from it.
       *
       * Single-flighting inside the API client is what makes the double
       * invocation harmless.
       */
      fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));

      mount({ strict: true });

      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
      expect(refreshCalls()).toHaveLength(1);
    });
  });

  describe('losing the session from outside React', () => {
    it('flips to anonymous when the store is cleared', async () => {
      fetchMock.mockImplementation((url: string) => {
        const path = String(url);
        if (path.endsWith('/auth/refresh')) {
          return Promise.resolve(
            jsonResponse(200, envelope({ accessToken: 'tok', expiresIn: 900, memberships: [] })),
          );
        }
        return Promise.resolve(
          jsonResponse(
            200,
            envelope({ realm: 'staff', id: 'u1', email: 'a@example.com', displayName: 'A', memberships: [] }),
          ),
        );
      });

      mount();
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

      // What the API client does when a refresh comes back REFRESH_TOKEN_REUSED
      // — no component is involved, so the tree has to be subscribed to notice.
      // Wrapped in act because the store notifies subscribers synchronously and
      // React would otherwise flag the resulting render as unbatched.
      act(() => tokenStore.clear('signed-out'));

      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    });
  });

  describe('a user with no company', () => {
    it('is authenticated, with no context request made', async () => {
      fetchMock.mockImplementation((url: string) => {
        const path = String(url);
        if (path.endsWith('/auth/refresh')) {
          return Promise.resolve(
            jsonResponse(200, envelope({ accessToken: 'tok', expiresIn: 900, memberships: [] })),
          );
        }
        return Promise.resolve(
          jsonResponse(
            200,
            envelope({ realm: 'staff', id: 'u1', email: 'a@example.com', displayName: 'A', memberships: [] }),
          ),
        );
      });

      await act(async () => { mount(); });

      // Wait for the whole session to settle, not just the membership count —
      // asserting mid-flight leaves a pending state update and an act() warning.
      await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('a@example.com'));
      expect(screen.getByTestId('companies')).toHaveTextContent('0');
      // /me/context is tenant-scoped and would 404 TENANT_UNRESOLVED, which
      // would look like a failure rather than "no company yet".
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/me/context'))).toHaveLength(0);
      await settle();
    });
  });
});
