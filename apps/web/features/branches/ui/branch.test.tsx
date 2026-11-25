import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { CompanyBrandingCard, CompanyDetails } from '@/features/companies';
import { BranchDetail } from './branch-detail';
import { BranchList } from './branch-list';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push, refresh: vi.fn() }),
  usePathname: () => '/settings',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

const branch = {
  id: 'br-1',
  code: 'CENTRAL',
  name: 'Central',
  status: 'ACTIVE',
  timezoneName: 'Asia/Ulaanbaatar',
  currencyCode: null,
  phone: null,
  email: null,
  addressLine1: 'Peace Ave 1',
  addressLine2: null,
  city: 'Ulaanbaatar',
  district: null,
  postalCode: null,
  countryCode: null,
  latitude: null,
  longitude: null,
  sortOrder: 0,
  imageFileId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const company = {
  id: 'co-1',
  slug: 'nomin',
  legalName: 'Nomin LLC',
  displayName: 'Nomin Spa',
  status: 'ACTIVE',
  defaultTimezoneName: 'Asia/Ulaanbaatar',
  currencyCode: 'MNT',
  locale: 'mn',
  registrationNumber: null,
  taxNumber: null,
  contactEmail: 'hi@nomin.mn',
  contactPhone: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const hours = {
  days: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    isClosed: false,
    opensAt: '09:00',
    closesAt: '18:00',
    crossesMidnight: false,
    effectiveFrom: '2026-01-01',
  })),
};

function routes(
  extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = extra(url, init);
    if (custom) return Promise.resolve(custom);
    if (url.includes('/business-hours')) return Promise.resolve(json(envelope(hours)));
    if (url.includes('/branches/br-1')) return Promise.resolve(json(envelope(branch)));
    if (url.includes('/branches'))
      return Promise.resolve(json(envelope({ items: [branch], total: 1 })));
    return Promise.resolve(json(envelope(company)));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('BranchDetail', () => {
  it('saves all seven days, unticked ones as closed', async () => {
    const fetchMock = routes((url, init) =>
      url.includes('/business-hours') && init?.method === 'PUT' ? json(envelope(hours)) : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<BranchDetail branchId="br-1" />, {
      session: session(['branch:read', 'branch:write']),
    });

    await user.click(await screen.findByLabelText('Open on Saturday'));
    await user.click(screen.getByRole('button', { name: 'Save opening hours' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, i]) => (i as RequestInit | undefined)?.method === 'PUT',
      );
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.days).toHaveLength(7);
      expect(body.days).toContainEqual({
        dayOfWeek: 6,
        isClosed: false,
        opensAt: '09:00',
        closesAt: '18:00',
      });
      expect(body.days).toContainEqual({ dayOfWeek: 0, isClosed: true });
    });
  });

  it('shows the form read-only without branch:write', async () => {
    vi.stubGlobal('fetch', routes());
    renderWithProviders(<BranchDetail branchId="br-1" />, { session: session(['branch:read']) });

    expect(await screen.findByLabelText('Branch name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save branch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove branch' })).toBeNull();
  });
});

describe('BranchList', () => {
  it('adds a branch in the company’s time zone and opens it', async () => {
    const fetchMock = routes((url, init) =>
      url.endsWith('/branches') && init?.method === 'POST'
        ? json(envelope({ ...branch, id: 'br-9' }), 201)
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<BranchList />, { session: session(['branch:read', 'branch:write']) });

    await user.click(await screen.findByRole('button', { name: 'Add branch' }));
    await user.type(screen.getByLabelText('Branch name'), 'North');
    await user.type(screen.getByLabelText('Short code'), 'north');
    await waitFor(() => expect(screen.getByLabelText('Time zone')).toHaveValue('Asia/Ulaanbaatar'));
    await user.click(screen.getByRole('button', { name: 'Add and set hours' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/settings/branches/br-9'));
    const call = fetchMock.mock.calls.find(
      ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      name: 'North',
      code: 'NORTH',
      timezoneName: 'Asia/Ulaanbaatar',
    });
  });
});

describe('CompanyDetails', () => {
  it('sends cleared optional fields as null', async () => {
    const fetchMock = routes((_url, init) =>
      init?.method === 'PATCH' ? json(envelope(company)) : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<CompanyDetails />, {
      session: session(['company:read', 'company:write']),
    });

    await user.clear(await screen.findByLabelText('Contact email'));
    await user.click(screen.getByRole('button', { name: 'Save company' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, i]) => (i as RequestInit | undefined)?.method === 'PATCH',
      );
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.contactEmail).toBeNull();
      expect(body.displayName).toBe('Nomin Spa');
    });
  });
});

describe('Branch rules and booking page', () => {
  it('saves a branch override, and a blank field as "use the company rule"', async () => {
    const fetchMock = routes((url, init) => {
      if (url.endsWith('/settings') && init?.method === 'PATCH') {
        return json(envelope(JSON.parse(String(init.body))));
      }
      if (url.endsWith('/settings')) {
        return json(
          envelope({
            slotGranularityMin: null,
            bookingLeadTimeMin: 60,
            maxAdvanceBookingDays: null,
            cancellationWindowHours: null,
            allowOnlineBooking: null,
            requireDeposit: null,
            depositPercentBps: null,
          }),
        );
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<BranchDetail branchId="br-1" />, {
      session: session(['branch:read', 'branch:write']),
    });

    const notice = await screen.findByLabelText('Minimum notice (minutes)');
    expect(notice).toHaveValue('60');
    await user.clear(notice);
    await user.type(screen.getByLabelText('Book up to (days ahead)'), '30');
    await user.click(screen.getByRole('button', { name: 'Save branch rules' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith('/settings') && (i as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        bookingLeadTimeMin: null,
        maxAdvanceBookingDays: 30,
        cancellationWindowHours: null,
      });
    });
  });

  it('saves the booking page headline, description and colours', async () => {
    const fetchMock = routes((url, init) => {
      if (url.endsWith('/branding') && init?.method === 'PATCH') return json(envelope({}));
      if (url.endsWith('/branding')) {
        return json(
          envelope({
            primaryColor: '#0F6B63',
            accentColor: '#F59E0B',
            backgroundColor: '#FFFFFF',
            fontFamily: null,
            bookingPageHeadline: null,
            bookingPageBlurb: null,
            emailFromName: null,
            emailReplyTo: null,
            logoFileId: null,
          }),
        );
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<CompanyBrandingCard />, {
      session: session(['company:read', 'company:write']),
    });

    await user.type(await screen.findByLabelText('Headline'), 'Calm, quick, local');
    await user.click(screen.getByRole('button', { name: 'Save booking page' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith('/branding') && (i as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        bookingPageHeadline: 'Calm, quick, local',
        bookingPageBlurb: null,
        primaryColor: '#0F6B63',
        accentColor: '#F59E0B',
      });
    });
  });
});
