import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { ApiError } from '@/services/api-error';
import { bookingErrorMessage, describeRecurrence } from '../model/appointment-display';
import { AppointmentDetail } from './appointment-detail';
import { RecurringBooking } from './recurring-booking';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/appointments',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) => json({ error: { code, message, details, requestId: 'r' } }, status);

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: 'appt-1',
  appointmentNumber: 'APT-20261006-ABCDEF',
  status: 'CONFIRMED',
  paymentStatus: 'PAID',
  source: 'STAFF',
  startsAt: '2026-10-06T10:00:00+08:00',
  endsAt: '2026-10-06T11:00:00+08:00',
  timezone: 'Asia/Ulaanbaatar',
  branch: { id: 'br-1', name: 'Main' },
  customer: { id: 'cus-1', name: 'Sara Ochir', phone: null, email: null },
  service: { id: 'svc-1', name: 'Haircut' },
  employee: { id: 'emp-1', name: 'Ari' },
  resources: [],
  totalMinor: '0',
  currencyCode: 'MNT',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  customerNote: null,
  internalNote: null,
  subtotalMinor: '0',
  discountMinor: '0',
  promotions: [],
  reservedFrom: '2026-10-06T10:00:00+08:00',
  reservedTo: '2026-10-06T11:00:00+08:00',
  durationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  snapshot: null,
  confirmedAt: null,
  checkedInAt: null,
  completedAt: null,
  noShowAt: null,
  cancellation: null,
  rescheduledFrom: null,
  rescheduledTo: null,
  history: [],
  version: 0,
  seriesId: null,
  seriesIndex: null,
  ...overrides,
});

const series = (overrides: Record<string, unknown> = {}) => ({
  id: 'ser-1',
  status: 'ACTIVE',
  recurrence: {
    frequency: 'WEEKLY',
    interval: 1,
    weekdays: [2],
    localStartTime: '10:00',
    endDate: null,
    count: 3,
  },
  startsAt: '2026-10-06T10:00:00+08:00',
  timezone: 'Asia/Ulaanbaatar',
  branch: { id: 'br-1', name: 'Main' },
  customer: { id: 'cus-1', name: 'Sara Ochir' },
  service: { id: 'svc-1', name: 'Haircut' },
  employeeId: 'emp-1',
  resourceId: null,
  cancelledAt: null,
  cancellationReason: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  counts: { total: 3, upcoming: 3, cancelled: 0 },
  occurrences: ['06', '13', '20'].map((d, i) => ({
    ...detail({ id: i === 0 ? 'appt-1' : `appt-${i + 1}`, seriesId: 'ser-1', seriesIndex: i }),
    startsAt: `2026-10-${d}T10:00:00+08:00`,
  })),
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

const bodyOf = (call: unknown[] | undefined) => JSON.parse(String((call?.[1] as RequestInit).body));

describe('booking error messages', () => {
  it('explains rule refusals in plain words', () => {
    const notice = new ApiError({
      code: 'SLOT_UNAVAILABLE',
      message: 'x',
      status: 409,
      details: { reason: 'MINIMUM_NOTICE', minimumNoticeMinutes: 120 },
    });
    expect(bookingErrorMessage(notice, 'fallback')).toBe(
      'That time is too soon. Bookings need at least 2 hours notice.',
    );
    const ahead = new ApiError({
      code: 'SLOT_UNAVAILABLE',
      message: 'x',
      status: 409,
      details: { reason: 'BEYOND_BOOKING_WINDOW', maximumAdvanceDays: 30 },
    });
    expect(bookingErrorMessage(ahead, 'fallback')).toMatch(/30 days in advance/);
    const away = new ApiError({
      code: 'SLOT_UNAVAILABLE',
      message: 'x',
      status: 409,
      details: { reason: 'EMPLOYEE_TIME_OFF' },
    });
    expect(bookingErrorMessage(away, 'fallback')).toMatch(/time off/);
    const deadline = new ApiError({
      code: 'BOOKING_RULE_VIOLATION',
      message: 'The cancellation deadline for this appointment has passed.',
      status: 422,
      details: { rule: 'CANCELLATION_DEADLINE' },
    });
    expect(bookingErrorMessage(deadline, 'fallback')).toBe(
      'The cancellation deadline for this appointment has passed.',
    );
  });

  it('describes a recurrence', () => {
    expect(
      describeRecurrence({
        frequency: 'WEEKLY',
        interval: 2,
        weekdays: [1, 3],
        endDate: null,
        count: 6,
      }),
    ).toBe('Every 2 weeks on Mon, Wed, 6 times');
    expect(
      describeRecurrence({
        frequency: 'DAILY',
        interval: 1,
        weekdays: [],
        endDate: '2026-12-01',
        count: null,
      }),
    ).toBe('Every day, until 2026-12-01');
  });
});

describe('late cancellation', () => {
  const deadlineError = () =>
    failure(
      422,
      'BOOKING_RULE_VIOLATION',
      'The cancellation deadline for this appointment has passed.',
      {
        rule: 'CANCELLATION_DEADLINE',
      },
    );

  it('offers a confirmed late cancellation to staff who may cancel anyone’s', async () => {
    let attempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel') && init?.method === 'POST') {
        attempts += 1;
        return Promise.resolve(
          attempts === 1 ? deadlineError() : json(envelope(detail({ status: 'CANCELLED' }))),
        );
      }
      return Promise.resolve(json(envelope(detail())));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, {
      session: session(['appointment:read:any', 'appointment:write', 'appointment:cancel:any']),
    });

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'Called in sick');
    await user.click(screen.getByRole('button', { name: 'Cancel appointment' }));

    expect(
      await screen.findByText(/cancellation deadline for this appointment has passed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel anyway (late cancellation)' }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/cancel'));
      expect(calls).toHaveLength(2);
      expect(bodyOf(calls[1])).toEqual({ reason: 'Called in sick', lateCancellation: true });
    });
  });

  it('never offers the override without appointment:cancel:any', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          String(input).endsWith('/cancel') && init?.method === 'POST'
            ? deadlineError()
            : json(envelope(detail())),
        ),
      ),
    );
    const user = userEvent.setup();

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, {
      session: session(['appointment:read:own', 'appointment:cancel:own']),
    });

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'Sick');
    await user.click(screen.getByRole('button', { name: 'Cancel appointment' }));

    expect(await screen.findByText(/deadline/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /late cancellation/ })).toBeNull();
  });
});

