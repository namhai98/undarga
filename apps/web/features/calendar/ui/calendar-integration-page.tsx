'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import type {
  CalendarEmployee,
  CalendarOverview,
  CalendarProvider,
} from '@/services/calendar.service';
import {
  useCalendarChoices,
  useCalendarOverview,
  useCalendarStatus,
  useDisconnectCalendar,
  useResyncCalendar,
  useStartCalendarConnection,
  useUpdateCalendarConnection,
} from '../api/use-calendar';
import {
  PROVIDER_LABEL,
  STATUS_LABEL,
  calendarErrorMessage,
  sendBrowserTo,
  when,
} from '../model/calendar-display';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full max-w-sm rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Calendar integration: connect an employee's Google or Outlook calendar.
 *
 * One-way: appointments are written to the calendar, and its busy times can
 * block bookings. Nothing done in the calendar changes an appointment.
 *
 * Seeing this needs `schedule:read`; the list holds only the employees you may
 * manage — everyone with `schedule:write:any`, or your own staff profile with
 * `schedule:write:own`. The API enforces the same rules.
 */
export function CalendarIntegrationPage({ justConnected = false }: { justConnected?: boolean }) {
  const canRead = useCan('schedule:read');
  const overview = useCalendarOverview();

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>
          You do not have permission to see calendar integrations.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Calendar integration</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Appointments are added to the connected calendar automatically. Busy times in that
          calendar can block bookings. This is one-way: changes made in the calendar do not change
          appointments, and calendar events never include customer details.
        </p>
      </header>

      {justConnected ? (
        <Alert role="status">
          <AlertDescription>
            Calendar connected. Upcoming appointments are being added.
          </AlertDescription>
        </Alert>
      ) : null}

      {overview.isPending ? <Skeleton className="h-60 w-full" aria-busy="true" /> : null}
      {overview.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load calendars</AlertTitle>
          <AlertDescription>Please try again.</AlertDescription>
        </Alert>
      ) : null}
      {overview.data ? <Overview data={overview.data} /> : null}
    </div>
  );
}

