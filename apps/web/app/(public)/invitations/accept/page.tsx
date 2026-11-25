import type { Metadata } from 'next';
import { AcceptInvitationForm } from '@/features/auth';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t('Accept invitation — Undarga'),
    // The URL carries a one-time token, so keep it out of search indexes and out
    // of any Referer sent onward from this page.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/**
 * The page an invitation link opens.
 *
 * The token arrives in the query string — unavoidable, because the link has to
 * survive being pasted into a chat window. This is as far as it travels in a
 * URL: the form posts it in a request body, so it never reaches the API's
 * access logs or its `Referer` header. `referrer: 'no-referrer'` above stops
 * this page leaking it onward to anything it links to.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: PageProps<'/invitations/accept'>) {
  const t = await getT();
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Join your team')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('Accepting adds you to the company below.')}
        </p>
      </div>

      <AcceptInvitationForm token={token} />
    </div>
  );
}
