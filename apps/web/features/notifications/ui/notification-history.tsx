'use client';

import { Loader2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import type { NotificationTypeInfo } from '@/services/notifications.service';
import {
  useNotification,
  useNotificationStats,
  useNotifications,
  useRunNotifications,
} from '../api/use-notifications';
import {
  CHANNEL_LABEL,
  STATUS_LABEL,
  humanType,
  notificationErrorMessage,
  retryState,
  statusVariant,
} from '../model/notification-display';

const PAGE_SIZE = 25;
const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * What the system has tried to tell people.
 *
 * Nothing here composes a message: notifications come from business events.
 * Recipients arrive masked from the API — checking that a reminder went out
 * does not need the customer's address. A failed message shows why, and where
 * it stands in its retry budget.
 */
export function NotificationHistory({ catalog }: { catalog: NotificationTypeInfo[] }) {
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canRun = useCan('settings:write');
  const notifications = useNotifications({
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(type ? { type } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const stats = useNotificationStats();
  const run = useRunNotifications();

  const items = notifications.data?.items ?? [];
  const total = notifications.data?.total ?? 0;
  const label = (t: string) => catalog.find((c) => c.type === t)?.label ?? humanType(t);

  const pump = async () => {
    setError(null);
    try {
      await run.mutateAsync();
    } catch (caught) {
      setError(notificationErrorMessage(caught, 'Could not process the queue.'));
    }
  };

  const filter = (set: (v: string) => void) => (value: string) => {
    set(value);
    setOffset(0);
  };

  return (
    <section className="grid gap-4" aria-label="Notification history">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-muted-foreground max-w-prose text-sm">
          Messages are queued by bookings, reminders and gift cards and sent in the background. No
          real email, SMS or push provider is connected yet — messages are recorded, not delivered.
        </p>
        {canRun ? (
          <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => void pump()}>
            {run.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Process queue now
          </Button>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not process the queue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {run.data ? (
        <Alert role="status">
          <AlertDescription>
            {run.data.reminders} reminder{run.data.reminders === 1 ? '' : 's'} scheduled,{' '}
            {run.data.dispatched} event{run.data.dispatched === 1 ? '' : 's'} turned into messages,{' '}
            {run.data.sent} sent, {run.data.failed} failed.
          </AlertDescription>
        </Alert>
      ) : null}

      {stats.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Sent" value={stats.data.byStatus.SENT ?? 0} />
          <Stat
            label="Failed or retrying"
            value={(stats.data.byStatus.FAILED ?? 0) + (stats.data.byStatus.RETRYING ?? 0)}
          />
          <Stat
            label="Events waiting"
            value={stats.data.pendingEvents}
            // Climbing and never falling means the worker is not running.
            warn={stats.data.pendingEvents > 0}
          />
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Filter id="notif-type" label="Type" value={type} onChange={filter(setType)}>
          {catalog.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </Filter>
        <Filter id="notif-channel" label="Channel" value={channel} onChange={filter(setChannel)}>
          {(['EMAIL', 'SMS', 'PUSH'] as const).map((value) => (
            <option key={value} value={value}>
              {CHANNEL_LABEL[value]}
            </option>
          ))}
        </Filter>
        <Filter id="notif-status" label="Status" value={status} onChange={filter(setStatus)}>
          {(['PENDING', 'SENT', 'RETRYING', 'FAILED', 'CANCELLED'] as const).map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </Filter>
      </div>

      {notifications.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load notifications</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {notifications.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading notifications…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {!notifications.isPending && !notifications.error && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">Nothing to show</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Messages appear here when a booking, a reminder or a gift card produces one.
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Created
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Type
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Channel
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Recipient
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Sent
                </th>
                <th scope="col" className="py-2 font-medium">
                  Error / retry
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const retry = retryState(row);
                return (
                  <tr key={row.id} className="border-border/40 border-b align-top last:border-0">
                    <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => setOpenId(row.id)}
                      >
                        {label(row.type)}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{CHANNEL_LABEL[row.channel]}</td>
                    <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">
                      {row.recipientAddress}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={statusVariant(row.status)}>{STATUS_LABEL[row.status]}</Badge>
                    </td>
                    <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                      {row.sentAt ? new Date(row.sentAt).toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-xs">
                      {row.failureReason ? (
                        <span className="text-destructive block">{row.failureReason}</span>
                      ) : null}
                      {retry ? <span className="text-muted-foreground block">{retry}</span> : null}
                      {!row.failureReason && !retry ? (
                        <span className="text-muted-foreground">—</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
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
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {openId ? (
        <NotificationDetailPanel id={openId} label={label} onClose={() => setOpenId(null)} />
      ) : null}
    </section>
  );
}

function NotificationDetailPanel({
  id,
  label,
  onClose,
}: {
  id: string;
  label: (type: string) => string;
  onClose: () => void;
}) {
  const detail = useNotification(id);
  const data = detail.data;

  return (
    <section
      aria-label="Notification"
      className="border-border/60 grid gap-3 rounded-lg border p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium">
          {data ? `${label(data.type)} · ${CHANNEL_LABEL[data.channel]}` : 'Notification'}
        </h3>
        <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
          <X aria-hidden className="size-4" />
        </Button>
      </header>
      {detail.isPending ? <Skeleton className="h-20 w-full" /> : null}
      {detail.error ? (
        <p role="alert" className="text-destructive text-sm">
          Could not load this notification.
        </p>
      ) : null}
      {data ? (
        <div className="grid gap-2 text-sm">
          <p className="text-muted-foreground text-xs">
            To <span className="font-mono">{data.recipientAddress}</span> ·{' '}
            {data.customTemplate ? 'company template' : 'default wording'} ·{' '}
            {STATUS_LABEL[data.status]}
            {data.provider ? ` via ${data.provider}` : ''}
          </p>
          {data.subject ? <p className="font-medium">{data.subject}</p> : null}
          <pre className="bg-muted/40 rounded-md p-3 font-sans text-sm whitespace-pre-wrap">
            {data.body ?? data.preview ?? ''}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function Filter(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <select
        id={props.id}
        value={props.value}
        className={selectClass}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">All</option>
        {props.children}
      </select>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="border-border/60 grid gap-1 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className={`text-lg font-semibold tabular-nums ${warn ? 'text-amber-600 dark:text-amber-500' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}
