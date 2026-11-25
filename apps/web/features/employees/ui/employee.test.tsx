import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { EmployeeDetail } from './employee-detail';
import { EmployeeList } from './employee-list';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push, refresh: vi.fn() }),
  usePathname: () => '/staff',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => envelope({ items, total: items.length, limit: 100, offset: 0 });

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

const detail = {
  id: 'emp-1',
  employeeCode: null,
  displayName: 'Ari',
  status: 'ACTIVE',
  isBookable: true,
  acceptsWalkIns: true,
  calendarColor: null,
  hiredOn: null,
  jobTitle: 'Stylist',
  avatarFileId: null,
  branchIds: ['br-1'],
  primaryBranchId: 'br-1',
  account: null,
  hasAccount: false,
  publicProfile: {
    displayName: 'Ari',
    jobTitle: 'Stylist',
    bio: null,
    avatarFileId: null,
    languages: [],
    specialties: [],
  },
  privateProfile: { phone: null, emergencyContact: null },
  branches: [{ branchId: 'br-1', name: 'Central', code: null, isPrimary: true }],
  services: [
    {
      serviceId: 'svc-1',
      name: 'Haircut',
      durationOverrideMin: null,
      priceOverrideMinor: null,
      proficiency: null,
    },
  ],
};

let exceptions: unknown[] = [];

const schedule = {
  branchId: 'br-1',
  days: [{ dayOfWeek: 1, startsAt: '09:00', endsAt: '17:00', crossesMidnight: false, breaks: [] }],
};

function routes(
  extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = extra(url, init);
    if (custom) return Promise.resolve(custom);
    if (url.includes('/schedule-exceptions')) {
      return Promise.resolve(json(envelope({ items: exceptions })));
    }
    if (url.includes('/schedule')) return Promise.resolve(json(envelope(schedule)));
    if (url.includes('/members/roles')) {
      return Promise.resolve(
        json(envelope({ items: [{ key: 'EMPLOYEE', name: 'Employee', permissions: [] }] })),
      );
    }
    if (url.includes('/branches')) {
      return Promise.resolve(
        json(envelope({ items: [{ id: 'br-1', name: 'Central' }], total: 1 })),
      );
    }
    if (url.includes('/services')) {
      return Promise.resolve(
        json(
          page([
            { id: 'svc-1', name: 'Haircut' },
            { id: 'svc-2', name: 'Colour' },
          ]),
        ),
      );
    }
    if (url.includes('/employees/emp-1')) return Promise.resolve(json(envelope(detail)));
    if (url.includes('/employees')) return Promise.resolve(json(page([detail])));
    return Promise.resolve(json(envelope({})));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('EmployeeDetail', () => {
  it('saves the working week: ticked days only, Monday-first form, branch included', async () => {
    const fetchMock = routes((url, init) => {
      if (!(url.endsWith('/schedule') && init?.method === 'PUT')) return undefined;
      // What the API answers: the week as saved, breaks included.
      const sent = JSON.parse(String(init.body)) as {
        branchId: string;
        days: Array<Record<string, unknown>>;
      };
      return json(
        envelope({
          branchId: sent.branchId,
          days: sent.days.map((d) => ({ crossesMidnight: false, breaks: [], ...d })),
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read', 'employee:write']),
    });

    expect(await screen.findByLabelText('Works on Monday')).toBeChecked();
    expect(screen.getByLabelText('Works on Tuesday')).not.toBeChecked();
    expect(screen.getByLabelText('Monday from')).toHaveValue('09:00');

    await user.click(screen.getByLabelText('Works on Wednesday'));
    await user.click(screen.getByRole('button', { name: 'Save working hours' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, i]) => (i as RequestInit | undefined)?.method === 'PUT',
      );
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        branchId: 'br-1',
        days: [
          { dayOfWeek: 1, startsAt: '09:00', endsAt: '17:00' },
          { dayOfWeek: 3, startsAt: '09:00', endsAt: '18:00' },
        ],
      });
    });
  });

  it('refuses a shift that starts and ends at the same time before sending it', async () => {
    vi.stubGlobal('fetch', routes());
    const user = userEvent.setup();
    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read', 'employee:write']),
    });

    const until = await screen.findByLabelText('Monday until');
    await user.clear(until);
    await user.type(until, '09:00');

    expect(await screen.findByText(/cannot start and end at the same time/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save working hours' })).toBeDisabled();
  });

  it('offers only services the employee does not have yet', async () => {
    vi.stubGlobal('fetch', routes());
    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read', 'employee:write']),
    });

    const select = await screen.findByLabelText('Add a service');
    await waitFor(() =>
      expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual([
        'Select…',
        'Colour',
      ]),
    );
  });

  it('is read-only without employee:write', async () => {
    vi.stubGlobal('fetch', routes());
    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read']),
    });

    expect(await screen.findByLabelText('Works on Monday')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save working hours' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove from staff' })).toBeNull();
  });
});

