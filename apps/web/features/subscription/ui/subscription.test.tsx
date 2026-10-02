import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { ReadOnlyBanner } from './read-only-banner';
import { SubscriptionPage } from './subscription-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/subscription',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, details } }, status);

const limits = (n: number | null) => ({
  MAX_BRANCHES: n === null ? null : 1,
  MAX_EMPLOYEES: n,
  MAX_SERVICES: n,
  MAX_RESOURCES: n,
  MAX_CUSTOMERS: n === null ? null : 1000,
  MAX_APPOINTMENTS_PER_MONTH: n === null ? null : 1000,
});
const plan = (key: string, name: string, priceMinor: string, o: Record<string, unknown> = {}) => ({
  key,
  name,
  description: `${name} plan`,
  priceMinor,
  currencyCode: 'MNT',
  interval: 'MONTH',
  trialDays: priceMinor === '0' ? 0 : 14,
  current: false,
  features: {
    GIFT_CARDS: key !== 'STARTER',
    PROMOTIONS: true,
    ONLINE_BOOKING: true,
    MULTI_BRANCH: false,
  },
  limits: limits(key === 'BUSINESS' ? null : 10),
  ...o,
});

const overview = (o: Record<string, unknown> = {}) => ({
  subscription: {
    id: 's1',
    status: 'ACTIVE',
    plan: {
      key: 'PRO',
      name: 'Pro',
      priceMinor: '9900000',
      currencyCode: 'MNT',
      interval: 'MONTH',
    },
    trial: null,
    currentPeriod: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    cancelAtPeriodEnd: false,
    canceledAt: null,
    graceEndsAt: null,
    expiredAt: null,
    readOnly: false,
  },
  trialAvailable: false,
  features: { GIFT_CARDS: true, PROMOTIONS: true, ONLINE_BOOKING: true, MULTI_BRANCH: false },
  usage: [
    { key: 'MAX_EMPLOYEES', label: 'Employees', used: 8, limit: 10 },
    { key: 'MAX_BRANCHES', label: 'Branches', used: 1, limit: 1 },
    { key: 'MAX_CUSTOMERS', label: 'Customers', used: 420, limit: 1000 },
    { key: 'MAX_APPOINTMENTS_PER_MONTH', label: 'Appointments per month', used: 650, limit: null },
  ],
  plans: [
    plan('FREE', 'Free', '0'),
    plan('STARTER', 'Starter', '4900000'),
    plan('PRO', 'Pro', '9900000', { current: true }),
    plan('BUSINESS', 'Business', '19900000'),
  ],
  openInvoice: {
    id: 'i1',
    number: 'INV-202610-0001',
    totalMinor: '9900000',
    currencyCode: 'MNT',
    dueAt: '2026-10-08T00:00:00.000Z',
  },
  ...o,
});

const invoices = {
  items: [
    {
      id: 'i1',
      number: 'INV-202610-0001',
      status: 'OPEN',
      plan: { id: 'p', name: 'Pro' },
      amountMinor: '9900000',
      taxMinor: '0',
      totalMinor: '9900000',
      amountPaidMinor: '0',
      currencyCode: 'MNT',
      period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
      issuedAt: '2026-10-01T00:00:00.000Z',
      dueAt: '2026-10-08T00:00:00.000Z',
      paidAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  total: 1,
  limit: 10,
  offset: 0,
};

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });
const OWNER = ['settings:billing:read', 'settings:billing:write'];