function Overview({ data }: { data: CalendarOverview }) {
  const canManageAny = useCan('schedule:write:any');
  const usable = data.providers.filter((p) => p.configured);
  return (
    <>
      <section aria-label="Providers" className="flex flex-wrap gap-2">
        {data.providers.map((p) => (
          <Badge key={p.provider} variant={p.configured ? 'default' : 'secondary'}>
            {p.label}: {p.configured ? 'available' : 'not set up on this server'}
          </Badge>
        ))}
      </section>

      {!data.encryptionAvailable ? (
        <Alert role="status">
          <AlertTitle>Calendar connections are not available yet</AlertTitle>
          <AlertDescription>
            The server has no encryption key for storing calendar access, so no calendar can be
            connected. An administrator needs to set SECRETS_ENCRYPTION_KEY.
          </AlertDescription>
        </Alert>
      ) : usable.length === 0 ? (
        <Alert role="status">
          <AlertTitle>No calendar provider is set up</AlertTitle>
          <AlertDescription>
            An administrator needs to add Google or Microsoft OAuth credentials before calendars can
            be connected.
          </AlertDescription>
        </Alert>
      ) : null}

      {data.employees.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No calendars you can manage</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {canManageAny
              ? 'Add active staff first; each staff member can then have a calendar connected.'
              : 'You can connect your own calendar once your login is linked to your staff profile.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {data.employees.map((employee) => (
            <EmployeeCalendar
              key={employee.employeeId}
              employee={employee}
              providers={usable.map((p) => p.provider)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function EmployeeCalendar({
  employee,
  providers,
}: {
  employee: CalendarEmployee;
  providers: CalendarProvider[];
}) {
  const start = useStartCalendarConnection();
  const [error, setError] = useState<string | null>(null);
  const connection = employee.connection;

  const connect = async (provider: CalendarProvider) => {
    setError(null);
    try {
      const { authorizationUrl } = await start.mutateAsync({
        provider,
        employeeId: employee.employeeId,
      });
      sendBrowserTo(authorizationUrl);
    } catch (caught) {
      setError(calendarErrorMessage(caught, 'Could not start connecting the calendar.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            {employee.displayName}
            {employee.isSelf ? (
              <span className="text-muted-foreground font-normal"> (you)</span>
            ) : null}
          </CardTitle>
          {connection ? (
            <Badge variant={connection.status === 'ACTIVE' ? 'default' : 'destructive'}>
              {STATUS_LABEL[connection.status]}
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )}
        </div>
        {connection ? (
          <CardDescription>
            {PROVIDER_LABEL[connection.provider]}
            {connection.accountEmail ? ` · ${connection.accountEmail}` : ''}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {!connection ? (
          <div className="flex flex-wrap gap-2">
            {providers.length === 0 ? (
              <p className="text-muted-foreground">No provider is available to connect.</p>
            ) : (
              providers.map((provider) => (
                <Button
                  key={provider}
                  size="sm"
                  variant="outline"
                  disabled={start.isPending}
                  onClick={() => void connect(provider)}
                >
                  {start.isPending && start.variables?.provider === provider ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : null}
                  Connect {PROVIDER_LABEL[provider]}
                </Button>
              ))
            )}
          </div>
        ) : (
          <ConnectionDetails
            employee={employee}
            reconnect={() => void connect(connection.provider)}
            reconnecting={start.isPending}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionDetails({
  employee,
  reconnect,
  reconnecting,
}: {
  employee: CalendarEmployee;
  reconnect: () => void;
  reconnecting: boolean;
}) {
  const connection = employee.connection!;
  const active = connection.status === 'ACTIVE';
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const choices = useCalendarChoices(connection.id, choosing && active);
  const status = useCalendarStatus(connection.id, connection.failedEvents > 0);
  const update = useUpdateCalendarConnection();
  const resync = useResyncCalendar();
  const disconnect = useDisconnectCalendar();

  const run = async (action: () => Promise<unknown>, ok: string, fallback: string) => {
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: ok });
    } catch (caught) {
      setMessage({ ok: false, text: calendarErrorMessage(caught, fallback) });
    }
  };

  return (
    <div className="grid gap-3">
      {connection.status === 'NEEDS_REAUTH' ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Reconnect this calendar</AlertTitle>
          <AlertDescription>
            {connection.lastError ?? 'The calendar no longer accepts our access.'} Appointments are
            not being synced, and its busy times are not used, until it is reconnected.
          </AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[11rem_1fr]">
        <dt className="text-muted-foreground">Calendar</dt>
        <dd>
          {connection.calendarName ??
            (connection.calendarId === 'primary' ? 'Primary calendar' : connection.calendarId)}
        </dd>
        <dt className="text-muted-foreground">Last synced</dt>
        <dd>{when(connection.lastSyncAt)}</dd>
        {connection.useForAvailability ? (
          <>
            <dt className="text-muted-foreground">Busy times updated</dt>
            <dd>{when(connection.busySyncedAt)}</dd>
          </>
        ) : null}
        {connection.lastError && active ? (
          <>
            <dt className="text-muted-foreground">Last error</dt>
            <dd className="text-destructive">
              {connection.lastError}{' '}
              <span className="text-muted-foreground">({when(connection.lastErrorAt)})</span>
            </dd>
          </>
        ) : null}
        {connection.failedEvents > 0 ? (
          <>
            <dt className="text-muted-foreground">Not synced</dt>
            <dd>
              {connection.failedEvents} appointment{connection.failedEvents === 1 ? '' : 's'}
              {status.data?.queue.pending ? ` · ${status.data.queue.pending} waiting to retry` : ''}
            </dd>
          </>
        ) : null}
      </dl>

      {choosing && active ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`calendar-${connection.id}`}>Add appointments to</Label>
          {choices.isPending ? (
            <Skeleton className="h-8 w-60" />
          ) : choices.error ? (
            <p role="alert" className="text-destructive">
              {calendarErrorMessage(choices.error, 'Could not load the calendars.')}
            </p>
          ) : (
            <select
              id={`calendar-${connection.id}`}
              className={selectClass}
              defaultValue=""
              disabled={update.isPending}
              onChange={(e) => {
                const calendarId = e.target.value;
                if (!calendarId) return;
                void run(
                  () => update.mutateAsync({ connectionId: connection.id, calendarId }),
                  'Calendar changed. Appointments are moving to it.',
                  'Could not change the calendar.',
                ).then(() => setChoosing(false));
              }}
            >
              <option value="">Choose a calendar…</option>
              {(choices.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.primary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      <fieldset className="grid gap-2" disabled={!active || update.isPending}>
        <legend className="sr-only">Sync options</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={connection.useForAvailability}
            onChange={(e) =>
              void run(
                () =>
                  update.mutateAsync({
                    connectionId: connection.id,
                    useForAvailability: e.target.checked,
                  }),
                e.target.checked
                  ? 'Busy times will block bookings.'
                  : 'Busy times no longer block bookings.',
                'Could not save.',
              )
            }
          />
          Use busy times in this calendar to block bookings
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={connection.syncCompleted}
            onChange={(e) =>
              void run(
                () =>
                  update.mutateAsync({
                    connectionId: connection.id,
                    syncCompleted: e.target.checked,
                  }),
                'Saved.',
                'Could not save.',
              )
            }
          />
          Keep completed appointments in the calendar
        </label>
      </fieldset>

      {message ? (
        <Alert
          variant={message.ok ? 'default' : 'destructive'}
          role={message.ok ? 'status' : 'alert'}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {active ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={resync.isPending}
              onClick={() =>
                void run(
                  () => resync.mutateAsync(connection.id),
                  'Synced.',
                  'Could not sync the calendar.',
                )
              }
            >
              {resync.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Sync now
            </Button>
            {!choosing ? (
              <Button size="sm" variant="outline" onClick={() => setChoosing(true)}>
                Change calendar
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          size="sm"
          variant={active ? 'ghost' : 'default'}
          disabled={reconnecting}
          onClick={reconnect}
        >
          Reconnect
        </Button>
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() =>
                void run(
                  () => disconnect.mutateAsync(connection.id),
                  'Disconnected.',
                  'Could not disconnect.',
                )
              }
            >
              Yes, disconnect
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
      {confirming ? (
        <p className="text-muted-foreground text-xs">
          Upcoming appointments are removed from the calendar and the stored access is deleted.
        </p>
      ) : null}
    </div>
  );
}
