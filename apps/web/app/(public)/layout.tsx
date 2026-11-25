import Link from 'next/link';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { getT } from '@/lib/i18n/server';

/**
 * Shell for the screens you reach without a session: sign in, accept an
 * invitation.
 *
 * A route group — the `(public)` folder adds no URL segment, so these live at
 * `/login` and `/invitations/accept`. It exists to give both a shared frame
 * and, more importantly, to keep them out of `(app)`, whose layout demands a
 * session.
 */
export default async function PublicLayout({ children }: LayoutProps<'/'>) {
  const t = await getT();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div className="flex items-center justify-between gap-2">
        <Link href="/" className="text-muted-foreground hover:text-foreground text-sm">
          {t('Undarga')}
        </Link>
        <LocaleSwitcher />
      </div>
      {children}
    </main>
  );
}
