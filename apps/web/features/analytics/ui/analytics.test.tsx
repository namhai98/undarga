import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { DashboardSummary } from './dashboard-summary';
import { ReportsView } from './reports-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/reports',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string) => json({ error: { code, message: code } }, status);

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

const header = (amountsVisible = true) => ({
  range: { from: '2025-03-03', to: '2025-03-05', timezone: 'Asia/Ulaanbaatar' },
  filters: { branchIds: null, employeeId: null, serviceId: null, statuses: [] },
  amountsVisible,
});

const row = (id: string, name: string, bookings: number) => ({
  id,
  name,
  bookings,
  completed: 1,
  cancelled: 0,
  noShow: 0,
  bookedValueMinor: '4000000',
});

const appointments = {
  ...header(),
  totals: {
    total: 5,
    pending: 0,
    confirmed: 1,
    checkedIn: 0,
    inProgress: 0,
    completed: 2,
    cancelled: 1,
    noShow: 1,
    completionRateBps: 4000,
    cancellationRateBps: 2000,
    noShowRateBps: 2000,
    bookedValueMinor: '21000000',
  },
  byDay: [
    { date: '2025-03-03', total: 1, completed: 1, cancelled: 0, noShow: 0, other: 0 },
    { date: '2025-03-04', total: 2, completed: 0, cancelled: 1, noShow: 1, other: 0 },
    { date: '2025-03-05', total: 2, completed: 1, cancelled: 0, noShow: 0, other: 1 },
  ],
  byService: {
    items: [row('s1', 'Haircut', 3), row('s2', 'Massage', 2)],
    total: 2,
    limit: 10,
    offset: 0,
  },
  byEmployee: { items: [row('e1', 'Bat', 3)], total: 2, limit: 10, offset: 0 },
  byBranch: { items: [row('b1', 'Main', 3)], total: 1, limit: 10, offset: 0 },
};

const dashboard = (overrides: Record<string, unknown> = {}) => ({
  date: '2025-03-05',
  timezone: 'Asia/Ulaanbaatar',
  branchId: null,
  windowDays: 30,
  restricted: [],
  amountsVisible: true,
  appointments: {
    today: 4,
    byStatus: { CONFIRMED: 3, COMPLETED: 1 },
    completed: 1,
    cancelled: 0,
    noShow: 2,
    upcoming: 9,
    upcomingDays: 7,
  },
  customers: { newToday: 1, newInWindow: 12 },
  popularServices: [
    { serviceId: 's1', name: 'Haircut', bookings: 3, bookedValueMinor: '12000000' },
  ],
  promotions: {
    redemptions: 2,
    discountMinor: '1300000',
    topPromotion: { promotionId: 'p1', name: 'Spring 10%', redemptions: 2 },
  },
  giftCards: {
    activeCards: 5,
    issuedInWindow: 2,
    redemptions: 3,
    redeemedMinor: '3000000',
    outstandingLiabilityMinor: '7500000',
  },
  revenue: { collectedMinor: '9000000', refundedMinor: '0', netMinor: '9000000', paymentCount: 2 },
  outstanding: { amountMinor: '4000000', appointmentCount: 1 },
  ...overrides,
});

type Handler = (url: URL) => Response | undefined;

