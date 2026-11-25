'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useZodForm } from '@/hooks/use-zod-form';
import { ApiError } from '@/services/api-error';
import { useAcceptInvitation, useInvitationPreview } from '../api/use-invitation';
import { useSession } from '../model/use-session';
import { useT } from '@/lib/i18n';

/** Matches the API. Length is what resists guessing; composition rules are theatre. */
const newAccountSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter your name.').max(128),
  password: z.string().min(12, 'Use at least 12 characters.').max(512),
});

const emptySchema = z.object({});

function DeadEnd({ title, detail }: { title: string; detail: string }) {
  const t = useT();
  return (
    <div className="grid gap-4">
      <Alert variant="destructive" role="alert">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{detail}</AlertDescription>
      </Alert>
      <div>
        <Link href="/login" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('Go to sign in')}
        </Link>
      </div>
    </div>
  );
}

/**
 * Accept an invitation.
 *
 * Three states, decided by the server rather than guessed at here:
 *
 *   no account yet          -> choose a name and password
 *   account, not signed in  -> sign in first, then come back
 *   account, signed in as   -> one button
 *   the invited address
 *
 * The middle case is a security property, not an inconvenience: if accepting
 * could set a password on an existing account, a leaked link would be a
 * password reset for somebody else. The API refuses, and this explains why.
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const t = useT();
  const session = useSession();
  const preview = useInvitationPreview(token);
  const accept = useAcceptInvitation(token);

  const needsAccount = preview.data ? !preview.data.accountExists : false;
  const form = useZodForm(needsAccount ? newAccountSchema : emptySchema);

  if (!token) {
    return (
      <DeadEnd
        title={t('This link is incomplete')}
        detail="It is missing its invitation code. Ask whoever invited you to send it again."
      />
    );
  }

  if (preview.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">{t('Checking your invitation…')}</span>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (preview.error) {
    const error = preview.error;
    if (error instanceof ApiError && error.code === 'INVITATION_EXPIRED') {
      return (
        <DeadEnd
          title={t('This invitation has expired')}
          detail="Ask whoever invited you to send a new link."
        />
      );
    }
    return (
      <DeadEnd
        title={t('This invitation is no longer valid')}
        detail="It may have been used already or withdrawn. Ask for a new link."
      />
    );
  }

  const invitation = preview.data;
  const signedInAsInvitee =
    session.status === 'authenticated' &&
    session.user?.email.toLowerCase() === invitation.email.toLowerCase();
  const signedInAsSomeoneElse = session.status === 'authenticated' && !signedInAsInvitee;

  const handle = form.onSubmit(async (values) => {
    try {
      await accept.mutateAsync(values as { fullName?: string; password?: string });
    } catch (error) {
      form.applyServerErrors(error);
    }
  });

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <p className="text-sm">
          <span className="font-medium">{invitation.companyName}</span> {t('has invited')}{' '}
          <span className="font-medium">{invitation.email}</span> {t('to join as')}{' '}
          {invitation.roles.map((r) => r.name).join(', ')}.
        </p>
        <p className="text-muted-foreground text-xs">
          {t('Expires')} {new Date(invitation.expiresAt).toLocaleDateString()}.
        </p>
      </div>

      {signedInAsSomeoneElse ? (
        <DeadEnd
          title={t('You are signed in as someone else')}
          detail={t(
            'This invitation is for {email}. Sign out and sign back in as that address to accept it.',
            { email: invitation.email },
          )}
        />
      ) : null}

      {!signedInAsSomeoneElse && !needsAccount && !signedInAsInvitee ? (
        <div className="grid gap-3">
          <Alert role="status">
            <AlertTitle>{t('You already have an account')}</AlertTitle>
            <AlertDescription>
              {t('Sign in as {email}, then open this link again to accept.', {
                email: invitation.email,
              })}
            </AlertDescription>
          </Alert>
          <Link
            href={`/login?email=${encodeURIComponent(invitation.email)}`}
            className={buttonVariants({ size: 'lg' })}
          >
            {t('Sign in to accept')}
          </Link>
        </div>
      ) : null}

      {!signedInAsSomeoneElse && (needsAccount || signedInAsInvitee) ? (
        <form onSubmit={handle} noValidate className="grid gap-4">
          {accept.error && Object.keys(form.errors).length === 0 ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{t('Could not accept the invitation')}</AlertTitle>
              <AlertDescription>
                {accept.error instanceof ApiError && accept.error.code === 'INVITATION_EXPIRED'
                  ? t('It expired while this page was open. Ask for a new link.')
                  : t('Please try again, or ask for a new link.')}
              </AlertDescription>
            </Alert>
          ) : null}

          {needsAccount ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="fullName">{t('Your name')}</Label>
                <Input
                  id="fullName"
                  name="fullName"
                  autoComplete="name"
                  autoFocus
                  disabled={accept.isPending}
                  aria-invalid={Boolean(form.errors.fullName)}
                />
                {form.errors.fullName ? (
                  <p className="text-destructive text-xs">{form.errors.fullName}</p>
                ) : null}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="password">{t('Choose a password')}</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  disabled={accept.isPending}
                  aria-invalid={Boolean(form.errors.password)}
                  aria-describedby="password-hint"
                />
                <p id="password-hint" className="text-muted-foreground text-xs">
                  {t('At least 12 characters. Length matters more than symbols.')}
                </p>
                {form.errors.password ? (
                  <p className="text-destructive text-xs">{form.errors.password}</p>
                ) : null}
              </div>
            </>
          ) : null}

          <Button type="submit" size="lg" disabled={accept.isPending} className="w-full">
            {accept.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {accept.isPending
              ? t('Joining…')
              : t('Join {companyName}', { companyName: invitation.companyName })}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
