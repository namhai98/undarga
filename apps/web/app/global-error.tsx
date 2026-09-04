'use client';

/**
 * Last-resort error boundary.
 *
 * Catches failures in the root layout itself, which the per-route `error.tsx`
 * cannot. It REPLACES the root layout when it renders, so it must supply its
 * own <html> and <body> and cannot rely on any provider.
 *
 * Deliberately dependency-free: no design-system components, no data fetching.
 * If the root layout has already failed, anything this file imports might be
 * the thing that failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <main style={{ maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#555', fontSize: '0.875rem', marginBottom: '1rem' }}>
            The page could not be displayed. Trying again is usually enough; if it keeps
            happening, quote the reference below.
          </p>
          {/* `digest` is a server-generated hash, safe to show. The message itself is
              not: in production it can carry internal detail. */}
          {error.digest ? (
            <p style={{ color: '#777', fontSize: '0.75rem', marginBottom: '1rem' }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              border: '1px solid #ddd',
              borderRadius: '0.375rem',
              padding: '0.5rem 0.875rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