describe('recurring series on the appointment', () => {
  it('lists the occurrences and cancels this and all later ones', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/appointment-series/ser-1/cancel')) {
        return Promise.resolve(
          json(
            envelope(
              series({ status: 'CANCELLED', counts: { total: 3, upcoming: 0, cancelled: 3 } }),
            ),
          ),
        );
      }
      if (url.includes('/appointment-series/ser-1'))
        return Promise.resolve(json(envelope(series())));
      void init;
      return Promise.resolve(json(envelope(detail({ seriesId: 'ser-1', seriesIndex: 0 }))));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, {
      session: session(['appointment:read:any', 'appointment:write', 'appointment:cancel:any']),
    });

    expect(await screen.findByText('Recurring series')).toBeInTheDocument();
    expect(screen.getByText(/Every week on Tue, 3 times at 10:00/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);

    await user.click(screen.getByRole('button', { name: 'Cancel this and all later' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'Moved away');
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) =>
        String(input).includes('/appointment-series/ser-1/cancel'),
      );
      expect(bodyOf(call)).toEqual({
        scope: 'future',
        from: '2026-10-06T10:00:00+08:00',
        reason: 'Moved away',
      });
    });
  });
});

describe('RecurringBooking', () => {
  const base = {
    branchId: 'br-1',
    serviceId: 'svc-1',
    customerId: 'cus-1',
    employeeId: 'emp-1',
    startsAt: '2026-10-06T10:00:00+08:00',
  };
  const preview = {
    timezone: 'Asia/Ulaanbaatar',
    occurrences: [
      {
        index: 0,
        date: '2026-10-06',
        startsAt: '2026-10-06T10:00:00+08:00',
        endsAt: '2026-10-06T11:00:00+08:00',
        bookable: true,
        reason: null,
        message: null,
      },
      {
        index: 1,
        date: '2026-10-13',
        startsAt: '2026-10-13T10:00:00+08:00',
        endsAt: null,
        bookable: false,
        reason: 'EMPLOYEE_TIME_OFF',
        message: 'x',
      },
      {
        index: 2,
        date: '2026-10-20',
        startsAt: '2026-10-20T10:00:00+08:00',
        endsAt: '2026-10-20T11:00:00+08:00',
        bookable: true,
        reason: null,
        message: null,
      },
    ],
    skippedDates: [],
    bookableCount: 2,
    conflictCount: 1,
    employeeId: 'emp-1',
  };

  it('checks every date, shows why one cannot be booked, and books the rest only when asked', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/recurring/preview')) return Promise.resolve(json(envelope(preview)));
      if (url.endsWith('/recurring'))
        return Promise.resolve(
          json(envelope({ ...series(), skipped: [preview.occurrences[1]] }), 201),
        );
      return Promise.resolve(json(envelope({})));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onBooked = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <RecurringBooking base={base} startDate="2026-10-06" onBooked={onBooked} />,
      {
        session: session(['appointment:write']),
      },
    );

    await user.click(screen.getByRole('button', { name: 'Check dates' }));

    expect(await screen.findByText('2 of 3 dates can be booked; 1 cannot.')).toBeInTheDocument();
    expect(screen.getByText(/away \(time off\)/)).toBeInTheDocument();
    // Nothing conflicting is booked silently.
    const book = screen.getByRole('button', { name: /^Book/ });
    expect(book).toBeDisabled();

    await user.click(screen.getByLabelText(/skip the 1 that cannot be booked/));
    await user.click(screen.getByRole('button', { name: 'Book 2 appointments' }));

    await waitFor(() =>
      expect(onBooked).toHaveBeenCalledWith({ firstAppointmentId: 'appt-1', seriesId: 'ser-1' }),
    );
    const create = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/recurring'));
    expect(bodyOf(create)).toMatchObject({
      ...base,
      onConflict: 'skip',
      recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2], count: 4 },
    });
  });

  it('asks for at least one weekday', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const user = userEvent.setup();
    renderWithProviders(
      <RecurringBooking base={base} startDate="2026-10-06" onBooked={vi.fn()} />,
      {
        session: session(['appointment:write']),
      },
    );
    await user.click(screen.getByLabelText('Tue'));
    expect(screen.getByText('Choose at least one weekday.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check dates' })).toBeDisabled();
  });
});
