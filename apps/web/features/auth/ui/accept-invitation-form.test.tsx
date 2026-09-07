import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anonymousSession, renderWithProviders, sessionWith } from '@/test/render';
import { tokenStore } from '@/services/token-store';
import { AcceptInvitationForm } from './accept-invitation-form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/invitations/accept',
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

const preview = (overrides: Record<string, unknown> = {}) =>
  envelope({
    companyName: 'Bright Spa',
    companySlug: 'bright-spa',
    email: 'new@example.com',
    roles: [{ key: 'RECEPTIONIST', name: 'Receptionist' }],
    expiresAt: '2026-12-01T00:00:00.000Z',
    accountExists: false,
    ...overrides,
  });

describe('AcceptInvitationForm', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replace.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  describe('a link with no token', () => {
    it('says so instead of calling the API', () => {
      renderWithProviders(<AcceptInvitationForm token="" />, { session: anonymousSession });

      expect(screen.getByText('This link is incomplete')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a new account', () => {
    it('asks for a name and password and joins', async () => {
      const user = userEvent.setup();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, preview()))
        .mockResolvedValueOnce(
          jsonResponse(
            200,
            envelope({
              companyId: 'c1',
              companySlug: 'bright-spa',
              companyName: 'Bright Spa',
              companyUserId: 'cu1',
              email: 'new@example.com',
              roles: [{ key: 'RECEPTIONIST', name: 'Receptionist' }],
              accountCreated: true,
            }),
          ),
        );

      renderWithProviders(<AcceptInvitationForm token="tok-abc" />, {
        session: anonymousSession,
      });

      expect(await screen.findByLabelText('Your name')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Your name'), 'New Person');
      await user.type(screen.getByLabelText('Choose a password'), 'a-perfectly-fine-password');
      await user.click(screen.getByRole('button', { name: /Join Bright Spa/ }));

      // No session comes back, so the next step is signing in — with the
      // address prefilled, but NOT the token: it is spent, and putting a
      // consumed credential in another URL only gives it another place to be
      // logged.
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith('/login?email=new%40example.com'),
      );
      const acceptUrl = String(fetchMock.mock.calls[1]![0]);
      expect(acceptUrl).toContain('/invitations/accept');
      expect(acceptUrl).not.toContain('tok-abc');
    });

    it('sends the token in the body, never in the URL', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, preview()));

      renderWithProviders(<AcceptInvitationForm token="tok-secret" />, {
        session: anonymousSession,
      });
      await screen.findByLabelText('Your name');

      const [url, init] = fetchMock.mock.calls[0]!;
      // A URL is written to access logs, proxy logs and the Referer header.
      expect(String(url)).not.toContain('tok-secret');
      expect(JSON.parse(init.body)).toEqual({ token: 'tok-secret' });
    });

    it('rejects a short password before calling the API', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(jsonResponse(200, preview()));

      renderWithProviders(<AcceptInvitationForm token="tok" />, { session: anonymousSession });
      await screen.findByLabelText('Your name');

      await user.type(screen.getByLabelText('Your name'), 'New Person');
      await user.type(screen.getByLabelText('Choose a password'), 'short');
      await user.click(screen.getByRole('button', { name: /Join/ }));

      expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1); // preview only
    });
  });

  describe('an address that already has an account', () => {
    it('asks the visitor to sign in rather than offering a password', async () => {
      /**
       * The security property, surfaced as UX: if accepting could set a
       * password on an existing account, a leaked link would be a password
       * reset for somebody else. The API refuses, and the UI must not present
       * an affordance that would be refused.
       */
      fetchMock.mockResolvedValue(jsonResponse(200, preview({ accountExists: true })));

      renderWithProviders(<AcceptInvitationForm token="tok" />, { session: anonymousSession });

      expect(await screen.findByText('You already have an account')).toBeInTheDocument();
      expect(screen.queryByLabelText('Choose a password')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Sign in to accept' })).toHaveAttribute(
        'href',
        '/login?email=new%40example.com',
      );
    });

    it('lets the invited person accept when they are signed in as themselves', async () => {
      const user = userEvent.setup();
      tokenStore.set({ accessToken: 'tok', expiresIn: 900 });
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, preview({ accountExists: true })))
        .mockResolvedValueOnce(
          jsonResponse(
            200,
            envelope({
              companyId: 'c1',
              companySlug: 'bright-spa',
              companyName: 'Bright Spa',
              companyUserId: 'cu1',
              email: 'new@example.com',
              roles: [],
              accountCreated: false,
            }),
          ),
        );

      renderWithProviders(<AcceptInvitationForm token="tok" />, {
        session: sessionWith({
          user: { id: 'u1', email: 'new@example.com', displayName: 'New' },
        }),
      });

      await user.click(await screen.findByRole('button', { name: /Join Bright Spa/ }));

      // Already authenticated, so they go on to pick a company — the new
      // membership means the cached one is stale.
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/select-company'));
    });

    it('refuses a visitor signed in as somebody else', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, preview({ accountExists: true })));

      renderWithProviders(<AcceptInvitationForm token="tok" />, {
        session: sessionWith({
          user: { id: 'u2', email: 'someone.else@example.com', displayName: 'Other' },
        }),
      });

      expect(await screen.findByText('You are signed in as someone else')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Join/ })).not.toBeInTheDocument();
    });
  });

  describe('dead links', () => {
    it('tells an expired invitation apart, because that one is actionable', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(410, { error: { code: 'INVITATION_EXPIRED', message: 'Expired.' } }),
      );

      renderWithProviders(<AcceptInvitationForm token="tok" />, { session: anonymousSession });

      expect(await screen.findByText('This invitation has expired')).toBeInTheDocument();
      expect(screen.getByText(/Ask whoever invited you to send a new link/)).toBeInTheDocument();
    });

    it('gives one answer for revoked, used and unknown', async () => {
      // Matching the API, which refuses to distinguish them: a stolen token
      // must not confirm that an invitation for that address ever existed.
      fetchMock.mockResolvedValue(
        jsonResponse(404, { error: { code: 'INVITATION_NOT_FOUND', message: 'Not valid.' } }),
      );

      renderWithProviders(<AcceptInvitationForm token="tok" />, { session: anonymousSession });

      expect(await screen.findByText('This invitation is no longer valid')).toBeInTheDocument();
      expect(screen.queryByLabelText('Choose a password')).not.toBeInTheDocument();
    });
  });
});
