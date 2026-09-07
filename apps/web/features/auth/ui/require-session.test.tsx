import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anonymousSession, renderWithProviders, sessionWith } from '@/test/render';
import { RequireSession } from './require-session';

const replace = vi.fn();
let pathname = '/dashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}));

describe('RequireSession', () => {
  beforeEach(() => {
    replace.mockClear();
    pathname = '/dashboard';
  });

  it('renders the app for a signed-in user', () => {
    renderWithProviders(
      <RequireSession>
        <p>protected</p>
      </RequireSession>,
      { session: sessionWith() },
    );

    expect(screen.getByText('protected')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends an anonymous visitor to sign in', async () => {
    renderWithProviders(
      <RequireSession>
        <p>protected</p>
      </RequireSession>,
      { session: anonymousSession },
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=%2Fdashboard'));
    // Not even a flash of the protected content.
    expect(screen.queryByText('protected')).not.toBeInTheDocument();
  });

  it('remembers where they were going', async () => {
    pathname = '/settings/members';

    renderWithProviders(
      <RequireSession>
        <p>protected</p>
      </RequireSession>,
      { session: anonymousSession },
    );

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/login?next=%2Fsettings%2Fmembers'),
    );
  });

  describe('while the session is still being restored', () => {
    /**
     * The single most common bug in this pattern: treating "not yet known" as
     * "signed out". Every reload would flash the login screen at users who are
     * perfectly authenticated, because the bootstrap refresh has not answered
     * yet.
     */
    it('shows a placeholder rather than redirecting', () => {
      renderWithProviders(
        <RequireSession>
          <p>protected</p>
        </RequireSession>,
        { session: { ...anonymousSession, status: 'loading' } },
      );

      expect(replace).not.toHaveBeenCalled();
      expect(screen.queryByText('protected')).not.toBeInTheDocument();
      expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    });
  });
});
