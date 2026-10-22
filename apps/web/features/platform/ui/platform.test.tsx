import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformTokenStore } from '@/services/platform-api-client';
import { tokenStore } from '@/services/token-store';
import { renderWithProviders } from '@/test/render';
import { PlatformCompanyDetail } from './platform-company-detail';
import { PlatformCompanyList } from './platform-company-list';
import { PlatformCompanyUsers } from './platform-company-users';
import { PlatformDashboard } from './platform-dashboard';
import { PlatformShell } from './platform-shell';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/platform',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string) => json({ error: { code, message: code } }, status);

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

const dashboard = {
  windowDays: 30,
  companies: { total: 12, active: 8, suspended: 2, disabled: 1, pendingSetup: 1, newInWindow: 3, byStatus: {} },
  subscriptions: {
    total: 11,
    trial: 4,
    active: 6,
    pastDue: 1,
    grace: 0,
    suspended: 0,
    cancelled: 0,
    expired: 0,
    trialsEndingWithin7Days: 2,
    byStatus: {},
    topPlans: [{ planKey: 'PRO', planName: 'Pro', companies: 5 }],
  },
  users: { total: 57, activeMemberships: 60 },
  appointments: { total: 1234, inWindow: 321 },
};

const summary = {
  id: COMPANY_ID,
  slug: 'acme',
  displayName: 'Acme Salon',
  legalName: 'Acme LLC',
  status: 'ACTIVE',
  contactEmail: 'owner@acme.test',
  currencyCode: 'MNT',
  createdAt: '2026-01-01T00:00:00.000Z',
  suspendedAt: null,
  subscriptionStatus: 'TRIAL',
  planKey: 'PRO',
  planName: 'Pro',
  trialEndsAt: '2026-10-20T00:00:00.000Z',
  currentPeriodEnd: '2026-10-20T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  userCount: 3,
  branchCount: 2,
  employeeCount: 5,
};

const detail = (status = 'ACTIVE') => ({
  ...summary,
  status,
  contactPhone: null,
  defaultTimezoneName: 'Asia/Ulaanbaatar',
  locale: 'mn',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  counts: { branches: 2, employees: 5, services: 9, customers: 140, appointments: 610, activeUsers: 3, roles: 6 },
  subscription: null,
  recentActivity: [
    {
      id: 'a-1',
      action: 'employee.created',
      resourceType: 'employee',
      actorType: 'COMPANY_USER',
      actorLabel: 'owner@acme.test',
      occurredAt: '2026-10-01T10:00:00.000Z',
    },
  ],
});

const subscriptionView = {
  companyId: COMPANY_ID,
  subscription: {
    id: 's-1',
    status: 'TRIAL',
    planKey: 'PRO',
    planName: 'Pro',
    quantity: 1,
    trialEndsAt: '2026-10-20T00:00:00.000Z',
    currentPeriodStart: '2026-10-06T00:00:00.000Z',
    currentPeriodEnd: '2026-10-20T00:00:00.000Z',
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    cancelReason: null,
    expiredAt: null,
    provider: null,
    startedAt: '2026-10-06T00:00:00.000Z',
  },
  periodKey: '2026-10',
  usage: [
    { metric: 'APPOINTMENTS', used: 2100, limit: 2000, percentUsed: 105, overLimit: true, updatedAt: '2026-10-07T00:00:00.000Z' },
  ],
  entitlements: [],
  history: [],
};

const user = (n: number, extra: Record<string, unknown> = {}) => ({
  membershipId: `m-${n}`,
  userAccountId: `u-${n}`,
  email: `person${n}@acme.test`,
  fullName: `Person ${n}`,
  accountStatus: 'ACTIVE',
  emailVerified: true,
  lastLoginAt: null,
  membershipStatus: 'ACTIVE',
  isOwner: n === 1,
  roles: ['OWNER'],
  joinedAt: '2026-01-01T00:00:00.000Z',
  invitedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const paged = (items: unknown[], total = items.length, limit = 25, offset = 0) =>
  envelope({ items, total, limit, offset });

let fetchMock: ReturnType<typeof vi.fn>;

/** Route a request by method + path; anything unexpected is a test failure. */
function route(handlers: Record<string, (url: URL, init: RequestInit) => Response>) {
  fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) return Promise.resolve(apiError(500, `UNEXPECTED ${key}`));
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const calls = (pathname: string) =>
  fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(input as string), init: (init ?? {}) as RequestInit }))
    .filter((call) => call.url.pathname === pathname);

