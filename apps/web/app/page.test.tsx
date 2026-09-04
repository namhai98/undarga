import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiConnectionCard } from '@/features/system-status';

/**
 * Application smoke test.
 *
 * Proves the app renders, providers compose, shadcn components mount, and the
 * connection card reflects what the API said. It does not assert on product
 * behaviour, because there is none yet.
 */
function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const envelope = (data: unknown) => ({ data, meta: { requestId: 'req-1' } });

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('ApiConnectionCard', () => {
  it('renders while the first request is in flight', () => {
    stubFetch(200, envelope({ ready: true, checks: {} }));

    renderWithQuery(<ApiConnectionCard />);

    expect(screen.getByText('API connection')).toBeInTheDocument();
    expect(screen.getByText(/Contacting the API/)).toBeInTheDocument();
  });

  it('shows each dependency once readiness resolves', async () => {
    stubFetch(
      200,
      envelope({
        ready: true,
        checks: {
          database: { status: 'up', latencyMs: 3 },
          redis: { status: 'not_configured' },
        },
      }),
    );

    renderWithQuery(<ApiConnectionCard />);

    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(await screen.findByText('Redis')).toBeInTheDocument();
    expect(await screen.findAllByText('Connected')).not.toHaveLength(0);
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
  });

  it('explains an unreachable API rather than showing a bare error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    renderWithQuery(<ApiConnectionCard />);

    expect(await screen.findByText(/Could not reach the API/)).toBeInTheDocument();
    // The two most common causes at this stage, named so the reader can act.
    expect(await screen.findByText(/NEXT_PUBLIC_API_URL/)).toBeInTheDocument();
    expect(await screen.findByText(/CORS_ORIGINS/)).toBeInTheDocument();
  });
});
