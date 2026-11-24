import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerSession } from '@/services/customer-api-client';
import type { PortalAppointmentDetail } from '@/services/customer-portal.service';
import { renderWithProviders } from '@/test/render';
import { PortalAppointment } from './portal-appointment';
import { PortalAppointments, PortalGiftCards, PortalProfile } from './portal-pages';
import { PortalShell } from './portal-shell';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/portal/nomin',
}));

const SLUG = 'nomin';
const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message = code, details?: object) =>
  json({ error: { code, message, details } }, status);

let fetchMock: ReturnType<typeof vi.fn>;
function route(handlers: Record<string, (url: URL, init: RequestInit) => Response>) {
  fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const handler = handlers[`${init.method ?? 'GET'} ${url.pathname}`];
    return Promise.resolve(handler ? handler(url, init) : apiError(500, 'UNEXPECTED'));
  });
  vi.stubGlobal('fetch', fetchMock);
}
const bodies = (method: string, path: string) =>
  fetchMock.mock.calls
    .filter(([input, init]) => new URL(input as string).pathname === path && (init as RequestInit)?.method === method)
    .map(([, init]) => JSON.parse(((init as RequestInit).body as string) ?? 'null') as unknown);

const profile = {
  firstName: 'Saraa',
  lastName: 'Dorj',
  email: 'saraa@example.com',
  phone: '+97699112233',
  locale: null,
  memberSince: '2026-01-01T00:00:00.000Z',
  company: { slug: SLUG, name: 'Nomin Spa', timezone: 'Asia/Ulaanbaatar', currencyCode: 'MNT' },
};

const allowed = { allowed: true, reason: null, message: null, deadline: '2026-11-01T02:00:00.000Z' };
const detail = (overrides: Partial<PortalAppointmentDetail> = {}): PortalAppointmentDetail => ({
  id: 'a-1',
  appointmentNumber: 'A-0001',
  status: 'CONFIRMED',
  startsAt: '2026-11-02T02:00:00.000Z',
  endsAt: '2026-11-02T03:00:00.000Z',
  timezone: 'Asia/Ulaanbaatar',
  service: 'Haircut',
  employee: 'Ari',
  totalMinor: '4500000',
  currencyCode: 'MNT',
  paymentStatus: 'UNPAID',
  branch: { name: 'Central', address: 'Peace Ave 1', phone: '+97611112222' },
  durationMin: 60,
  customerNote: null,
  cancelledAt: null,
  rescheduledFrom: null,
  price: { subtotalMinor: '5000000', discountMinor: '500000', totalMinor: '4500000', currencyCode: 'MNT' },
  promotions: [{ name: 'Autumn', code: 'FALL10', discountMinor: '500000' }],
  payment: {
    status: 'UNPAID',
    paidMinor: '0',
    refundedMinor: '0',
    outstandingMinor: '4500000',
    inProgress: false,
    payments: [],
  },
  actions: { cancel: allowed, reschedule: allowed },
  ...overrides,
});

