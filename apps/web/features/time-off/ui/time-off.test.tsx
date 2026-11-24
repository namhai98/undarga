import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { BookingSettingsPage } from '@/features/booking-settings';
import { TimeOffPage } from './time-off-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/time-off',
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

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'to-1',
  employeeId: 'emp-1',
  employeeName: 'Ari',
  type: 'VACATION',
  status: 'PENDING',
  startsAt: '2026-11-02T00:00:00.000Z',
  endsAt: '2026-11-05T00:00:00.000Z',
  isPaid: true,
  reason: null,
  approvedAt: null,
  rejectionReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const list = (items: unknown[]) => envelope({ items, total: items.length, limit: 100, offset: 0 });
const employees = envelope({
  items: [{ id: 'emp-1', displayName: 'Ari', status: 'ACTIVE' }],
  total: 1,
  limit: 100,
  offset: 0,
});

afterEach(() => vi.unstubAllGlobals());

describe('TimeOffPage', () => {
  it('lets an employee request their own time off, with no staff picker and no approve button', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/time-off') && init?.method === 'POST') {
        return Promise.resolve(json(envelope(entry()), 201));
      }
      return Promise.resolve(
        json(String(input).includes('/time-off') ? list([entry()]) : employees),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<TimeOffPage />, { session: session(['timeoff:request']) });

    expect(await screen.findByText('Ari · Vacation')).toBeInTheDocument();
    expect(screen.queryByLabelText('Staff member')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('From'), '2026-11-02T09:00');
    await user.type(screen.getByLabelText('Until'), '2026-11-02T13:00');
    await user.click(screen.getByRole('button', { name: 'Request time off' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
      );
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.employeeId).toBeUndefined();
      expect(body.type).toBe('VACATION');
    });
    expect(
      await screen.findByText('Requested. It blocks bookings once a manager approves it.'),
    ).toBeInTheDocument();
  });

  it('shows the appointments time off would overlap, and records it only when confirmed', async () => {
    let posts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/time-off') && init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(
          posts === 1
            ? json(
                {
                  error: {
                    code: 'TIME_OFF_CONFLICT',
                    message: 'This time off overlaps booked appointments.',
                    details: {
                      appointments: [
                        {
                          appointmentId: 'appt-1',
                          appointmentNumber: 'APT-1',
                          startsAt: '2026-11-02T02:00:00.000Z',
                        },
                      ],
                    },
                    requestId: 'r',
                  },
                },
                409,
              )
            : json(envelope(entry({ status: 'APPROVED', conflicts: [] })), 201),
        );
      }
      return Promise.resolve(json(String(input).includes('/time-off') ? list([]) : employees));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<TimeOffPage />, {
      session: session(['timeoff:approve', 'employee:read']),
    });

    await screen.findByRole('option', { name: 'Ari' });
    await user.selectOptions(screen.getByLabelText('Staff member'), 'emp-1');
    await user.selectOptions(screen.getByLabelText('Type'), 'SICK');
    await user.type(screen.getByLabelText('From'), '2026-11-02T09:00');
    await user.type(screen.getByLabelText('Until'), '2026-11-02T18:00');
    await user.click(screen.getByRole('button', { name: 'Record time off' }));

    expect(await screen.findByText('APT-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Record anyway/ }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String((calls[1]![1] as RequestInit).body))).toMatchObject({
        employeeId: 'emp-1',
        type: 'SICK',
        allowConflicts: true,
      });
    });
  });
});

describe('BookingSettingsPage', () => {
  const settings = {
    minimumBookingNoticeMinutes: 60,
    maximumAdvanceBookingDays: 90,
    cancellationDeadlineHours: 24,
    reschedulingAllowed: true,
    rescheduleDeadlineHours: null,
    effectiveRescheduleDeadlineHours: 24,
    allowCustomerCancel: true,
    allowCustomerReschedule: true,
  };

  it('saves the rules the server enforces', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        json(
          envelope(
            init?.method === 'PATCH' ? { ...settings, cancellationDeadlineHours: 48 } : settings,
          ),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<BookingSettingsPage />, {
      session: session(['settings:read', 'settings:write']),
    });

    const deadline = await screen.findByLabelText('Cancellation deadline (hours before)');
    await user.clear(deadline);
    await user.type(deadline, '48');
    await user.click(screen.getByLabelText('Appointments may be rescheduled'));
    await user.click(screen.getByRole('button', { name: 'Save booking rules' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, i]) => (i as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        minimumBookingNoticeMinutes: 60,
        maximumAdvanceBookingDays: 90,
        cancellationDeadlineHours: 48,
        reschedulingAllowed: false,
        rescheduleDeadlineHours: null,
        allowCustomerCancel: true,
        allowCustomerReschedule: true,
      });
    });
  });

  it('is read-only without settings:write and blocks out-of-range values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(envelope(settings)))),
    );
    renderWithProviders(<BookingSettingsPage />, { session: session(['settings:read']) });
    expect(
      await screen.findByText('You can view these rules but not change them.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum notice (minutes)')).toBeDisabled();
  });
});
