import type { Metadata } from 'next';
import { LoginForm } from '@/features/auth';

export const metadata: Metadata = { title: 'Sign in — Undarga' };

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
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const email = typeof params.email === 'string' ? params.email : undefined;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-muted-foreground text-sm">
          Use the email address your company invited.
        </p>
      </div>

      <LoginForm next={next} email={email} />
    </div>
  );
}