let reset = 0;
beforeEach(() => {
  replace.mockReset();
  customerSession.use(`reset-${reset++}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const signedIn = () => customerSession.signIn(SLUG, 'customer-token', 900);

describe('PortalShell sign-in', () => {
  it('restores nothing without a session, then signs in with an emailed code', async () => {
    route({
      'POST /api/v1/customer/auth/nomin/refresh': () => apiError(401, 'SESSION_REVOKED'),
      'POST /api/v1/customer/auth/nomin/request-code': () => json(envelope({ sent: true, expiresInSeconds: 600 }), 202),
      'POST /api/v1/customer/auth/nomin/verify': () =>
        json(envelope({ accessToken: 'customer-token', tokenType: 'Bearer', expiresIn: 900 })),
      'GET /api/v1/customer/me': () => json(envelope(profile)),
    });
    renderWithProviders(
      <PortalShell slug={SLUG}>
        <p>portal content</p>
      </PortalShell>,
    );

    await userEvent.type(await screen.findByLabelText('Email'), 'Saraa@Example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(bodies('POST', '/api/v1/customer/auth/nomin/request-code')).toEqual([{ email: 'saraa@example.com' }]);

    await userEvent.type(await screen.findByLabelText('Code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('portal content')).toBeInTheDocument();
    expect(await screen.findByText('Nomin Spa')).toBeInTheDocument();
    // The access token rides on portal calls.
    const me = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/customer/me'));
    expect(new Headers((me![1] as RequestInit).headers).get('authorization')).toBe('Bearer customer-token');
    expect(screen.getByRole('link', { name: 'Book an appointment' })).toHaveAttribute('href', '/book/nomin');
  });

  it('says so when the code is wrong', async () => {
    route({
      'POST /api/v1/customer/auth/nomin/refresh': () => apiError(401, 'SESSION_REVOKED'),
      'POST /api/v1/customer/auth/nomin/request-code': () => json(envelope({ sent: true, expiresInSeconds: 600 }), 202),
      'POST /api/v1/customer/auth/nomin/verify': () => apiError(401, 'SIGN_IN_CODE_INVALID'),
    });
    renderWithProviders(
      <PortalShell slug={SLUG}>
        <p>portal content</p>
      </PortalShell>,
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'saraa@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not valid or has expired');
    expect(screen.queryByText('portal content')).not.toBeInTheDocument();
  });

  it('restores a session from the refresh cookie on reload', async () => {
    route({
      'POST /api/v1/customer/auth/nomin/refresh': () =>
        json(envelope({ accessToken: 'restored', tokenType: 'Bearer', expiresIn: 900 })),
      'GET /api/v1/customer/me': () => json(envelope(profile)),
    });
    renderWithProviders(
      <PortalShell slug={SLUG}>
        <p>portal content</p>
      </PortalShell>,
    );
    expect(await screen.findByText('portal content')).toBeInTheDocument();
    const refresh = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/refresh'));
    expect((refresh![1] as RequestInit).credentials).toBe('include');
  });
});

describe('PortalAppointment', () => {
  it('shows details, discounts and payment, and the actions the server allows', async () => {
    signedIn();
    route({ 'GET /api/v1/customer/appointments/a-1': () => json(envelope(detail())) });
    renderWithProviders(<PortalAppointment slug={SLUG} id="a-1" />);

    expect(await screen.findByRole('heading', { name: 'Haircut' })).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Discount — Autumn (FALL10)')).toBeInTheDocument();
    expect(screen.getByText('Not paid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
  });

  it('gives the change deadline in the business timezone, not the browser’s', async () => {
    const browserTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      signedIn();
      route({ 'GET /api/v1/customer/appointments/a-1': () => json(envelope(detail())) });
      renderWithProviders(<PortalAppointment slug={SLUG} id="a-1" />);

      // 02:00Z is 10:00 in Ulaanbaatar — and 21:00 the evening before in New York.
      expect(await screen.findByText(/online until Sun, Nov 1, 2026, 10:00 AM/)).toBeInTheDocument();
    } finally {
      process.env.TZ = browserTz;
    }
  });

  it('hides actions the server refuses, and says why', async () => {
    signedIn();
    const refused = {
      allowed: false,
      reason: 'PAST_DEADLINE' as const,
      message: 'Appointments can be cancelled online until 24 hours before they start.',
      deadline: null,
    };
    route({
      'GET /api/v1/customer/appointments/a-1': () =>
        json(envelope(detail({ actions: { cancel: refused, reschedule: { ...refused, message: 'Rescheduling closed.' } } }))),
    });
    renderWithProviders(<PortalAppointment slug={SLUG} id="a-1" />);

    expect(await screen.findByText(/until 24 hours before/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel appointment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
  });

  it('cancels behind a confirmation', async () => {
    signedIn();
    let cancelled = false;
    route({
      'GET /api/v1/customer/appointments/a-1': () =>
        json(envelope(detail(cancelled ? { status: 'CANCELLED' } : {}))),
      'POST /api/v1/customer/appointments/a-1/cancel': () => {
        cancelled = true;
        return json(envelope(detail({ status: 'CANCELLED' })));
      },
    });
    renderWithProviders(<PortalAppointment slug={SLUG} id="a-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'Sick');
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    await waitFor(() => expect(bodies('POST', '/api/v1/customer/appointments/a-1/cancel')).toEqual([{ reason: 'Sick' }]));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('shows the server’s refusal when cancelling fails', async () => {
    signedIn();
    route({
      'GET /api/v1/customer/appointments/a-1': () => json(envelope(detail())),
      'POST /api/v1/customer/appointments/a-1/cancel': () =>
        apiError(409, 'CUSTOMER_ACTION_NOT_ALLOWED', 'The deadline to cancel this appointment online has passed.', {
          reason: 'PAST_DEADLINE',
        }),
    });
    renderWithProviders(<PortalAppointment slug={SLUG} id="a-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('deadline to cancel');
  });

  it('reschedules to an offered time and opens the moved booking', async () => {
    signedIn();
    route({
      'GET /api/v1/customer/appointments/a-1': () => json(envelope(detail())),
      'GET /api/v1/customer/appointments/a-1/reschedule-options': () =>
        json(
          envelope({
            date: '2026-11-03',
            timezone: 'Asia/Ulaanbaatar',
            unavailableReason: null,
            slots: [{ startAt: '2026-11-03T02:00:00.000Z', endAt: '2026-11-03T03:00:00.000Z' }],
          }),
        ),
      'POST /api/v1/customer/appointments/a-1/reschedule': () => json(envelope(detail({ id: 'a-2' }))),
    });
    renderWithProviders(<PortalAppointment slug={SLUG} id="a-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    await userEvent.click(await screen.findByRole('button', { name: /10:00/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Move to/ }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/portal/nomin/appointments/a-2'));
    expect(bodies('POST', '/api/v1/customer/appointments/a-1/reschedule')).toEqual([
      { startsAt: '2026-11-03T02:00:00.000Z' },
    ]);
  });

  it('treats someone else’s appointment as not found', async () => {
    signedIn();
    route({ 'GET /api/v1/customer/appointments/a-9': () => apiError(404, 'RESOURCE_NOT_FOUND') });
    renderWithProviders(<PortalAppointment slug={SLUG} id="a-9" />);
    expect(await screen.findByText('Appointment not found')).toBeInTheDocument();
  });
});

describe('PortalAppointments', () => {
  it('switches tabs, pages, and shows empty states', async () => {
    signedIn();
    const item = (n: number) => ({ ...detail(), id: `a-${n}`, appointmentNumber: `A-${n}`, branch: 'Central' });
    route({
      'GET /api/v1/customer/appointments': (url) => {
        const scope = url.searchParams.get('scope');
        const offset = Number(url.searchParams.get('offset'));
        if (scope === 'cancelled') return json(envelope({ items: [], total: 0, limit: 10, offset: 0 }));
        return json(envelope({ items: [item(offset + 1)], total: 12, limit: 10, offset }));
      },
    });
    renderWithProviders(<PortalAppointments slug={SLUG} />);

    expect(await screen.findByText('1–10 of 12')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('11–12 of 12')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(await screen.findByText('No cancelled appointments.')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    signedIn();
    route({ 'GET /api/v1/customer/appointments': () => apiError(500, 'INTERNAL_ERROR') });
    renderWithProviders(<PortalAppointments slug={SLUG} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your appointments');
  });
});

describe('PortalGiftCards', () => {
  it('shows the holder’s balance and history, and not a gifted card’s balance', async () => {
    signedIn();
    route({
      'GET /api/v1/customer/gift-cards': () =>
        json(
          envelope({
            items: [
              { id: 'g-1', codeLast4: '1234', status: 'ACTIVE', relation: 'HOLDER', currencyCode: 'MNT', initialBalanceMinor: '5000000', balanceMinor: '3000000', recipientName: null, issuedAt: null, expiresAt: null },
              { id: 'g-2', codeLast4: '9876', status: 'ACTIVE', relation: 'PURCHASER', currencyCode: 'MNT', initialBalanceMinor: '2000000', balanceMinor: null, recipientName: 'Bolor', issuedAt: null, expiresAt: null },
            ],
          }),
        ),
      'GET /api/v1/customer/gift-cards/g-1/transactions': () =>
        json(
          envelope({
            giftCard: { id: 'g-1', codeLast4: '1234', status: 'ACTIVE', currencyCode: 'MNT', balanceMinor: '3000000', expiresAt: null },
            items: [{ id: 't-1', type: 'REDEEM', amountMinor: '-2000000', balanceAfterMinor: '3000000', currencyCode: 'MNT', occurredAt: '2026-10-01T00:00:00.000Z', appointmentNumber: 'A-0001' }],
            total: 1,
            limit: 10,
            offset: 0,
          }),
        ),
    });
    renderWithProviders(<PortalGiftCards slug={SLUG} />);

    expect(await screen.findByText(/30,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/for Bolor\. Its balance is theirs to see\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(await screen.findByText(/Used · A-0001/)).toBeInTheDocument();
  });
});

describe('PortalProfile', () => {
  it('validates, saves, and shows a conflict on the phone field', async () => {
    signedIn();
    let saves = 0;
    route({
      'GET /api/v1/customer/me': () => json(envelope(profile)),
      'PATCH /api/v1/customer/me': () => {
        saves += 1;
        return saves === 1
          ? json(envelope({ ...profile, firstName: 'Sarnai' }))
          : apiError(409, 'CONFLICT', 'That phone number is already in use here.');
      },
    });
    renderWithProviders(<PortalProfile slug={SLUG} />);

    const first = await screen.findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter your first name.')).toBeInTheDocument();
    expect(saves).toBe(0);

    await userEvent.type(first, 'Sarnai');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Your details were saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That phone number is already in use here.')).toBeInTheDocument();
  });
});
