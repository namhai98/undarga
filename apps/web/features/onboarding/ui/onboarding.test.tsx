import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '@/services/token-store';
import { renderWithProviders, sessionWith } from '@/test/render';
import { OnboardingGate } from './onboarding-gate';
import { OnboardingWizard } from './onboarding-wizard';

const replace = vi.fn();
let pathname = '/onboarding';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

const noCompany = {
  status: 'NOT_STARTED',
  company: null,
  steps: { company: false, branch: false, businessSettings: false, services: false },
  nextStep: 'COMPANY',
  canManage: true,
  completedAt: null,
};

const companyStatus = (status: string, overrides: Record<string, unknown> = {}) => ({
  status,
  company: {
    id: COMPANY_ID,
    slug: 'nomin-spa',
    displayName: 'Nomin Spa',
    status: status === 'NOT_STARTED' ? 'PENDING_SETUP' : 'ACTIVE',
    defaultTimezoneName: 'Asia/Ulaanbaatar',
    currencyCode: 'MNT',
  },
  steps: {
    company: true,
    branch: status !== 'NOT_STARTED',
    businessSettings: status !== 'NOT_STARTED',
    services: false,
  },
  nextStep: status === 'COMPLETED' ? null : status === 'IN_PROGRESS' ? 'SERVICES' : 'BRANCH',
  canManage: true,
  completedAt: status === 'COMPLETED' ? '2026-10-08T00:00:00.000Z' : null,
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;

function route(handlers: Record<string, (url: URL, init: RequestInit) => Response>) {
  fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) return Promise.resolve(json({ error: { code: 'X', message: key } }, 500));
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const bodyOf = (path: string) => {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => new URL(input as string).pathname === path && (init as RequestInit)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
};

const session = (activeCompanyId: string | null = null) =>
  sessionWith({
    user: { id: 'u-1', email: 'founder@example.com', displayName: 'Founder' },
    activeCompanyId,
  });

beforeEach(() => {
  replace.mockReset();
  pathname = '/onboarding';
});

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear('signed-out');
});

describe('OnboardingWizard — a new company', () => {
  const createdCompany = {
    company: {
      id: COMPANY_ID,
      slug: 'nomin-spa',
      displayName: 'Nomin Spa',
      defaultTimezoneName: 'Asia/Ulaanbaatar',
      currencyCode: 'MNT',
    },
    branch: { id: 'b-1', code: 'MAIN', name: 'Main branch', timezoneName: 'Asia/Ulaanbaatar' },
    subscription: { status: 'TRIAL', planKey: 'PRO', planName: 'Pro', trialEndsAt: null },
    onboarding: { status: 'IN_PROGRESS', nextStep: 'SERVICES' },
  };

  const happyRoutes = () => ({
    'GET /api/v1/onboarding/status': () => json(envelope(noCompany)),
    'GET /api/v1/onboarding/slug-availability': (url: URL) =>
      json(envelope({ slug: url.searchParams.get('slug'), available: true, reason: null })),
    'POST /api/v1/onboarding/company': () => json(envelope(createdCompany), 201),
    'POST /api/v1/auth/switch-company': () =>
      json(
        envelope({
          accessToken: 'new-token',
          expiresIn: 900,
          tokenType: 'Bearer',
          activeCompanyId: COMPANY_ID,
          memberships: [],
        }),
      ),
    [`POST /api/v1/onboarding/companies/${COMPANY_ID}/complete`]: () =>
      json(envelope({ services: [], onboarding: companyStatus('COMPLETED') })),
  });

  async function fillSteps1to3() {
    await userEvent.type(await screen.findByLabelText('Company name'), 'Nomin Spa');
    // The identifier follows the name until it is edited.
    expect(screen.getByLabelText('Company identifier')).toHaveValue('nomin-spa');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Your first branch')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Address'), 'Peace Avenue 1');
    await userEvent.selectOptions(screen.getByLabelText('Timezone'), 'Asia/Ulaanbaatar');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Business settings')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Currency'), 'MNT');
  }

  it('walks steps 1-5, creating the company then adding services', async () => {
    route(happyRoutes());
    renderWithProviders(<OnboardingWizard />, { session: session() });

    await fillSteps1to3();
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));

    expect(await screen.findByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(bodyOf('/api/v1/onboarding/company')).toMatchObject({
      company: { displayName: 'Nomin Spa', slug: 'nomin-spa' },
      branch: { name: 'Main branch', timezoneName: 'Asia/Ulaanbaatar', addressLine1: 'Peace Avenue 1' },
      business: { currencyCode: 'MNT' },
    });
    // No owner field: the API makes the caller the owner.
    expect(bodyOf('/api/v1/onboarding/company')).not.toHaveProperty('owner');
    // Then it switches into the new company.
    expect(bodyOf('/api/v1/auth/switch-company')).toEqual({ companyId: COMPANY_ID });

    await userEvent.click(screen.getByRole('button', { name: 'Add a service' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Haircut');
    await userEvent.type(screen.getByLabelText('Category'), 'Hair');
    await userEvent.clear(screen.getByLabelText('Duration (minutes)'));
    await userEvent.type(screen.getByLabelText('Duration (minutes)'), '45');
    await userEvent.type(screen.getByLabelText('Price (MNT)'), '35000');
    await userEvent.click(screen.getByRole('button', { name: 'Save services and finish' }));

    expect(await screen.findByText('Nomin Spa is ready')).toBeInTheDocument();
    expect(bodyOf(`/api/v1/onboarding/companies/${COMPANY_ID}/complete`)).toEqual({
      services: [
        { name: 'Haircut', category: 'Hair', durationMin: 45, priceMinor: '3500000', isActive: true },
      ],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }));
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('lets the services step be skipped', async () => {
    route(happyRoutes());
    renderWithProviders(<OnboardingWizard />, { session: session() });

    await fillSteps1to3();
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));

    expect(await screen.findByText('Nomin Spa is ready')).toBeInTheDocument();
    expect(bodyOf(`/api/v1/onboarding/companies/${COMPANY_ID}/complete`)).toEqual({ services: [] });
  });

  it('does not advance past an invalid step', async () => {
    route(happyRoutes());
    renderWithProviders(<OnboardingWizard />, { session: session() });

    await screen.findByLabelText('Company name');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('Enter the company name.')).toBeInTheDocument();
    expect(screen.queryByText('Your first branch')).not.toBeInTheDocument();
  });

  it('checks services before sending them', async () => {
    route(happyRoutes());
    renderWithProviders(<OnboardingWizard />, { session: session() });

    await fillSteps1to3();
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a service' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save services and finish' }));

    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(bodyOf(`/api/v1/onboarding/companies/${COMPANY_ID}/complete`)).toBeUndefined();
  });

  it('takes a taken identifier back to step 1 with the reason', async () => {
    route({
      ...happyRoutes(),
      'POST /api/v1/onboarding/company': () =>
        json(
          {
            error: {
              code: 'CONFLICT',
              message: 'The slug "nomin-spa" is already taken.',
              details: { field: 'slug' },
            },
          },
          409,
        ),
    });
    renderWithProviders(<OnboardingWizard />, { session: session() });

    await fillSteps1to3();
    await userEvent.click(screen.getByRole('button', { name: 'Create company' }));

    expect(await screen.findByText('The slug "nomin-spa" is already taken.')).toBeInTheDocument();
    expect(screen.getByLabelText('Company identifier')).toBeInTheDocument();
  });
});

