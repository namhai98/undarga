import { ApiConnectionCard } from '@/features/system-status';

/**
 * Foundation landing page.
 *
 * Deliberately not a product screen — no business feature is built yet. It
 * exists to prove the stack is wired end to end and to say plainly what is and
 * is not in place, so the next person starts from facts rather than guesses.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="space-y-2">
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Foundation
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Undarga Booking Platform</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Multi-tenant SaaS for companies with multiple branches. This page confirms the
          frontend can reach the backend; no product features are implemented yet.
        </p>
      </header>

      <ApiConnectionCard />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">What is in place</h2>
        <ul className="text-muted-foreground grid gap-1.5 text-sm">
          <Item>Turborepo workspace — <Code>apps/web</Code>, <Code>apps/api</Code>, <Code>packages/*</Code></Item>
          <Item>NestJS API on <Code>/api/v1</Code> with OpenAPI at <Code>/api/docs</Code></Item>
          <Item>PostgreSQL via Prisma, with row-level security enforcing tenant isolation</Item>
          <Item>Redis wired for caching, locks and queues</Item>
          <Item>Typed API client with token refresh, retries and cancellation</Item>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Not built yet</h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Authentication UI, appointments, availability, payments, promotions, gift cards and
          notifications. The feature directories under <Code>features/</Code> are placeholders
          that mark where each will live.
        </p>
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
