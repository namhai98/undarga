import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { CustomerList } from './customer-list';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/customers',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const customer = (overrides: Record<string, unknown> = {}) => ({
  id: 'cus-1',
  firstName: 'Sara',
  lastName: 'Ochir',
  fullName: 'Sara Ochir',
  email: 'sara@example.com',
  phone: '+97699112233',
  address: null,
  notes: null,
  birthDate: null,
  gender: null,
  locale: null,
  status: 'ACTIVE',
  tags: ['vip'],
  preferredEmployeeId: null,
  preferredEmployeeName: null,
  loyaltyPoints: 0,
  totalVisits: 4,
  totalNoShows: 0,
  totalSpentMinor: '12000000',
  firstVisitAt: null,
  lastVisitAt: '2026-08-01T02:00:00.000Z',
  appointmentCount: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function routeFetch(customers: unknown[]) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/employees')) {
      return Promise.resolve(
        jsonResponse(envelope({ items: [], total: 0, limit: 100, offset: 0 })),
      );
    }
    return Promise.resolve(
      jsonResponse(envelope({ items: customers, total: customers.length, limit: 25, offset: 0 })),
    );
  });
}

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

describe('CustomerList', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = routeFetch([customer()]);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a customer with contact details and visit count', async () => {
    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    expect(await screen.findByText('Sara Ochir')).toBeInTheDocument();
    expect(screen.getByText('+97699112233')).toBeInTheDocument();
    expect(screen.getByText('sara@example.com')).toBeInTheDocument();
  });

  it('flags no-shows, because it changes whether reception asks for a deposit', async () => {
    fetchMock = routeFetch([customer({ totalNoShows: 2 })]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    expect(await screen.findByText(/2 no-shows/)).toBeInTheDocument();
  });

  it('says "Never" rather than showing an empty cell for someone who has not been in', async () => {
    fetchMock = routeFetch([customer({ lastVisitAt: null })]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    const row = (await screen.findByText('Sara Ochir')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Never')).toBeInTheDocument();
  });

  it('sends the search term to the server rather than filtering in the browser', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    await screen.findByText('Sara Ochir');
    await user.type(screen.getByLabelText('Search'), '9911');

    await waitFor(() => {
      const asked = fetchMock.mock.calls
        .map(([input]) => String(input))
        .some((url) => url.includes('search=9911'));
      expect(asked).toBe(true);
    });
  });

  it('shows an empty state that distinguishes "no customers" from "no matches"', async () => {
    fetchMock = routeFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    expect(await screen.findByText('No customers yet')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search'), 'nobody');
    expect(await screen.findByText('Nobody matches those filters')).toBeInTheDocument();
  });

  it('shows an error state when the list fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } }, 500),
        ),
      ),
    );

    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    expect(await screen.findByText('Could not load customers')).toBeInTheDocument();
  });

  it('hides the add button without customer:write', async () => {
    renderWithProviders(<CustomerList />, { session: session(['customer:read']) });

    await screen.findByText('Sara Ochir');
    // A convenience, not protection — the API refuses the call regardless
    // (`docs/ARCHITECTURE-RULES.md`, rule 3).
    expect(screen.queryByRole('button', { name: 'Add customer' })).not.toBeInTheDocument();
  });

  it('shows it with customer:write', async () => {
    renderWithProviders(<CustomerList />, {
      session: session(['customer:read', 'customer:write']),
    });

    expect(await screen.findByRole('button', { name: 'Add customer' })).toBeInTheDocument();
  });
});