function api(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const handled = handler(url);
    if (handled) return Promise.resolve(handled);
    const path = url.pathname;
    if (path.endsWith('/branches')) {
      return Promise.resolve(
        json(
          envelope({
            items: [
              { id: 'b1', name: 'Main' },
              { id: 'b2', name: 'North' },
            ],
            total: 2,
          }),
        ),
      );
    }
    if (path.endsWith('/employees'))
      return Promise.resolve(
        json(
          envelope({ items: [{ id: 'e1', displayName: 'Bat' }], total: 1, limit: 100, offset: 0 }),
        ),
      );
    if (path.endsWith('/services'))
      return Promise.resolve(
        json(envelope({ items: [{ id: 's1', name: 'Haircut' }], total: 1, limit: 100, offset: 0 })),
      );
    if (path.endsWith('/companies/co-1'))
      return Promise.resolve(json(envelope({ id: 'co-1', currencyCode: 'MNT' })));
    return Promise.resolve(apiError(404, 'RESOURCE_NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urls = (mock: ReturnType<typeof api>) =>
  mock.mock.calls.map(([i]) => new URL(String(i), 'http://localhost'));

afterEach(() => vi.unstubAllGlobals());

// =============================================================================
describe('Dashboard', () => {
  it('shows today’s appointments, upcoming, outcomes, new customers and activity', async () => {
    api((url) => (url.pathname.endsWith('/dashboard') ? json(envelope(dashboard())) : undefined));
    renderWithProviders(<DashboardSummary />, {
      session: session(['report:read', 'report:revenue:read', 'branch:read']),
    });

    const stat = async (label: string) =>
      (await screen.findByText(label, { selector: 'p' })).parentElement!;
    expect(await stat('Appointments today')).toHaveTextContent('4');
    expect(await stat('Upcoming')).toHaveTextContent('9next 7 days');
    expect(await stat('No-show')).toHaveTextContent('2');
    expect(await stat('New customers')).toHaveTextContent('12 in 30 days');

    expect(screen.getByRole('list', { name: 'Popular services' })).toHaveTextContent('Haircut');
    expect(screen.getByText('Spring 10% (2)')).toBeInTheDocument();
    expect(screen.getByText('Taken today')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('says which figures it withholds instead of showing zeros', async () => {
    api((url) =>
      url.pathname.endsWith('/dashboard')
        ? json(
            envelope(
              dashboard({
                restricted: ['revenue', 'amounts'],
                amountsVisible: false,
                revenue: null,
                outstanding: null,
                promotions: { redemptions: 2, discountMinor: null, topPromotion: null },
              }),
            ),
          )
        : undefined,
    );
    renderWithProviders(<DashboardSummary />, { session: session(['report:read']) });

    expect(await screen.findByRole('note')).toHaveTextContent(
      'need the revenue reporting permission',
    );
    expect(screen.queryByText('Taken today')).toBeNull();
    const discount = screen.getByText('Discount given').parentElement!;
    expect(discount).toHaveTextContent('—');
  });

  it('sends a branch filter', async () => {
    const fetchMock = api((url) =>
      url.pathname.endsWith('/dashboard') ? json(envelope(dashboard())) : undefined,
    );
    const user = userEvent.setup();
    renderWithProviders(<DashboardSummary />, { session: session(['report:read', 'branch:read']) });
    await user.selectOptions(await screen.findByLabelText('Branch'), 'b2');
    await waitFor(() =>
      expect(
        urls(fetchMock).some(
          (u) => u.pathname.endsWith('/dashboard') && u.searchParams.get('branchId') === 'b2',
        ),
      ).toBe(true),
    );
  });

  it('asks for nothing without report:read', () => {
    const fetchMock = api(() => undefined);
    renderWithProviders(<DashboardSummary />, { session: session([]) });
    expect(screen.getByText('The dashboard needs the reporting permission.')).toBeInTheDocument();
    expect(urls(fetchMock).some((u) => u.pathname.endsWith('/dashboard'))).toBe(false);
  });
});

// =============================================================================
describe('Reports', () => {
  it('shows totals, a chart and breakdown tables for appointments', async () => {
    api((url) =>
      url.pathname.endsWith('/reports/appointments') ? json(envelope(appointments)) : undefined,
    );
    renderWithProviders(<ReportsView />, {
      session: session(['report:read', 'report:revenue:read']),
    });

    expect(await screen.findByText('2 · 40%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Appointments by day/ })).toBeInTheDocument();
    const byService = screen.getByText('By service').closest('[data-slot="card"]') ?? document.body;
    expect(
      within(byService as HTMLElement).getByRole('rowheader', { name: 'Haircut' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Showing 1 of 2.')).toHaveLength(1);
  });

  it('sends every filter to the server', async () => {
    const fetchMock = api((url) =>
      url.pathname.includes('/reports/') ? json(envelope(appointments)) : undefined,
    );
    const user = userEvent.setup();
    renderWithProviders(<ReportsView />, { session: session(['report:read']) });
    await screen.findByText('2 · 40%');

    await user.selectOptions(screen.getByLabelText('Branch'), 'b2');
    await user.selectOptions(screen.getByLabelText('Employee'), 'e1');
    await user.selectOptions(screen.getByLabelText('Service'), 's1');
    await user.selectOptions(screen.getByLabelText('Status'), 'CANCELLED,NO_SHOW');
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));

    await waitFor(() => {
      const last = urls(fetchMock)
        .filter((u) => u.pathname.endsWith('/reports/appointments'))
        .at(-1)!;
      expect(Object.fromEntries(last.searchParams)).toMatchObject({
        branchId: 'b2',
        employeeId: 'e1',
        serviceId: 's1',
        status: 'CANCELLED,NO_SHOW',
      });
      expect(last.searchParams.get('from')! <= last.searchParams.get('to')!).toBe(true);
    });
  });

  it('shows an empty state, and an error state that explains a refused filter', async () => {
    let fail = false;
    api((url) => {
      if (!url.pathname.endsWith('/reports/appointments')) return undefined;
      if (fail) return apiError(404, 'BRANCH_OUT_OF_SCOPE');
      return json(envelope({ ...appointments, totals: { ...appointments.totals, total: 0 } }));
    });
    const user = userEvent.setup();
    renderWithProviders(<ReportsView />, { session: session(['report:read']) });
    expect(await screen.findByText('No appointments in this range')).toBeInTheDocument();

    fail = true;
    await user.selectOptions(screen.getByLabelText('Branch'), 'b2');
    expect(
      await screen.findByText('One of the filters is not available to you.'),
    ).toBeInTheDocument();
  });

  it('refuses a backwards range before asking', async () => {
    const fetchMock = api((url) =>
      url.pathname.includes('/reports/') ? json(envelope(appointments)) : undefined,
    );
    const user = userEvent.setup();
    renderWithProviders(<ReportsView />, { session: session(['report:read']) });
    await screen.findByText('2 · 40%');
    const before = urls(fetchMock).filter((u) => u.pathname.includes('/reports/')).length;

    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2999-01-01');
    expect(await screen.findByText('The range must start before it ends.')).toBeInTheDocument();
    expect(urls(fetchMock).filter((u) => u.pathname.includes('/reports/')).length).toBe(before);
  });

  it('pages the services table and draws the trend', async () => {
    const fetchMock = api((url) =>
      url.pathname.endsWith('/reports/services')
        ? json(
            envelope({
              ...header(false),
              totals: { bookings: 40, services: 30 },
              items: {
                items: [{ ...row('s1', 'Haircut', 10), bookedValueMinor: null, shareBps: 2500 }],
                total: 30,
                limit: 25,
                offset: Number(url.searchParams.get('offset') ?? 0),
              },
              trend: {
                services: [{ serviceId: 's1', name: 'Haircut' }],
                days: [{ date: '2025-03-03', counts: { s1: 4 } }],
              },
            }),
          )
        : undefined,
    );
    const user = userEvent.setup();
    renderWithProviders(<ReportsView />, { session: session(['report:read']) });
    await user.click(await screen.findByRole('tab', { name: 'Services' }));

    expect(await screen.findByRole('img', { name: /Booking trends/ })).toBeInTheDocument();
    // Money hidden without the revenue permission: a dash, not a zero.
    const haircut = screen.getByRole('rowheader', { name: 'Haircut' }).closest('tr')!;
    expect(haircut).toHaveTextContent('25%');
    expect(haircut).toHaveTextContent('—');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(
        urls(fetchMock).some(
          (u) => u.pathname.endsWith('/reports/services') && u.searchParams.get('offset') === '25',
        ),
      ).toBe(true),
    );
  });

  it('shows the revenue tab only with the revenue permission', async () => {
    api((url) => (url.pathname.includes('/reports/') ? json(envelope(appointments)) : undefined));
    const { unmount } = renderWithProviders(<ReportsView />, { session: session(['report:read']) });
    await screen.findByText('2 · 40%');
    expect(screen.queryByRole('tab', { name: 'Revenue' })).toBeNull();
    unmount();

    renderWithProviders(<ReportsView />, {
      session: session(['report:read', 'report:revenue:read']),
    });
    expect(await screen.findByRole('tab', { name: 'Revenue' })).toBeInTheDocument();
  });

  it('explains gift card inventory is hidden for a branch-limited account', async () => {
    api((url) =>
      url.pathname.endsWith('/reports/gift-cards')
        ? json(
            envelope({
              ...header(false),
              appliedFilters: {
                dateRange: true,
                branch: true,
                employee: false,
                service: false,
                status: false,
              },
              inventoryVisible: false,
              issued: null,
              cards: null,
              redemptions: {
                totals: { redemptions: 1, redeemedMinor: null, refunds: 0, refundedMinor: null },
                byDay: [
                  {
                    date: '2025-03-03',
                    redemptions: 1,
                    redeemedMinor: null,
                    refunds: 0,
                    refundedMinor: null,
                  },
                ],
              },
            }),
          )
        : undefined,
    );
    const user = userEvent.setup();
    renderWithProviders(<ReportsView />, { session: session(['report:read']) });
    await user.click(await screen.findByRole('tab', { name: 'Gift cards' }));
    expect(await screen.findByText(/not shown to branch-limited accounts/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Redemption activity/ })).toBeInTheDocument();
  });

  it('refuses the page without report:read', () => {
    api(() => undefined);
    renderWithProviders(<ReportsView />, { session: session([]) });
    expect(screen.getByText('You do not have permission to see reports.')).toBeInTheDocument();
  });
});
