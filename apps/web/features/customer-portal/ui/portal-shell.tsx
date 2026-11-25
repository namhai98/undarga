'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/services/api-error';
import {
  useCustomerProfile,
  useCustomerSession,
  useCustomerSignOut,
  useRequestCode,
  useVerifyCode,
} from '../api/use-customer-portal';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { useT } from '@/lib/i18n';

/**
 * The customer portal's frame and its sign-in gate, for one business.
 *
 * A redirect-free gate: while the session is unknown it shows a placeholder,
 * signed out it shows the sign-in form in place. The boundary is the API —
 * customer-realm routes refuse any other token — not this component.
 */
export function PortalShell({ slug, children }: { slug: string; children: ReactNode }) {
  const t = useT();
  const session = useCustomerSession(slug);

  if (session.status === 'unknown') {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t('Checking your session…')}</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (session.status === 'signed-out') return <SignIn slug={slug} />;
  return <Frame slug={slug}>{children}</Frame>;
}

function Frame({ slug, children }: { slug: string; children: ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  const profile = useCustomerProfile(slug);
  const signOut = useCustomerSignOut(slug);
  const root = `/portal/${slug}`;
  const nav = [
    { href: root, label: 'Overview' },
    { href: `${root}/appointments`, label: 'Appointments' },
    { href: `${root}/gift-cards`, label: 'Gift cards' },
    { href: `${root}/profile`, label: 'Profile' },
  ];

  return (
    <div className="grid gap-6">
      <LocaleSwitcher className="justify-end" />
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-0.5">
            <p className="text-muted-foreground text-xs">{t('Your account at')}</p>
            <p className="text-lg font-semibold">{profile.data?.company.name ?? '…'}</p>
          </div>
          <div className="flex gap-2">
            <Link href={`/book/${slug}`} className={buttonVariants({ size: 'sm' })}>
              {t('Book an appointment')}
            </Link>
            <Button
              variant="ghost"
              size="sm"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {t('Sign out')}
            </Button>
          </div>
        </div>
        <nav
          aria-label={t('Account')}
          className="border-border/60 flex gap-4 overflow-x-auto border-b pb-2"
        >
          {nav.map((item) => {
            const active = item.href === root ? pathname === root : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`text-sm whitespace-nowrap ${active ? 'font-medium underline underline-offset-4' : 'text-muted-foreground'}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}

/**
 * Sign in with a code sent to the email the business has on file. Customers
 * book with a name and contact details; there is no password to remember.
 */
export function SignIn({ slug }: { slug: string }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [error, setError] = useState<string | null>(null);
  const request = useRequestCode(slug);
  const verify = useVerifyCode(slug);

  const sendCode = async () => {
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError(t('Enter the email address you booked with.'));
      return;
    }
    try {
      await request.mutateAsync(email.trim().toLowerCase());
      setStep('code');
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? t('We could not find this business.')
          : caught instanceof ApiError && caught.status === 429
            ? t('Too many attempts. Wait a minute and try again.')
            : t('Could not send a code. Please try again.'),
      );
    }
  };

  const checkCode = async () => {
    setError(null);
    try {
      await verify.mutateAsync({ email: email.trim().toLowerCase(), code: code.trim() });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'SIGN_IN_CODE_INVALID'
          ? t('That code is not valid or has expired. Check it, or send a new one.')
          : caught instanceof ApiError && caught.status === 400
            ? t('Enter the 6-digit code from the email.')
            : t('Could not sign you in. Please try again.'),
      );
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-sm gap-5">
      <LocaleSwitcher className="justify-end" />
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Your bookings')}</h1>
        <p className="text-muted-foreground text-sm">
          {t(
            'See, change or cancel your appointments. We&rsquo;ll email you a sign-in code — no password needed.',
          )}
        </p>
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>
            {step === 'email' ? t('Could not send a code') : t('Could not sign in')}
          </AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {step === 'email' ? (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="portal-email">{t('Email')}</Label>
            <Input
              id="portal-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {t('The address you used when booking.')}
            </p>
          </div>
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Email me a code')}
          </Button>
        </form>
      ) : (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void checkCode();
          }}
        >
          <p className="text-sm" role="status">
            {t('If')} <span className="font-medium">{email.trim()}</span>{' '}
            {t('is on file here, a 6-digit code is on its way. It expires in 10 minutes.')}
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="portal-code">{t('Code')}</Label>
            <Input
              id="portal-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="font-mono tracking-widest"
            />
          </div>
          <Button type="submit" disabled={verify.isPending || code.length !== 6}>
            {verify.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Sign in')}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={request.isPending}
              onClick={() => void sendCode()}
            >
              {t('Send a new code')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep('email');
                setCode('');
                setError(null);
              }}
            >
              {t('Use another email')}
            </Button>
          </div>
        </form>
      )}

      <Link
        href={`/book/${slug}`}
        className="text-muted-foreground text-sm underline underline-offset-4"
      >
        {t('Not booked yet? Book an appointment')}
      </Link>
    </div>
  );
}