type Handler = (url: URL, init?: RequestInit) => Response | undefined;
function api(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const handled = handler(url, init);
    if (handled) return Promise.resolve(handled);
    if (url.pathname.endsWith('/billing')) return Promise.resolve(json(envelope(invoices)));
    return Promise.resolve(apiError(404, 'RESOURCE_NOT_FOUND', 'Not found'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('SubscriptionPage', () => {
  it('shows the current plan, billing period, usage against limits and the open invoice', async () => {
    api((url) => (url.pathname.endsWith('/subscription') ? json(envelope(overview())) : undefined));
    renderWithProviders(<SubscriptionPage />, { session: session(OWNER) });

    expect(await screen.findByText('Active')).toBeInTheDocument();
    const usage = screen.getByRole('list', { name: 'Usage' });
    expect(within(usage).getByText('8 / 10')).toBeInTheDocument();
    expect(within(usage).getByText('1 / 1')).toHaveClass('text-destructive');
    expect(within(usage).getByText('420 / 1,000')).toBeInTheDocument();
    expect(within(usage).getByText('650 / Unlimited')).toBeInTheDocument();
    expect(screen.getByText(/Invoice due/).nextElementSibling).toHaveTextContent('by');
    expect(await screen.findByRole('rowheader', { name: 'INV-202610-0001' })).toBeInTheDocument();
  });

  it('compares plans and offers upgrade, downgrade and the current plan', async () => {
    api((url) => (url.pathname.endsWith('/subscription') ? json(envelope(overview())) : undefined));
    renderWithProviders(<SubscriptionPage />, { session: session(OWNER) });

    const pro = await screen
      .findByRole('region', { name: 'Pro plan' })
      .catch(() => screen.getByLabelText('Pro plan'));
    expect(within(pro).getByRole('button', { name: 'Current plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upgrade to Business' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Downgrade to Starter' })).toBeInTheDocument();
    const starter = screen.getByLabelText('Starter plan');
    expect(
      within(within(starter).getByText('Gift cards')).getByLabelText('Not included'),
    ).toBeInTheDocument();
  });

  it('changes plan after confirmation, and explains a refused downgrade', async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    api((url, init) => {
      if (init?.method === 'POST') {
        posted.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        if (url.pathname.endsWith('/change-plan') && posted.length === 1) {
          return apiError(
            403,
            'PLAN_LIMIT_EXCEEDED',
            'Current usage is above what that plan allows.',
            {
              violations: [{ limit: 'MAX_EMPLOYEES', max: 5, current: 8 }],
            },
          );
        }
        return json(
          envelope(
            overview({
              subscription: {
                ...overview().subscription,
                plan: { ...overview().subscription.plan, key: 'BUSINESS', name: 'Business' },
              },
            }),
          ),
        );
      }
      return url.pathname.endsWith('/subscription') ? json(envelope(overview())) : undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<SubscriptionPage />, { session: session(OWNER) });

    await user.click(await screen.findByRole('button', { name: 'Downgrade to Starter' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('An invoice is issued now');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Employees: 8 in use, plan allows 5/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Upgrade to Business' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({
      path: '/api/v1/companies/co-1/subscription/change-plan',
      body: { planKey: 'BUSINESS' },
    });
  });

  it('starts a trial when there is no subscription', async () => {
    let sent: unknown = null;
    api((url, init) => {
      if (init?.method === 'POST') {
        sent = { path: url.pathname, body: JSON.parse(String(init.body)) };
        return json(envelope(overview()));
      }
      return url.pathname.endsWith('/subscription')
        ? json(
            envelope(
              overview({
                subscription: null,
                trialAvailable: true,
                openInvoice: null,
                plans: overview().plans.map((p) => ({ ...p, current: false })),
              }),
            ),
          )
        : undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<SubscriptionPage />, { session: session(OWNER) });

    expect(await screen.findByText('No plan yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Start 14-day trial' })[1]!);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('No invoice until you subscribe');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(sent).toEqual({
        path: '/api/v1/companies/co-1/subscription/start-trial',
        body: { planKey: 'PRO' },
      }),
    );
  });

  it('cancels with a reason, and offers to keep a cancelled subscription', async () => {
    let cancelled: unknown = null;
    api((url, init) => {
      if (url.pathname.endsWith('/cancel')) {
        cancelled = JSON.parse(String(init?.body));
        return json(
          envelope(
            overview({
              subscription: {
                ...overview().subscription,
                status: 'CANCELLED',
                cancelAtPeriodEnd: true,
              },
            }),
          ),
        );
      }
      return url.pathname.endsWith('/subscription') ? json(envelope(overview())) : undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<SubscriptionPage />, { session: session(OWNER) });

    await user.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Closing down');
    const region = screen.getByRole('region', { name: 'Cancel subscription' });
    await user.click(within(region).getByRole('button', { name: 'Cancel subscription' }));

    expect(await screen.findByRole('button', { name: 'Keep my subscription' })).toBeInTheDocument();
    expect(cancelled).toEqual({ reason: 'Closing down' });
    expect(screen.getByText(/after that the company becomes read-only/)).toBeInTheDocument();
  });

  it('explains an expired subscription and offers renewal', async () => {
    api((url) =>
      url.pathname.endsWith('/subscription')
        ? json(
            envelope(
              overview({
                subscription: { ...overview().subscription, status: 'EXPIRED', readOnly: true },
              }),
            ),
          )
        : undefined,
    );
    renderWithProviders(<SubscriptionPage />, { session: session(OWNER) });
    expect(await screen.findByText('The subscription has expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeInTheDocument();
  });

  it('is read-only without billing:write, and refused without billing:read', async () => {
    api((url) => (url.pathname.endsWith('/subscription') ? json(envelope(overview())) : undefined));
    const { unmount } = renderWithProviders(<SubscriptionPage />, {
      session: session(['settings:billing:read']),
    });
    await screen.findByText('Active');
    expect(
      screen.queryByRole('button', { name: /Upgrade|Downgrade|Cancel subscription/ }),
    ).toBeNull();
    expect(screen.getByText('Only the account owner can change the plan.')).toBeInTheDocument();
    unmount();

    const fetchMock = api(() => undefined);
    renderWithProviders(<SubscriptionPage />, { session: session([]) });
    expect(
      screen.getByText('You do not have permission to see the subscription.'),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([i]) => String(i).includes('/subscription'))).toBe(false);
  });
});

describe('ReadOnlyBanner', () => {
  const context = (operationalStatus: string) =>
    json(
      envelope({
        company: {
          id: 'co-1',
          slug: 'a',
          status: 'ACTIVE',
          operationalStatus,
          defaultTimezoneName: 'UTC',
          currencyCode: 'MNT',
        },
        membership: null,
        permissions: [],
        viaPlatformAccess: false,
      }),
    );

  it('appears only while the company is read-only', async () => {
    api((url) => (url.pathname.endsWith('/me/context') ? context('READ_ONLY') : undefined));
    const { unmount } = renderWithProviders(<ReadOnlyBanner />, {
      session: session(['settings:billing:read']),
    });
    expect(await screen.findByText(/subscription has expired/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage subscription' })).toHaveAttribute(
      'href',
      '/subscription',
    );
    unmount();

    api((url) => (url.pathname.endsWith('/me/context') ? context('ACTIVE') : undefined));
    const { container } = renderWithProviders(<ReadOnlyBanner />, { session: session([]) });
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