describe('OnboardingWizard — resuming', () => {
  it('resumes at the services step for an IN_PROGRESS company', async () => {
    route({ 'GET /api/v1/onboarding/status': () => json(envelope(companyStatus('IN_PROGRESS'))) });
    renderWithProviders(<OnboardingWizard />, { session: session(COMPANY_ID) });

    expect(await screen.findByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
  });

  it('sets up a provisioned company without changing its identifier', async () => {
    route({
      'GET /api/v1/onboarding/status': () => json(envelope(companyStatus('NOT_STARTED'))),
      [`POST /api/v1/onboarding/companies/${COMPANY_ID}/setup`]: () =>
        json(envelope({ onboarding: companyStatus('IN_PROGRESS') })),
    });
    renderWithProviders(<OnboardingWizard />, { session: session(COMPANY_ID) });

    expect(await screen.findByLabelText('Company name')).toHaveValue('Nomin Spa');
    expect(screen.getByLabelText('Company identifier')).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    const body = bodyOf(`/api/v1/onboarding/companies/${COMPANY_ID}/setup`);
    expect(body.company).toEqual({ displayName: 'Nomin Spa' });
    expect(body.branch.timezoneName).toBe('Asia/Ulaanbaatar');
  });

  it('says so when the company is already set up', async () => {
    route({ 'GET /api/v1/onboarding/status': () => json(envelope(companyStatus('COMPLETED'))) });
    renderWithProviders(<OnboardingWizard />, { session: session(COMPANY_ID) });

    expect(await screen.findByText('Your company is set up')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create another company' })).toHaveAttribute(
      'href',
      '/onboarding?new=1',
    );
  });

  it('does not offer the wizard to a member who cannot finish it', async () => {
    route({
      'GET /api/v1/onboarding/status': () =>
        json(envelope(companyStatus('IN_PROGRESS', { canManage: false }))),
    });
    renderWithProviders(<OnboardingWizard />, { session: session(COMPANY_ID) });

    expect(await screen.findByText('Setup is not finished yet')).toBeInTheDocument();
  });

  it('shows an error state when the status cannot be loaded', async () => {
    route({
      'GET /api/v1/onboarding/status': () => json({ error: { code: 'X', message: 'x' } }, 500),
    });
    renderWithProviders(<OnboardingWizard />, { session: session() });

    expect(await screen.findByText('Could not load onboarding')).toBeInTheDocument();
  });
});

describe('OnboardingGate', () => {
  const renderGate = () =>
    renderWithProviders(
      <OnboardingGate>
        <p>app content</p>
      </OnboardingGate>,
      { session: session(COMPANY_ID) },
    );

  it('sends an owner of an unfinished company back to onboarding', async () => {
    pathname = '/dashboard';
    route({ 'GET /api/v1/onboarding/status': () => json(envelope(companyStatus('IN_PROGRESS'))) });
    renderGate();

    expect(screen.getByText('app content')).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/onboarding'));
  });

  it('leaves a finished company alone', async () => {
    pathname = '/dashboard';
    route({ 'GET /api/v1/onboarding/status': () => json(envelope(companyStatus('COMPLETED'))) });
    renderGate();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it('leaves a member who cannot finish it alone', async () => {
    pathname = '/dashboard';
    route({
      'GET /api/v1/onboarding/status': () =>
        json(envelope(companyStatus('IN_PROGRESS', { canManage: false }))),
    });
    renderGate();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it('never blocks switching company', async () => {
    pathname = '/select-company';
    route({ 'GET /api/v1/onboarding/status': () => json(envelope(companyStatus('NOT_STARTED'))) });
    renderGate();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replace).not.toHaveBeenCalled();
  });
});
