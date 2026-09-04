'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, ApiNetworkError } from '@/services/api-error';
import { useReadiness } from '../api/use-health';

const STATE_LABEL: Record<string, string> = {
  up: 'Connected',
  down: 'Unreachable',
  not_configured: 'Not configured',
};

/**
 * Live view of the API and its dependencies.
 *
 * This is the foundation's end-to-end proof: it exercises the browser, the API
 * client, CORS, the response envelope, NestJS, PostgreSQL and Redis in one
 * render. If this card is green, the whole chain is wired.
 */
export function ApiConnectionCard() {
  const { data, error, isPending, isFetching } = useReadiness();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-4">
          <span>API connection</span>
          {isFetching ? (
            <span className="text-muted-foreground text-xs font-normal">checking…</span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Live readiness of the backend and its dependencies, polled every 15 seconds.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {isPending ? <p className="text-muted-foreground text-sm">Contacting the API…</p> : null}

        {error ? <ConnectionError error={error} /> : null}

        {data ? (
          <>
            <StatusRow
              label="API"
              state={data.ready ? 'up' : 'down'}
              detail={data.ready ? 'ready' : 'not ready'}
            />
            {Object.entries(data.checks).map(([name, check]) => (
              <StatusRow
                key={name}
                label={name === 'database' ? 'PostgreSQL' : 'Redis'}
                state={check.status}
                detail={check.latencyMs === undefined ? undefined : `${check.latencyMs} ms`}
              />
            ))}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: string;
  detail?: string;
}) {
  const variant =
    state === 'up' ? 'default' : state === 'not_configured' ? 'secondary' : 'destructive';

  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="font-medium">{label}</span>
      <span className="flex items-center gap-2">
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
        <Badge variant={variant}>{STATE_LABEL[state] ?? state}</Badge>
      </span>
    </div>
  );
}

/**
 * Distinguishes "the API said no" from "the API never answered".
 *
 * They look identical to a user and have completely different causes — a 500
 * versus the backend not running, or CORS rejecting the origin — and telling
 * them apart is most of the debugging at this stage.
 */
function ConnectionError({ error }: { error: unknown }) {
  if (error instanceof ApiNetworkError) {
    return (
      <p className="text-destructive text-sm">
        Could not reach the API. Is it running on the URL in{' '}
        <code className="font-mono text-xs">NEXT_PUBLIC_API_URL</code>, and does{' '}
        <code className="font-mono text-xs">CORS_ORIGINS</code> include this origin?
      </p>
    );
  }

  if (error instanceof ApiError) {
    return (
      <p className="text-destructive text-sm">
        API returned <span className="font-mono text-xs">{error.code}</span> ({error.status}).
        {error.requestId ? (
          <>
            {' '}
            Request <span className="font-mono text-xs">{error.requestId}</span>.
          </>
        ) : null}
      </p>
    );
  }

  return <p className="text-destructive text-sm">Unexpected error contacting the API.</p>;
}
