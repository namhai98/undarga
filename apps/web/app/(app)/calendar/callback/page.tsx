import type { Metadata } from 'next';
import { CalendarCallback } from '@/features/calendar';

export const metadata: Metadata = {
  title: 'Connecting calendar — Undarga',
  robots: { index: false, follow: false },
  // The URL carries a one-time authorisation code: never send it onward.
  referrer: 'no-referrer',
};

/** The OAuth redirect URL registered with Google / Microsoft (CALENDAR_OAUTH_REDIRECT_URL). */
export default async function CalendarCallbackRoute({
  searchParams,
}: PageProps<'/calendar/callback'>) {
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  return <CalendarCallback code={value('code')} state={value('state')} error={value('error')} />;
}
