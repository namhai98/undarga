import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anonymousSession, renderWithProviders } from '@/test/render';
import { tokenStore } from '@/services/token-store';
import { LoginForm } from './login-form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/login',
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const session = (data: unknown) => ({ data, meta: { requestId: 'r' } });

describe('LoginForm', () => {
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

  const setup = () =>
    renderWithProviders(<LoginForm />, { session: anonymousSession });

  describe('client-side validation', () => {
    it('refuses an empty email without calling the API', async () => {
      const user = userEvent.setup();
      setup();

      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
      // The point of validating here: no wasted round trip, no server log line.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a malformed email', async () => {
      const user = userEvent.setup();
      setup();

      await user.type(screen.getByLabelText('Email'), 'not-an-email');
      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(
        await screen.findByText('That does not look like an email address.'),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an empty password', async () => {
      const user = userEvent.setup();
      setup();

      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByText('Enter your password.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('marks the invalid field for assistive technology', async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() =>
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true'),
      );
    });
  });

  describe('submission', () => {
    it('posts the credentials and stores the session', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          session({
            accessToken: 'tok',
            tokenType: 'Bearer',
            expiresIn: 900,
            activeCompanyId: 'c1',
            memberships: [
              { companyId: 'c1', companySlug: 'a', companyName: 'A', isOwner: false },
            ],
          }),
        ),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(tokenStore.accessToken).toBe('tok'));

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/auth/login');
      expect(JSON.parse(init.body)).toEqual({
        email: 'a@example.com',
        password: 'a-password',
      });
      // No session yet, so no stale bearer token may be attached.
      expect(init.headers.Authorization).toBeUndefined();
    });

    it('sends a single-company user straight into the app', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          session({
            accessToken: 'tok',
            tokenType: 'Bearer',
            expiresIn: 900,
            memberships: [
              { companyId: 'c1', companySlug: 'a', companyName: 'A', isOwner: false },
            ],
          }),
        ),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    });

    it('shows the picker when there is more than one company', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          session({
            accessToken: 'tok',
            tokenType: 'Bearer',
            expiresIn: 900,
            memberships: [
              { companyId: 'c1', companySlug: 'a', companyName: 'A', isOwner: false },
              { companyId: 'c2', companySlug: 'b', companyName: 'B', isOwner: true },
            ],
          }),
        ),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/select-company'));
    });

    it('explains a user who belongs to nothing', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          session({ accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, memberships: [] }),
        ),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/no-company'));
    });

    it('disables the form while the request is in flight', async () => {
      const user = userEvent.setup();
      let release: (r: Response) => void = () => {};
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'a-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      // A second click must not fire a second login.
      const pending = await screen.findByRole('button', { name: /Signing in/ });
      expect(pending).toBeDisabled();
      expect(screen.getByLabelText('Email')).toBeDisabled();

      release(jsonResponse(200, session({ accessToken: 't', expiresIn: 900, memberships: [] })));
    });
  });

  describe('failures', () => {
    it('gives one message for bad credentials, revealing nothing', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(
        jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid.' } }),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'wrong');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Those details did not work');
      // Must not distinguish "no such account" from "wrong password" — the API
      // deliberately does not, so that login cannot enumerate addresses.
      expect(alert.textContent).not.toMatch(/no such|unknown|not found|does not exist/i);
    });

    it('does not surface the raw backend message', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(
        jsonResponse(500, {
          error: { code: 'INTERNAL_ERROR', message: 'PrismaClientKnownRequestError P2002' },
        }),
      );

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'pw');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong on our side');
      expect(alert.textContent).not.toContain('Prisma');
    });

    it('distinguishes an unreachable server from a rejected password', async () => {
      const user = userEvent.setup();
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      setup();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.type(screen.getByLabelText('Password'), 'pw');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    });
  });

  describe('password visibility', () => {
    it('toggles between hidden and visible', async () => {
      const user = userEvent.setup();
      setup();

      const password = screen.getByLabelText('Password');
      expect(password).toHaveAttribute('type', 'password');

      await user.click(screen.getByRole('button', { name: 'Show password' }));
      expect(password).toHaveAttribute('type', 'text');

      await user.click(screen.getByRole('button', { name: 'Hide password' }));
      expect(password).toHaveAttribute('type', 'password');
    });
  });

  describe('an already-authenticated visitor', () => {
    it('is moved on rather than invited to sign in twice', async () => {
      renderWithProviders(<LoginForm />, {
        session: {
          ...anonymousSession,
          status: 'authenticated',
          memberships: [
            { companyId: 'c1', companySlug: 'a', companyName: 'A', isOwner: false },
          ],
        },
      });

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    });
  });
});
