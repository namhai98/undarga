'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCompleteCalendarConnection } from '../api/use-calendar';
import { calendarErrorMessage, providerDenialMessage } from '../model/calendar-display';
import { useT } from '@/lib/i18n';

/**
 * Where Google / Microsoft send the browser back after consent.
 *
 * Posts `code` and `state` to the API exactly once (the state is single-use,
 * so a second post — React's development double-mount, a refresh — must not
 * happen), then moves on to the settings page with the code out of the URL.
 */
export function CalendarCallback(props: { code: string; state: string; error: string }) {
  const t = useT();
  const router = useRouter();
  const complete = useCompleteCalendarConnection();
  const sent = useRef(false);
  const { mutate } = complete;

  useEffect(() => {
    if (sent.current || props.error || !props.code || !props.state) return;
    sent.current = true;
    mutate(
      { code: props.code, state: props.state },
      { onSuccess: () => router.replace('/calendar?connected=1') },
    );
  }, [mutate, props.code, props.state, props.error, router]);

  const problem = props.error
    ? providerDenialMessage(props.error)
    : !props.code || !props.state
      ? 'This page was opened without an authorisation from the calendar provider.'
      : complete.error
        ? calendarErrorMessage(complete.error, 'The calendar could not be connected. Try again.')
        : null;

  if (problem) {
    return (
      <div className="grid gap-4">
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Calendar not connected')}</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
        <Link href="/calendar" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('Back to calendar settings')}
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-3" aria-busy="true">
      <p className="text-sm">{t('Connecting your calendar…')}</p>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
