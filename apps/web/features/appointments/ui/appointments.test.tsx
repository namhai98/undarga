import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { AppointmentDetail } from './appointment-detail';
import { SlotPicker } from './slot-picker';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/appointments',
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

const day = (slots: unknown[], unavailableReason: string | null = null) => ({
  date: '2026-10-06',
  timezone: 'Asia/Ulaanbaatar',
  branchId: 'br-1',
  serviceId: 'svc-1',
  slotIntervalMin: 30,
  serviceDurationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  unavailableReason,
  slots,
});

const slot = (hhmm: string) => ({
  startAt: `2026-10-06T${hhmm}:00+08:00`,
  endAt: `2026-10-06T${hhmm}:00+08:00`,
  reservedFrom: `2026-10-06T${hhmm}:00+08:00`,
  reservedTo: `2026-10-06T${hhmm}:00+08:00`,
  available: true,
  employeeIds: ['emp-1'],
  resourceIds: [],
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: 'appt-1',
  appointmentNumber: 'APT-20261006-ABCDEF',
  status: 'CONFIRMED',
  paymentStatus: 'UNPAID',
  source: 'STAFF',
  startsAt: '2026-10-06T10:00:00+08:00',
  endsAt: '2026-10-06T11:00:00+08:00',
  timezone: 'Asia/Ulaanbaatar',
  branch: { id: 'br-1', name: 'Main' },
  customer: { id: 'cus-1', name: 'Sara Ochir', phone: null, email: null },
  service: { id: 'svc-1', name: 'Haircut' },
  employee: { id: 'emp-1', name: 'Ari' },
  resources: [],
  totalMinor: '450000',
  currencyCode: 'MNT',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  customerNote: null,
  internalNote: null,
  subtotalMinor: '450000',
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
  history: [
    {
      id: 'h-1',
      fromStatus: null,
      toStatus: 'CONFIRMED',
      actorType: 'COMPANY_USER',
      actorLabel: 'A <a@example.com>',
      reason: 'Created',
      changedAt: '2026-09-28T00:00:00.000Z',
    },
  ],
  version: 0,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('SlotPicker', () => {
  it('offers exactly the server’s slots and hands back the server’s own startAt', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(envelope(day([slot('09:00'), slot('09:30')])))));
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SlotPicker
        branchId="br-1"
        serviceId="svc-1"
        date="2026-10-06"
        excludeAppointmentId="appt-9"
        selected={null}
        onSelect={onSelect}
      />,
      { session: session(['availability:read']) },
    );

    await user.click(await screen.findByRole('radio', { name: '09:30' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ startAt: '2026-10-06T09:30:00+08:00' }));
    expect(screen.getAllByRole('radio')).toHaveLength(2);

    // The reschedule flow's exclusion reaches the server.
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('excludeAppointmentId=appt-9');
  });

  it('explains a structurally empty day', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(envelope(day([], 'BRANCH_CLOSED'))))));

    renderWithProviders(
      <SlotPicker branchId="br-1" serviceId="svc-1" date="2026-10-06" selected={null} onSelect={vi.fn()} />,
      { session: session(['availability:read']) },
    );

    expect(await screen.findByText('This branch is closed on this date.')).toBeInTheDocument();
  });
});

describe('AppointmentDetail', () => {
  const all = ['appointment:read:any', 'appointment:write', 'appointment:cancel:any'];

  it('shows only the actions that fit the status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(envelope(detail())))));

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, { session: session(all) });

    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark no-show' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(screen.getByText('Sara Ochir')).toBeInTheDocument();
  });

  it('shows the booking-time discount as the server recorded it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(
            envelope(
              detail({
                subtotalMinor: '500000',
                discountMinor: '50000',
                totalMinor: '450000',
                promotions: [
                  { promotionId: 'pr-1', name: 'Autumn', code: 'AUTUMN10', discountMinor: '50000' },
                ],
              }),
            ),
          ),
        ),
      ),
    );

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, { session: session(all) });

    expect(await screen.findByText('Original price')).toBeInTheDocument();
    expect(screen.getByText('Discount (Autumn · AUTUMN10)')).toBeInTheDocument();
    expect(screen.getByText('Final price')).toBeInTheDocument();
  });

  it('offers nothing on a finished appointment', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(envelope(detail({ status: 'COMPLETED' }))))));

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, { session: session(all) });

    await screen.findByText('Sara Ochir');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
  });

  it('requires a reason and confirmation before cancelling', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/cancel') && init?.method === 'POST') {
        return Promise.resolve(
          json(
            envelope(
              detail({
                status: 'CANCELLED',
                cancellation: {
                  cancelledAt: '2026-09-28T01:00:00.000Z',
                  reason: 'Customer is ill',
                  byType: 'COMPANY_USER',
                  byId: 'cu-1',
                },
              }),
            ),
          ),
        );
      }
      return Promise.resolve(json(envelope(detail())));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<AppointmentDetail appointmentId="appt-1" />, { session: session(all) });

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('button', { name: 'Cancel appointment' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Reason (required)'), 'Customer is ill');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/cancel'));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ reason: 'Customer is ill' });
    });
  });
});
