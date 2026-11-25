import type { Metadata } from 'next';
import { LoginForm } from '@/features/auth';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Sign in — Undarga') };
}

/**
 * A Server Component that awaits `searchParams` and hands plain strings to a
 * client form.
 *
 * `searchParams` is a Promise in Next 16. Reading it here rather than with
 * `useSearchParams()` in the form keeps the client boundary at the form itself
 * and avoids needing a `<Suspense>` wrapper.
 *
 * Both parameters are attacker-controlled, and both are handled as such:
 * `next` is validated against an open redirect before any navigation
 * (`isSafeReturnPath`), and `email` only ever prefills an input.
 */
export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const t = await getT();
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const email = typeof params.email === 'string' ? params.email : undefined;
  const reset = params.reset === '1';

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Sign in')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('Use the email address your company invited.')}
        </p>
      </div>

      {reset ? (
        <p role="status" className="text-sm">
          {t('Your password was changed. Sign in with the new one.')}
        </p>
      ) : null}
      <LoginForm next={next} email={email} />
    </div>
  );
}
