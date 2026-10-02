import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PublicBookingPage } from './public-booking-page';

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message = 'x', details?: unknown) =>
  json({ error: { code, message, details } }, status);

const company = {
  slug: 'lotus',
  name: 'Lotus Spa',
  locale: 'en-GB',
  currencyCode: 'MNT',
  branding: { primaryColor: '#0F6B63', accentColor: '#8A5A12', headline: 'Relax.', blurb: null },
  branches: [{ id: 'br-1', name: 'Downtown', address: 'Peace Ave 1', phone: '+97670000000', timezone: 'Asia/Ulaanbaatar' }],
};
const services = {
  categories: [{ id: 'cat-1', name: 'Massage' }],
  services: [
    {
      id: 'svc-1',
      name: 'Deep tissue',
      description: 'Firm pressure',
      durationMin: 60,
      priceMinor: '9000000',
      currencyCode: 'MNT',
      requiresEmployee: true,
      color: null,
      categoryId: 'cat-1',
    },
  ],
};
const employees = [{ id: 'emp-1', name: 'Ari', jobTitle: 'Therapist' }];
const slots = {
  date: '2026-10-06',
  timezone: 'Asia/Ulaanbaatar',
  durationMin: 60,
  unavailableReason: null,
  slots: [
    { startAt: '2026-10-06T10:00:00+08:00', endAt: '2026-10-06T11:00:00+08:00', employeeIds: ['emp-1'] },
    { startAt: '2026-10-06T11:00:00+08:00', endAt: '2026-10-06T12:00:00+08:00', employeeIds: ['emp-1'] },
  ],
};
const confirmation = {
  appointmentNumber: 'APT-20261006-ABC234',
  status: 'CONFIRMED',
  startsAt: '2026-10-06T10:00:00+08:00',
  endsAt: '2026-10-06T11:00:00+08:00',
  timezone: 'Asia/Ulaanbaatar',
  branch: { name: 'Downtown', address: 'Peace Ave 1', phone: '+97670000000' },
  service: { name: 'Deep tissue', durationMin: 60 },
  employee: null,
  price: { originalMinor: '9000000', discountMinor: '0', amountMinor: '9000000', currencyCode: 'MNT' },
  promotion: null,
  customer: { firstName: 'Nomin' },
};

function api(
  onBook: (body: unknown, init?: RequestInit) => Response,
  onPreview: (body: { code: string }) => Response = () => apiError(404, 'RESOURCE_NOT_FOUND'),
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/bookings')) return Promise.resolve(onBook(JSON.parse(String(init?.body)), init));
    if (url.endsWith('/promotions/validate')) {
      return Promise.resolve(onPreview(JSON.parse(String(init?.body)) as { code: string }));
    }
    if (url.includes('/availability')) return Promise.resolve(json(envelope(slots)));
    if (url.endsWith('/employees')) return Promise.resolve(json(envelope(employees)));
    if (url.endsWith('/services')) return Promise.resolve(json(envelope(services)));
    if (url.endsWith('/public/companies/lotus')) return Promise.resolve(json(envelope(company)));
    return Promise.resolve(apiError(404, 'TENANT_NOT_FOUND'));
  });
}

/** Walk to the details step: service → anyone → first time. */
async function reachDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Deep tissue/ }));
  await user.click(await screen.findByRole('button', { name: /Anyone available/ }));
  await user.click(await screen.findByRole('radio', { name: '10:00' }));
  await screen.findByRole('heading', { name: 'Your details' });
}

afterEach(() => vi.unstubAllGlobals());

