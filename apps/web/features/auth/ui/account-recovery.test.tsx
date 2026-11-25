import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import {
  ChangePasswordForm,
  ForgotPasswordForm,
  ResetPasswordForm,
  VerifyEmail,
} from './account-recovery';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message = 'x') =>
  json({ error: { code, message, requestId: 'r' } }, status);

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

describe('ForgotPasswordForm', () => {
  it('gives the same answer whatever the address, and sends no token', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(envelope({ message: 'ok' }), 202)));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText('Email'), 'who@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByText(/If an account uses who@example.com/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/auth\/forgot-password$/);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('ResetPasswordForm', () => {
  it('holds a short or mismatched password back, then resets and returns to sign in', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<ResetPasswordForm token={'t'.repeat(32)} />);

    await user.type(screen.getByLabelText('New password'), 'short');
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New password'), '-but-now-long');
    await user.type(screen.getByLabelText('Repeat it'), 'different-password');
    expect(screen.getByText('The two passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Repeat it'));
    await user.type(screen.getByLabelText('Repeat it'), 'short-but-now-long');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?reset=1'));
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body).toEqual({ token: 't'.repeat(32), newPassword: 'short-but-now-long' });
  });

  it('explains an expired link and offers a new one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(apiError(410, 'ACCOUNT_TOKEN_EXPIRED'))),
    );
    const user = userEvent.setup();
    renderWithProviders(<ResetPasswordForm token={'t'.repeat(32)} />);

    await user.type(screen.getByLabelText('New password'), 'a-long-enough-one');
    await user.type(screen.getByLabelText('Repeat it'), 'a-long-enough-one');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText(/This link has expired/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});

describe('VerifyEmail', () => {
  it('spends the single-use token once, even under StrictMode', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(envelope({ email: 'a@example.com' }))));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(
      <StrictMode>
        <VerifyEmail token={'v'.repeat(32)} />
      </StrictMode>,
    );

    expect(await screen.findByText(/a@example.com is confirmed/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ChangePasswordForm', () => {
  it('says plainly when the current password is wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(apiError(401, 'INVALID_CREDENTIALS'))),
    );
    const user = userEvent.setup();
    renderWithProviders(<ChangePasswordForm />, {
      session: sessionWith({ activeCompanyId: 'co-1' }),
    });

    await user.type(screen.getByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'a-long-enough-one');
    await user.type(screen.getByLabelText('Repeat the new password'), 'a-long-enough-one');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Your current password is not right.')).toBeInTheDocument();
  });
});
