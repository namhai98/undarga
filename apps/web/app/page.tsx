import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { ApiConnectionCard } from '@/features/system-status';
import { getT } from '@/lib/i18n/server';

/**
 * Foundation landing page.
 *
 * Deliberately not a product screen — no business feature is built yet. It
 * exists to prove the stack is wired end to end and to say plainly what is and
 * is not in place, so the next person starts from facts rather than guesses.
 */
export default async function HomePage() {
  const t = await getT();
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="space-y-2">
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          {t('Foundation')}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{t('Undarga Booking Platform')}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          {t(
            'Multi-tenant SaaS for companies with multiple branches. This page confirms the frontend can reach the backend.',
          )}
        </p>
        <div className="pt-1">
          <Link href="/login" className={buttonVariants({ size: 'lg' })}>
            {t('Sign in')}
          </Link>
        </div>
      </header>

      <ApiConnectionCard />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t('What is in place')}</h2>
        <ul className="text-muted-foreground grid gap-1.5 text-sm">
          <Item>
            {t('Turborepo workspace —')} <Code>apps/web</Code>, <Code>apps/api</Code>,{' '}
            <Code>{t('packages/*')}</Code>
          </Item>
          <Item>
            {t('NestJS API on')} <Code>/api/v1</Code> {t('with OpenAPI at')} <Code>/api/docs</Code>
          </Item>
          <Item>
            {t('PostgreSQL via Prisma, with row-level security enforcing tenant isolation')}
          </Item>
          <Item>{t('Redis wired for caching, locks and queues')}</Item>
          <Item>{t('Typed API client with token refresh, retries and cancellation')}</Item>
          <Item>{t('Sign-in, session restore across reloads, and company switching')}</Item>
          <Item>
            {t('Company provisioning and invitations, accepted at')}{' '}
            <Code>/invitations/accept</Code>
          </Item>
          <Item>
            {t('Member and role administration at')} <Code>/members</Code>
          </Item>
          <Item>{t('Password reset and email confirmation')}</Item>
        </ul>
      </section>
    </main>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden className="text-muted-foreground/50">
        —
      </span>
      <span>{children}</span>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{children}</code>;
}
