'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/services/api-error';
import { authService } from '@/services/auth.service';
import { useLogout } from '../api/use-logout';
import { useT, type Translate } from '@/lib/i18n';

/** The API's password policy, checked here first so the message is immediate. */
export const MIN_PASSWORD_LENGTH = 12;

function tokenProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ACCOUNT_TOKEN_EXPIRED') return 'This link has expired. Ask for a new one.';
    if (error.code === 'ACCOUNT_TOKEN_INVALID') {
      return 'This link is not valid, or it has already been used. Ask for a new one.';
    }
    if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (error.status === 400) return error.message;
  }
  return 'Something went wrong. Please try again.';
}

function passwordProblem(password: string, confirm: string, t: Translate): string | null {
  if (password.length > 0 && password.length < MIN_PASSWORD_LENGTH) {
    return t('Use at least {MINPASSWORDLENGTH} characters.', {
      MINPASSWORDLENGTH: MIN_PASSWORD_LENGTH,
    });
  }
  if (confirm.length > 0 && password !== confirm) return t('The two passwords do not match.');
  return null;
}

/**
 * "Forgot your password?" The answer is the same whether or not the address
 * has an account — the server says so, and the screen must not guess more.
 */
export function ForgotPasswordForm() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      await authService.requestPasswordReset(email.trim());
      setState('sent');
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 429
          ? t('Too many requests. Wait a minute and try again.')
          : t('Could not send the link. Please try again.'),
      );
      setState('error');
    }
  };

  if (state === 'sent') {
    return (
      <Alert role="status">
        <AlertTitle>{t('Check your email')}</AlertTitle>
        <AlertDescription>
          {t('If an account uses')} {email.trim()}
          {t(', a link to set a new password is on its way. It works once and expires soon.')}{' '}
          <Link href="/login" className="underline">
            {t('Back to sign in')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-1.5">
        <Label htmlFor="forgot-email">{t('Email')}</Label>
        <Input
          id="forgot-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {state === 'error' && problem ? (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      ) : null}
      <Button type="submit" disabled={state === 'sending' || !email.trim()}>
        {state === 'sending' ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t('Email me a link')}
      </Button>
      <Link href="/login" className="text-muted-foreground text-sm hover:underline">
        {t('Back to sign in')}
      </Link>
    </form>
  );
}

/** The page a reset link opens. Every session is signed out on success. */
export function ResetPasswordForm({ token }: { token: string | undefined }) {
  const t = useT();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(password, confirm, t);

  if (!token) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{t('This link is incomplete')}</AlertTitle>
        <AlertDescription>
          {t('Open the link from the email again, or')}{' '}
          <Link href="/forgot-password" className="underline">
            {t('ask for a new one')}
          </Link>
          .
        </AlertDescription>
      </Alert>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authService.resetPassword(token, password);
      router.replace('/login?reset=1');
    } catch (caught) {
      setError(tokenProblem(caught));
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-1.5">
        <Label htmlFor="reset-password">{t('New password')}</Label>
        <Input
          id="reset-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {t('At least {MIN_PASSWORD_LENGTH} characters.', { MIN_PASSWORD_LENGTH })}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="reset-confirm">{t('Repeat it')}</Label>
        <Input
          id="reset-confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {problem || error ? (
        <p role="alert" className="text-destructive text-sm">
          {problem ?? error}{' '}
          {error ? (
            <Link href="/forgot-password" className="underline">
              {t('Ask for a new link')}
            </Link>
          ) : null}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={
          busy || Boolean(problem) || password.length < MIN_PASSWORD_LENGTH || password !== confirm
        }
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t('Set new password')}
      </Button>
      <p className="text-muted-foreground text-xs">
        {t('You will be signed out everywhere and asked to sign in with the new password.')}
      </p>
    </form>
  );
}

/** The page a verification link opens. Confirms once, on arrival. */
export function VerifyEmail({ token }: { token: string | undefined }) {
  const t = useT();
  const [state, setState] = useState<
    { kind: 'working' } | { kind: 'done'; email: string } | { kind: 'failed'; message: string }
  >(token ? { kind: 'working' } : { kind: 'failed', message: 'This link is incomplete.' });
  // Strict mode runs effects twice in development; a token is single-use.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    authService
      .verifyEmail(token)
      .then((r) => setState({ kind: 'done', email: r.email }))
      .catch((error: unknown) => setState({ kind: 'failed', message: tokenProblem(error) }));
  }, [token]);

  if (state.kind === 'working') {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden /> {t('Confirming your email…')}
      </p>
    );
  }
  if (state.kind === 'done') {
    return (
      <Alert role="status">
        <AlertTitle>{t('Email confirmed')}</AlertTitle>
        <AlertDescription>
          {state.email} {t('is confirmed.')}{' '}
          <Link href="/login" className="underline">
            {t('Sign in')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{t('Could not confirm your email')}</AlertTitle>
      <AlertDescription>{state.message}</AlertDescription>
    </Alert>
  );
}

/** For a signed-in user. Needs the current password; other sessions end. */
export function ChangePasswordForm() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(password, confirm, t);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    try {
      await authService.changePassword(current, password);
      setCurrent('');
      setPassword('');
      setConfirm('');
      setState('done');
    } catch (caught) {
      setError(
        caught instanceof ApiError &&
          (caught.status === 401 || caught.code === 'INVALID_CREDENTIALS')
          ? t('Your current password is not right.')
          : caught instanceof ApiError && caught.status === 429
            ? t('Too many attempts. Wait a minute and try again.')
            : caught instanceof ApiError && caught.status === 400
              ? caught.message
              : t('Could not change the password. Please try again.'),
      );
      setState('idle');
    }
  };

  return (
    <form className="grid gap-3 sm:max-w-md" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-1.5">
        <Label htmlFor="change-current">{t('Current password')}</Label>
        <Input
          id="change-current"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="change-new">{t('New password')}</Label>
        <Input
          id="change-new"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => {
            setState('idle');
            setPassword(e.target.value);
          }}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="change-confirm">{t('Repeat the new password')}</Label>
        <Input
          id="change-confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {problem || error ? (
        <p role="alert" className="text-destructive text-sm">
          {problem ?? error}
        </p>
      ) : null}
      {state === 'done' ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('Password changed. You stay signed in here; other devices were signed out.')}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={
            state === 'busy' ||
            !current ||
            Boolean(problem) ||
            password.length < MIN_PASSWORD_LENGTH ||
            password !== confirm
          }
        >
          {state === 'busy' ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Change password')}
        </Button>
      </div>
    </form>
  );
}

/** Ends every session, this one included, then signs out here. */
export function SignOutEverywhere() {
  const t = useT();
  const logout = useLogout();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="grid gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(false);
            authService
              .logoutEverywhere()
              .then(() => logout.mutate())
              .catch(() => {
                setError(true);
                setBusy(false);
              });
          }}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Sign out on every device')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {t('Could not sign out everywhere. Please try again.')}
        </p>
      ) : null}
    </div>
  );
}
