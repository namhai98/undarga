'use client';

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useZodForm } from '@/hooks/use-zod-form';
import { ApiError, ApiNetworkError } from '@/services/api-error';
import { useLogin, destinationFor, isSafeReturnPath } from '../api/use-login';
import { useSession } from '../model/use-session';

const loginSchema = z.object({
  email: z.string().min(1, 'Enter your email address.').email('That does not look like an email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

/**
 * Turn a failure into something worth reading.
 *
 * Two rules. Never surface a raw backend message — it is written for an
 * operator and may name internals. And never distinguish "no such account"
 * from "wrong password": the API already refuses to, deliberately, so that
 * login cannot be used to discover which addresses are registered. Saying
 * "unknown email" here would give away exactly what the server withheld.
 */
function messageFor(error: unknown): { title: string; detail: string } {
  if (error instanceof ApiNetworkError) {
    return {
      title: 'Could not reach the server',
      detail: 'Check your connection and try again.',
    };
  }

  if (error instanceof ApiError) {
    if (error.status === 401 || error.code === 'INVALID_CREDENTIALS') {
      return {
        title: 'Those details did not work',
        detail: 'Check your email and password and try again.',
      };
    }
    if (error.status === 429) {
      return { title: 'Too many attempts', detail: 'Wait a moment before trying again.' };
    }
    if (error.status >= 500) {
      return {
        title: 'Something went wrong on our side',
        detail: 'Please try again. If it keeps happening, contact support.',
      };
    }
  }

  return { title: 'Could not sign you in', detail: 'Please try again.' };
}

export function LoginForm({ next, email: prefill }: { next?: string; email?: string }) {
  const router = useRouter();
  const session = useSession();
  const login = useLogin(next);
  const [showPassword, setShowPassword] = useState(false);
  const { errors, onSubmit, applyServerErrors } = useZodForm(loginSchema);

  /**
   * Someone already signed in has no business on the login screen — arriving
   * here from a bookmark or the back button should bounce them onward rather
   * than invite them to authenticate twice.
   */
  useEffect(() => {
    if (session.status === 'authenticated' && !session.isLoadingCompany) {
      router.replace(destinationFor(session, next && isSafeReturnPath(next) ? next : null));
    }
  }, [session, next, router]);

  const handle = onSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
    } catch (error) {
      // Field-level problems land on the inputs; everything else falls through
      // to the alert below.
      applyServerErrors(error);
    }
  });

  const pending = login.isPending;
  const failure = login.error && Object.keys(errors).length === 0 ? messageFor(login.error) : null;

  return (
    <form onSubmit={handle} noValidate className="grid gap-4">
      {failure ? (
        // `role="alert"` so a screen reader announces it — a sighted user sees
        // the box appear, and this is the equivalent.
        <Alert variant="destructive" role="alert">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.detail}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={prefill}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          // Focus goes to the password box instead when the address is already
          // filled in from an accepted invitation.
          autoFocus={!prefill}
          disabled={pending}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
        />
        {errors.email ? (
          <p id="email-error" className="text-destructive text-xs">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus={Boolean(prefill)}
            disabled={pending}
            className="pr-9"
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? 'password-error' : undefined}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Not focusable by keyboard: tabbing from the password field should
            // reach the submit button, not a display toggle. Anyone navigating
            // by keyboard can already read what they typed.
            tabIndex={-1}
            className="absolute top-0.5 right-0.5"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        </div>
        {errors.password ? (
          <p id="password-error" className="text-destructive text-xs">
            {errors.password}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
