import Link from 'next/link';

/**
 * Shell for the screens you reach without a session: sign in, accept an
 * invitation.
 *
 * A route group — the `(public)` folder adds no URL segment, so these live at
 * `/login` and `/invitations/accept`. It exists to give both a shared frame
 * and, more importantly, to keep them out of `(app)`, whose layout demands a
 * session.
 */
export default function PublicLayout({ children }: LayoutProps<'/'>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <Link href="/" className="text-muted-foreground hover:text-foreground text-sm">
        Undarga
      </Link>
      {children}
    </main>
  );
}