describe('PublicBookingPage', () => {
  it('walks the whole flow and shows the server’s confirmation', async () => {
    let sent: { body: unknown; init?: RequestInit } | null = null;
    const fetchMock = api((body, init) => {
      sent = { body, init };
      return json(envelope(confirmation), 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);

    expect(await screen.findByRole('heading', { name: 'Lotus Spa' })).toBeInTheDocument();
    // One branch: straight to services, with price and duration shown.
    expect(await screen.findByText('60 min')).toBeInTheDocument();

    await reachDetails(user);

    // Client-side validation stops an obviously bad phone before any request.
    await user.type(screen.getByLabelText('First name'), 'Nomin');
    await user.type(screen.getByLabelText('Phone'), 'call me');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));
    expect(await screen.findByText('Enter a valid phone number.')).toBeInTheDocument();
    expect(sent).toBeNull();

    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '+976 9911 2233');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));

    expect(await screen.findByText(/You’re booked, Nomin/)).toBeInTheDocument();
    expect(screen.getByText('APT-20261006-ABC234')).toBeInTheDocument();

    // The exact server slot string went back, no employee (anyone), no token.
    const request = sent as unknown as { body: Record<string, unknown>; init?: RequestInit };
    expect(request.body).toMatchObject({
      branchId: 'br-1',
      serviceId: 'svc-1',
      startsAt: '2026-10-06T10:00:00+08:00',
      customer: { firstName: 'Nomin', phone: '+976 9911 2233' },
    });
    expect(request.body).not.toHaveProperty('employeeId');
    const headers = new Headers(request.init?.headers);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('sends the visitor back to pick another time when the slot was taken', async () => {
    vi.stubGlobal('fetch', api(() => apiError(409, 'SLOT_TAKEN')));
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);
    await reachDetails(user);
    await user.type(screen.getByLabelText('First name'), 'Nomin');
    await user.type(screen.getByLabelText('Phone'), '99112233');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));

    expect(await screen.findByText('That time was just taken')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose a date and time' })).toBeInTheDocument();
  });

  it('shows server-side field errors on the form', async () => {
    // The API's exception filter nests zod issues under `details.issues`.
    vi.stubGlobal(
      'fetch',
      api(() =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Request validation failed.',
              details: { issues: [{ path: 'customer.email', message: 'Server says no.' }] },
            },
          },
          400,
        ),
      ),
    );
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);
    await reachDetails(user);
    await user.type(screen.getByLabelText('First name'), 'Nomin');
    await user.type(screen.getByLabelText('Phone'), '99112233');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));

    expect(await screen.findByText('Server says no.')).toBeInTheDocument();
  });

  it('explains a failed booking without claiming success', async () => {
    vi.stubGlobal(
      'fetch',
      api(() => apiError(409, 'ONLINE_BOOKING_UNAVAILABLE', 'This booking cannot be made online. Please contact the business directly.')),
    );
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);
    await reachDetails(user);
    await user.type(screen.getByLabelText('First name'), 'Nomin');
    await user.type(screen.getByLabelText('Phone'), '99112233');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));

    expect(await screen.findByText('Not booked')).toBeInTheDocument();
    expect(screen.getByText(/contact the business directly/)).toBeInTheDocument();
    expect(screen.queryByText(/You’re booked/)).toBeNull();
  });

  it('previews a promotion code and books with it, showing the server’s prices', async () => {
    const preview = (valid: boolean) => ({
      valid,
      reason: valid ? null : 'INVALID_CODE',
      message: valid ? null : 'This code is not valid.',
      originalMinor: '9000000',
      discountMinor: valid ? '900000' : '0',
      finalMinor: valid ? '8100000' : '9000000',
      currencyCode: 'MNT',
      promotion: valid ? { name: 'Autumn', code: 'AUTUMN10' } : null,
    });
    let sent: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      api(
        (body) => {
          sent = body as Record<string, unknown>;
          return json(
            envelope({
              ...confirmation,
              price: { originalMinor: '9000000', discountMinor: '900000', amountMinor: '8100000', currencyCode: 'MNT' },
              promotion: { name: 'Autumn', code: 'AUTUMN10' },
            }),
            201,
          );
        },
        (body) => json(envelope(preview(body.code === 'AUTUMN10'))),
      ),
    );
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);
    await reachDetails(user);

    // A bad code is explained and not kept.
    await user.type(screen.getByLabelText('Promotion code'), 'NOPE');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('This code is not valid.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Promotion code'));
    await user.type(screen.getByLabelText('Promotion code'), 'AUTUMN10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Final price')).toBeInTheDocument();
    expect(screen.getByText(/Discount \(Autumn\)/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('First name'), 'Nomin');
    await user.type(screen.getByLabelText('Phone'), '99112233');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));

    expect(await screen.findByText(/You’re booked, Nomin/)).toBeInTheDocument();
    // Only the code goes up — never a price or a promotion id.
    expect(sent).toMatchObject({ promotionCode: 'AUTUMN10' });
    expect(sent).not.toHaveProperty('discountMinor');
    expect(sent).not.toHaveProperty('promotionId');
    expect(screen.getByText(/Discount \(AUTUMN10\)/)).toBeInTheDocument();
  });

  it('drops a code the server turns down at booking time', async () => {
    const valid = {
      valid: true,
      reason: null,
      message: null,
      originalMinor: '9000000',
      discountMinor: '900000',
      finalMinor: '8100000',
      currencyCode: 'MNT',
      promotion: { name: 'Autumn', code: 'AUTUMN10' },
    };
    vi.stubGlobal(
      'fetch',
      api(
        () => apiError(400, 'PROMOTION_NOT_APPLICABLE', 'This code has been used up.'),
        () => json(envelope(valid)),
      ),
    );
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);
    await reachDetails(user);
    await user.type(screen.getByLabelText('Promotion code'), 'AUTUMN10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Final price');
    await user.type(screen.getByLabelText('First name'), 'Nomin');
    await user.type(screen.getByLabelText('Phone'), '99112233');
    await user.click(screen.getByRole('button', { name: /Confirm booking/ }));

    expect(await screen.findByText(/This code has been used up/)).toBeInTheDocument();
    expect(screen.queryByText(/You’re booked/)).toBeNull();
    expect(screen.queryByText('Final price')).toBeNull();
    expect(screen.getByLabelText('Promotion code')).toHaveValue('');
  });

  it('says so when the booking page does not exist', async () => {
    vi.stubGlobal('fetch', api(() => json({})));
    renderWithProviders(<PublicBookingPage companySlug="nobody" />);
    expect(await screen.findByText('Booking page not found')).toBeInTheDocument();
  });

  it('shows why a day has no times', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/availability')) {
        return Promise.resolve(json(envelope({ ...slots, slots: [], unavailableReason: 'BRANCH_CLOSED' })));
      }
      return api(() => json({}))(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<PublicBookingPage companySlug="lotus" />);
    await user.click(await screen.findByRole('button', { name: /Deep tissue/ }));
    await user.click(await screen.findByRole('button', { name: /Anyone available/ }));

    await waitFor(() => expect(screen.getByText(/Closed on this day/)).toBeInTheDocument());
  });
});
