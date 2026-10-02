import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { ServiceList } from './service-list';

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const service = (overrides: Record<string, unknown> = {}) => ({
  id: 'svc-1',
  code: 'CUT60',
  name: 'Cut and finish',
  description: null,
  categoryId: 'cat-1',
  categoryName: 'Hair',
  status: 'ACTIVE',
  isOnlineBookable: true,
  durationMin: 60,
  bufferBeforeMin: 10,
  bufferAfterMin: 5,
  totalOccupiedMin: 75,
  priceMinor: '5000000',
  currencyCode: 'MNT',
  requiresDeposit: false,
  depositMinor: null,
  requiresEmployee: true,
  requiresResource: false,
  color: null,
  sortOrder: 0,
  branchCount: 2,
  employeeCount: 3,
  ...overrides,
});

/** Every request the screen makes, keyed loosely by path. */
function routeFetch(services: unknown[]) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/service-categories')) {
      return Promise.resolve(
        jsonResponse(
          envelope({
            items: [
              { id: 'cat-1', parentId: null, name: 'Hair', description: null, color: null, sortOrder: 0, status: 'ACTIVE', serviceCount: 1 },
            ],
          }),
        ),
      );
    }
    if (url.includes('/branches')) {
      return Promise.resolve(jsonResponse(envelope({ items: [{ id: 'br-1', name: 'Main', code: 'MAIN' }] })));
    }
    if (url.includes('/employees')) {
      return Promise.resolve(
        jsonResponse(envelope({ items: [{ id: 'emp-1', displayName: 'Sara' }], total: 1, limit: 100, offset: 0 })),
      );
    }
    return Promise.resolve(
      jsonResponse(envelope({ items: services, total: services.length, limit: 25, offset: 0 })),
    );
  });
}

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

describe('ServiceList', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = routeFetch([service()]);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a service with its price formatted from minor units', async () => {
    renderWithProviders(<ServiceList />, { session: session(['service:read']) });

    expect(await screen.findByText('Cut and finish')).toBeInTheDocument();
    // 5000000 minor units at two decimal places is 50,000 — not 5,000,000.
    expect(screen.getByText(/50,000\.00/)).toBeInTheDocument();
  });

  it('shows the occupied window, not just the duration sold', async () => {
    renderWithProviders(<ServiceList />, { session: session(['service:read']) });

    expect(await screen.findByText(/60 min/)).toBeInTheDocument();
    // 10 + 5: the part of the calendar a booking blocks that the customer is
    // not charged for.
    expect(screen.getByText(/\+15 buffer/)).toBeInTheDocument();
  });

  it('warns when a service is offered at no branch', async () => {
    fetchMock = routeFetch([service({ branchCount: 0 })]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<ServiceList />, { session: session(['service:read']) });

    expect(await screen.findByText('No branches')).toBeInTheDocument();
  });

  it('distinguishes an internal service from a listed one', async () => {
    fetchMock = routeFetch([service({ isOnlineBookable: false, status: 'ACTIVE' })]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<ServiceList />, { session: session(['service:read']) });

    // Still ACTIVE — bookable by reception, invisible to the public. Scoped to
    // the row: "Active" is also an option in the status filter.
    expect(await screen.findByText('Internal')).toBeInTheDocument();
    const row = screen.getByText('Cut and finish').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Active')).toBeInTheDocument();
  });

  it('sends the filters to the server rather than filtering in the browser', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceList />, { session: session(['service:read']) });

    await screen.findByText('Cut and finish');
    await user.selectOptions(screen.getByLabelText('Online booking'), 'false');

    await waitFor(() => {
      const asked = fetchMock.mock.calls
        .map(([input]) => String(input))
        .some((url) => url.includes('isOnlineBookable=false'));
      expect(asked).toBe(true);
    });
  });

  it('hides the add button without service:write', async () => {
    renderWithProviders(<ServiceList />, { session: session(['service:read']) });

    await screen.findByText('Cut and finish');
    // A convenience, not protection — the API refuses the call regardless
    // (`docs/ARCHITECTURE-RULES.md`, rule 3).
    expect(screen.queryByRole('button', { name: 'Add service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows it with service:write', async () => {
    renderWithProviders(<ServiceList />, {
      session: session(['service:read', 'service:write']),
    });

    expect(await screen.findByRole('button', { name: 'Add service' })).toBeInTheDocument();
  });
});