describe('EmployeeList', () => {
  it('adds an employee and opens their page to finish setting them up', async () => {
    const fetchMock = routes((url, init) =>
      url.endsWith('/employees') && init?.method === 'POST'
        ? json(envelope({ ...detail, id: 'emp-9', displayName: 'Bold' }), 201)
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<EmployeeList />, {
      session: session(['employee:read', 'employee:write']),
    });

    expect(await screen.findByRole('link', { name: 'Ari' })).toHaveAttribute(
      'href',
      '/staff/emp-1',
    );
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    await user.type(screen.getByLabelText('Name'), 'Bold');
    await user.click(screen.getByRole('button', { name: 'Add and set up' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/staff/emp-9'));
    const call = fetchMock.mock.calls.find(
      ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
    );
    // The only branch is chosen for them.
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      displayName: 'Bold',
      branchIds: ['br-1'],
    });
  });
});

describe('EmployeeDetail — breaks, one-off days and login', () => {
  afterEach(() => {
    exceptions = [];
  });

  it('sends a lunch break with its day', async () => {
    const fetchMock = routes((url, init) =>
      url.endsWith('/schedule') && init?.method === 'PUT' ? json(envelope(schedule)) : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read', 'employee:write']),
    });

    await user.type(await screen.findByLabelText('Monday break from'), '13:00');
    await user.type(screen.getByLabelText('Monday break until'), '14:00');
    await user.click(screen.getByRole('button', { name: 'Save working hours' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, i]) => (i as RequestInit | undefined)?.method === 'PUT',
      );
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.days[0]).toEqual({
        dayOfWeek: 1,
        startsAt: '09:00',
        endsAt: '17:00',
        breaks: [{ startsAt: '13:00', endsAt: '14:00' }],
      });
    });
  });

  it('sets a day off on one date', async () => {
    const fetchMock = routes((url, init) =>
      url.endsWith('/schedule-exceptions') && init?.method === 'PUT'
        ? json(
            envelope({
              id: 'x-1',
              date: '2026-12-04',
              isWorking: false,
              startsAt: null,
              endsAt: null,
              note: null,
            }),
          )
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read', 'employee:write']),
    });

    await user.type(await screen.findByLabelText('Date'), '2026-12-04');
    await user.click(screen.getByRole('button', { name: 'Set day off' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith('/schedule-exceptions') &&
          (i as RequestInit | undefined)?.method === 'PUT',
      );
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        date: '2026-12-04',
        isWorking: false,
        note: null,
      });
    });
  });

  it('creates a login and shows the one-time invitation link', async () => {
    const fetchMock = routes((url, init) =>
      url.endsWith('/account') && init?.method === 'POST'
        ? json(
            envelope({
              employeeId: 'emp-1',
              userAccountId: 'u-9',
              invitation: {
                id: 'inv-1',
                token: 'tok',
                acceptUrl: 'https://app.example.com/invitations/accept?token=tok',
                expiresAt: '2026-12-01T00:00:00.000Z',
              },
            }),
            201,
          )
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<EmployeeDetail employeeId="emp-1" />, {
      session: session(['employee:read', 'employee:write', 'member:invite', 'member:read']),
    });

    await user.type(await screen.findByLabelText('Their email'), 'ari@example.com');
    await waitFor(() => expect(screen.getByLabelText('Role')).toHaveValue('EMPLOYEE'));
    await user.click(screen.getByRole('button', { name: 'Create login' }));

    expect(await screen.findByLabelText('Invitation link')).toHaveValue(
      'https://app.example.com/invitations/accept?token=tok',
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/account'));
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      email: 'ari@example.com',
      roleKeys: ['EMPLOYEE'],
    });
  });
});