beforeEach(() => {
  tokenStore.clear('signed-out');
  platformTokenStore.set({ accessToken: 'platform-token', expiresIn: 900 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  platformTokenStore.clear();
  tokenStore.clear('signed-out');
});

describe('PlatformShell', () => {
  it('shows the operator sign-in, not the console, without a platform session', () => {
    platformTokenStore.clear();
    route({});

    renderWithProviders(
      <PlatformShell>
        <p>console content</p>
      </PlatformShell>,
    );

    expect(screen.getByRole('heading', { name: 'Platform console' })).toBeInTheDocument();
    expect(screen.queryByText('console content')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is not unlocked by a staff session', () => {
    platformTokenStore.clear();
    // A company admin signed in to the staff app in the same tab.
    tokenStore.set({ accessToken: 'staff-token', expiresIn: 900 }, 'signed-in');
    route({});

    renderWithProviders(
      <PlatformShell>
        <p>console content</p>
      </PlatformShell>,
    );

    expect(screen.queryByText('console content')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('gives one message for every rejected sign-in', async () => {
    platformTokenStore.clear();
    route({ 'POST /api/v1/platform/auth/login': () => apiError(401, 'INVALID_CREDENTIALS') });

    renderWithProviders(
      <PlatformShell>
        <p>console content</p>
      </PlatformShell>,
    );

    await userEvent.type(screen.getByLabelText('Email'), 'admin@acme.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Those credentials were not accepted.')).toBeInTheDocument();
    expect(screen.queryByText('console content')).not.toBeInTheDocument();
  });

  it('does not blame the credentials when the API is unreachable', async () => {
    platformTokenStore.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    renderWithProviders(
      <PlatformShell>
        <p>console content</p>
      </PlatformShell>,
    );

    await userEvent.type(screen.getByLabelText('Email'), 'admin@acme.test');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('The server is not responding. Try again shortly.'),
    ).toBeInTheDocument();
  });

  it('sends the platform token, never the staff one', async () => {
    tokenStore.set({ accessToken: 'staff-token', expiresIn: 900 }, 'signed-in');
    route({ 'GET /api/v1/platform/dashboard': () => json(envelope(dashboard)) });

    renderWithProviders(
      <PlatformShell>
        <PlatformDashboard />
      </PlatformShell>,
    );

    await screen.findByRole('heading', { name: 'Platform' });
    const [call] = calls('/api/v1/platform/dashboard');
    const headers = new Headers(call!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer platform-token');
    expect(headers.get('x-company-id')).toBeNull();
  });
});

describe('PlatformDashboard', () => {
  it('shows every figure the brief asks for', async () => {
    route({ 'GET /api/v1/platform/dashboard': () => json(envelope(dashboard)) });

    renderWithProviders(<PlatformDashboard />);

    expect(screen.getByText('Loading platform statistics…')).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Platform' });

    for (const [label, value] of [
      ['Companies', '12'],
      ['Active', '8'],
      ['Suspended', '2'],
      ['Disabled', '1'],
      ['Users', '57'],
      ['Appointments', '1,234'],
      ['Trials', '4'],
      ['Active subscriptions', '6'],
    ] as const) {
      const tile = screen.getAllByText(label, { exact: true })[0]!.parentElement!;
      expect(within(tile).getByText(value)).toBeInTheDocument();
    }
  });

  it('shows an error state when the API fails', async () => {
    route({ 'GET /api/v1/platform/dashboard': () => apiError(500, 'INTERNAL') });

    renderWithProviders(<PlatformDashboard />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the platform statistics',
    );
  });
});

describe('PlatformCompanyList', () => {
  it('lists companies and links to their detail', async () => {
    route({ 'GET /api/v1/platform/companies': () => json(paged([summary], 1)) });

    renderWithProviders(<PlatformCompanyList />);

    const link = await screen.findByRole('link', { name: 'Acme Salon' });
    expect(link).toHaveAttribute('href', `/platform/companies/${COMPANY_ID}`);
    expect(screen.getByText('1 on the platform')).toBeInTheDocument();
  });

  it('sends search and status filters, and says when nothing matches', async () => {
    route({
      'GET /api/v1/platform/companies': (url) =>
        json(url.searchParams.has('status') ? paged([], 0) : paged([summary], 1)),
    });

    renderWithProviders(<PlatformCompanyList />);
    await screen.findByRole('link', { name: 'Acme Salon' });

    await userEvent.type(screen.getByLabelText('Search'), 'acme');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'CANCELED');

    expect(await screen.findByText('Nothing matches those filters')).toBeInTheDocument();
    const last = calls('/api/v1/platform/companies').at(-1)!.url.searchParams;
    expect(last.get('status')).toBe('CANCELED');
    expect(last.get('search')).toBe('acme');
    expect(last.get('offset')).toBe('0');
  });

  it('labels CANCELED as Disabled in the filter', async () => {
    route({ 'GET /api/v1/platform/companies': () => json(paged([], 0)) });

    renderWithProviders(<PlatformCompanyList />);

    expect(await screen.findByText('No companies yet')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Disabled' })).toHaveValue('CANCELED');
  });

  it('pages through a long list', async () => {
    route({
      'GET /api/v1/platform/companies': (url) =>
        json(paged([summary], 60, 25, Number(url.searchParams.get('offset') ?? 0))),
    });

    renderWithProviders(<PlatformCompanyList />);

    expect(await screen.findByText('1–25 of 60')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('26–50 of 60')).toBeInTheDocument();
    expect(calls('/api/v1/platform/companies').at(-1)!.url.searchParams.get('offset')).toBe('25');
  });
});

describe('PlatformCompanyDetail', () => {
  const detailRoutes = (status = 'ACTIVE') => ({
    [`GET /api/v1/platform/companies/${COMPANY_ID}`]: () => json(envelope(detail(status))),
    [`GET /api/v1/platform/companies/${COMPANY_ID}/users`]: () => json(paged([user(1)], 12, 5)),
    [`GET /api/v1/platform/companies/${COMPANY_ID}/subscription`]: () =>
      json(envelope(subscriptionView)),
  });

  it('shows counts, subscription, usage, status and recent activity', async () => {
    route(detailRoutes());

    renderWithProviders(<PlatformCompanyDetail companyId={COMPANY_ID} />);

    expect(await screen.findByRole('heading', { name: 'Acme Salon' })).toBeInTheDocument();
    expect(screen.getByText('Active', { selector: '[data-slot="badge"], span' })).toBeInTheDocument();

    for (const [label, value] of [
      ['Branches', '2'],
      ['Employees', '5'],
      ['Customers', '140'],
      ['Appointments', '610'],
    ] as const) {
      const tile = screen.getByText(label, { exact: true }).parentElement!;
      expect(within(tile).getByText(value)).toBeInTheDocument();
    }

    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('2100 / 2000')).toBeInTheDocument();
    expect(screen.getByText('employee created')).toBeInTheDocument();
    expect(await screen.findByText('person1@acme.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All 12 users' })).toHaveAttribute(
      'href',
      `/platform/companies/${COMPANY_ID}/users`,
    );
  });

  it('asks for a reason and a confirmation before suspending', async () => {
    route({
      ...detailRoutes(),
      [`PATCH /api/v1/platform/companies/${COMPANY_ID}/status`]: () =>
        json(envelope(detail('SUSPENDED'))),
    });

    renderWithProviders(<PlatformCompanyDetail companyId={COMPANY_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Set suspended' }));

    expect(screen.getByText('Set Acme Salon to suspended?')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'no');
    expect(confirm).toBeDisabled();
    expect(calls(`/api/v1/platform/companies/${COMPANY_ID}/status`)).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Reason'), 'n-payment after reminders');
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(calls(`/api/v1/platform/companies/${COMPANY_ID}/status`)).toHaveLength(1),
    );
    const [call] = calls(`/api/v1/platform/companies/${COMPANY_ID}/status`);
    expect(JSON.parse(call!.init.body as string)).toEqual({
      status: 'SUSPENDED',
      reason: 'non-payment after reminders',
    });
  });

  it('cancelling the confirmation changes nothing', async () => {
    route(detailRoutes());

    renderWithProviders(<PlatformCompanyDetail companyId={COMPANY_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Set disabled' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
    expect(calls(`/api/v1/platform/companies/${COMPANY_ID}/status`)).toHaveLength(0);
  });

  it('offers only reactivation for a disabled company', async () => {
    route(detailRoutes('CANCELED'));

    renderWithProviders(<PlatformCompanyDetail companyId={COMPANY_ID} />);

    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set suspended' })).not.toBeInTheDocument();
  });

  it('shows the API error when a status change is refused', async () => {
    route({
      ...detailRoutes(),
      [`PATCH /api/v1/platform/companies/${COMPANY_ID}/status`]: () =>
        json({ error: { code: 'CONFLICT', message: 'That company is already SUSPENDED.' } }, 409),
    });

    renderWithProviders(<PlatformCompanyDetail companyId={COMPANY_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Set suspended' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'Non-payment');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('That company is already SUSPENDED.')).toBeInTheDocument();
  });

  it('shows an error state for a company that cannot be loaded', async () => {
    route({
      [`GET /api/v1/platform/companies/${COMPANY_ID}`]: () => apiError(404, 'RESOURCE_NOT_FOUND'),
      [`GET /api/v1/platform/companies/${COMPANY_ID}/users`]: () =>
        apiError(404, 'RESOURCE_NOT_FOUND'),
      [`GET /api/v1/platform/companies/${COMPANY_ID}/subscription`]: () =>
        apiError(404, 'RESOURCE_NOT_FOUND'),
    });

    renderWithProviders(<PlatformCompanyDetail companyId={COMPANY_ID} />);

    expect(await screen.findByText('Could not load this company')).toBeInTheDocument();
  });
});

describe('PlatformCompanyUsers', () => {
  const usersPath = `/api/v1/platform/companies/${COMPANY_ID}/users`;

  it('lists the company users with roles and owner badge', async () => {
    route({
      [`GET /api/v1/platform/companies/${COMPANY_ID}`]: () => json(envelope(detail())),
      [`GET ${usersPath}`]: () => json(paged([user(1), user(2, { roles: ['RECEPTIONIST'] })], 2)),
    });

    renderWithProviders(<PlatformCompanyUsers companyId={COMPANY_ID} />);

    expect(await screen.findByText('person1@acme.test')).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('RECEPTIONIST')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Acme Salon' })).toHaveAttribute(
      'href',
      `/platform/companies/${COMPANY_ID}`,
    );
  });

  it('sends search and membership filters, and shows an empty state', async () => {
    route({
      [`GET /api/v1/platform/companies/${COMPANY_ID}`]: () => json(envelope(detail())),
      [`GET ${usersPath}`]: (url) =>
        json(url.searchParams.has('status') ? paged([], 0) : paged([user(1)], 1)),
    });

    renderWithProviders(<PlatformCompanyUsers companyId={COMPANY_ID} />);
    await screen.findByText('person1@acme.test');

    await userEvent.type(screen.getByLabelText('Search'), 'person');
    await userEvent.selectOptions(screen.getByLabelText('Membership'), 'LOCKED');

    expect(await screen.findByText('Nobody matches those filters')).toBeInTheDocument();
    const last = calls(usersPath).at(-1)!.url.searchParams;
    expect(last.get('status')).toBe('LOCKED');
    expect(last.get('search')).toBe('person');
  });

  it('shows an error state', async () => {
    route({
      [`GET /api/v1/platform/companies/${COMPANY_ID}`]: () => apiError(404, 'RESOURCE_NOT_FOUND'),
      [`GET ${usersPath}`]: () => apiError(404, 'RESOURCE_NOT_FOUND'),
    });

    renderWithProviders(<PlatformCompanyUsers companyId={COMPANY_ID} />);

    expect(await screen.findByText('Could not load users')).toBeInTheDocument();
  });
});
