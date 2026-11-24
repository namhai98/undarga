'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { PlatformAuditQuery } from '@/services/platform.service';
import { usePlatformAuditLogs } from '../api/use-platform';

const PAGE_SIZE = 50;

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

const ACTOR_TYPES = ['PLATFORM_USER', 'COMPANY_USER', 'CUSTOMER', 'SYSTEM', 'API_KEY'] as const;

/**
 * Administrative history across every tenant.
 *
 * ---------------------------------------------------------------------------
 * THE CHANGED VALUES ARE NOT HERE, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * An audit row records what changed. For a tenant's own actions that means
 * customer names, phone numbers and prices — so the API returns the action, the
 * actor and the time, and nothing else. A reason appears only on `platform.*`
 * rows, where it is an operator's own note about a business decision.
 *
 * A tenant can still see the full detail of its own history on its own audit
 * screen, which is the right place for it: the company that owns the data.
 */
export function PlatformAuditLog({ companyId }: { companyId?: string } = {}) {
  const [action, setAction] = useState('');
  const [actorType, setActorType] = useState('');
  const [from, setFrom] = useState('');
  const [offset, setOffset] = useState(0);

  const query: PlatformAuditQuery = {
    ...(companyId ? { companyId } : {}),
    ...(action ? { action } : {}),
    ...(actorType ? { actorType } : {}),
    ...(from ? { from } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const logs = usePlatformAuditLogs(query);
  const total = logs.data?.total ?? 0;
  const items = logs.data?.items ?? [];

  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Audit logs</h1>
        <p className="text-muted-foreground text-sm">
          {logs.isPending ? 'Loading…' : `${total} recorded`}
          {companyId ? ' for this company' : ' across every tenant'}. What happened and who did
          it — never what changed.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">Action</Label>
          <Input
            id="audit-action"
            value={action}
            placeholder="platform.company.suspended"
            className="font-mono text-xs"
            onChange={(e) => changeFilter(() => setAction(e.target.value))}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="audit-actor">Actor</Label>
          <select
            id="audit-actor"
            value={actorType}
            className={selectClass}
            onChange={(e) => changeFilter(() => setActorType(e.target.value))}
          >
            <option value="">Anyone</option>
            {ACTOR_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
          />
        </div>
      </div>

      {logs.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load the audit trail</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {logs.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading the audit trail…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {!logs.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">Nothing matches those filters</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Administrative actions are recorded here as they happen.
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">When</th>
                <th scope="col" className="py-2 pr-3 font-medium">Action</th>
                <th scope="col" className="py-2 pr-3 font-medium">Company</th>
                <th scope="col" className="py-2 pr-3 font-medium">Who</th>
                <th scope="col" className="py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id} className="border-border/40 border-b last:border-0">
                  <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                    {new Date(entry.occurredAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{entry.action}</td>
                  <td className="py-2 pr-3">
                    {entry.companyId ? (
                      <Link
                        href={`/platform/companies/${entry.companyId}`}
                        className="hover:underline"
                      >
                        {entry.companyName ?? entry.companySlug}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Platform</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="truncate">{entry.actorLabel}</span>
                    {entry.actorType === 'PLATFORM_USER' ? (
                      <Badge variant="secondary" className="ml-2">operator</Badge>
                    ) : null}
                  </td>
                  <td className="text-muted-foreground py-2">{entry.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || logs.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || logs.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {logs.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
