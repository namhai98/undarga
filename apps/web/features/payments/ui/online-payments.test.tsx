import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import type { OnlinePayment } from '@/services/online-payments.service';
import { OnlineCheckout } from './online-checkout';
import {
  AppointmentOnlinePayment,
  InvoiceOnlinePayment,
  PublicBookingPayment,
} from './online-payment-flows';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/appointments/a-1',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message = code) =>
  json({ error: { code, message } }, status);

const session = sessionWith({
  activeCompanyId: 'co-1',
  permissions: new Set(['payment:read', 'payment:write', 'payment:refund', 'settings:billing:write']),
  user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
});

const payment = (overrides: Partial<OnlinePayment> = {}): OnlinePayment => ({
  id: 'tx-1',
  kind: 'APPOINTMENT',
  status: 'PENDING',
  purpose: 'BOOKING',
  reference: 'A-0001',
  amountMinor: '3500000',
  refundedMinor: '0',
  feeMinor: '0',
  currencyCode: 'MNT',
  provider: 'qpay',
  checkout: {
    qrImage: 'data:image/png;base64,iVBOR',
    qrText: 'QR',
    redirectUrl: 'https://qpay.mn/s/abc',
    deeplinks: [{ name: 'Khan bank', link: 'khanbank://pay?x=1', logo: null }],
  },
  expiresAt: null,
  failureReason: null,
  retryable: false,
  createdAt: '2026-10-09T00:00:00.000Z',
  succeededAt: null,
  appointmentId: 'a-1',
  subscriptionInvoiceId: null,
  paymentId: null,
  providerReference: 'inv-1',
  failedAt: null,
  cancelledAt: null,
  refundedAt: null,
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;

function route(handlers: Record<string, (url: URL, init: RequestInit) => Response>) {
  fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const handler = handlers[`${init.method ?? 'GET'} ${url.pathname}`];
    return Promise.resolve(handler ? handler(url, init) : apiError(500, 'UNEXPECTED'));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const posted = (path: string) =>
  fetchMock.mock.calls
    .filter(([input, init]) => new URL(input as string).pathname === path && (init as RequestInit)?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OnlineCheckout', () => {
  it('shows the amount, currency, status and how to pay while waiting', () => {
    renderWithProviders(<OnlineCheckout payment={payment()} />);

    expect(screen.getByText(/35,000\.00/)).toBeInTheDocument();
    expect(screen.getByText('MNT · A-0001')).toBeInTheDocument();
    expect(screen.getByText('Waiting for payment')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('updates by itself');
    expect(screen.getByAltText('QR code to scan with a banking app')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBOR',
    );
    expect(screen.getByRole('link', { name: 'Khan bank' })).toHaveAttribute('href', 'khanbank://pay?x=1');
    expect(screen.getByRole('link', { name: /Open the payment page/ })).toHaveAttribute(
      'href',
      'https://qpay.mn/s/abc',
    );
    // The simulator controls appear only for the simulator.
    expect(screen.queryByRole('button', { name: 'Simulate payment' })).not.toBeInTheDocument();
  });

  it('confirms success and hides the checkout', () => {
    renderWithProviders(
      <OnlineCheckout payment={payment({ status: 'SUCCEEDED', checkout: null })} successMessage="Done." />,
    );
    expect(screen.getByText('Paid', { selector: '[data-slot="alert-title"], div' })).toBeInTheDocument();
    expect(screen.queryByAltText('QR code to scan with a banking app')).not.toBeInTheDocument();
  });

  it('explains a failure and offers a retry', async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <OnlineCheckout
        payment={payment({ status: 'FAILED', checkout: null, retryable: true, failureReason: 'Card declined.' })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The payment failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Card declined.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('offers the simulator controls in development', async () => {
    const onSimulate = vi.fn();
    renderWithProviders(
      <OnlineCheckout payment={payment({ checkout: { simulated: true } })} onSimulate={onSimulate} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Simulate decline' }));
    expect(onSimulate).toHaveBeenCalledWith('FAILED');
  });
});

describe('AppointmentOnlinePayment', () => {
  it('starts a checkout and shows Paid only when the server says so', async () => {
    route({
      'POST /api/v1/payments': () => json(envelope(payment()), 201),
      'GET /api/v1/payments/tx-1': () =>
        json(envelope(payment({ status: 'SUCCEEDED', checkout: null, paymentId: 'p-1' }))),
    });
    renderWithProviders(<AppointmentOnlinePayment appointmentId="a-1" />, { session });

    await userEvent.click(screen.getByRole('button', { name: /Collect online payment/ }));

    expect(await screen.findByText('The appointment has been updated.')).toBeInTheDocument();
    const [body] = posted('/api/v1/payments');
    expect(body).toMatchObject({ appointmentId: 'a-1' });
    expect(body!.idempotencyKey).toMatch(/^ui-/);
    // The browser never sends a status.
    expect(body).not.toHaveProperty('status');
  });

  it('says so when the provider is unavailable', async () => {
    route({
      'POST /api/v1/payments': () => apiError(502, 'PAYMENT_PROVIDER_ERROR', 'internal detail'),
    });
    renderWithProviders(<AppointmentOnlinePayment appointmentId="a-1" />, { session });

    await userEvent.click(screen.getByRole('button', { name: /Collect online payment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not respond');
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
  });

  it('retries a failed payment with a new idempotency key', async () => {
    let starts = 0;
    route({
      'POST /api/v1/payments': () => {
        starts += 1;
        return json(envelope(payment({ id: `tx-${starts}` })), 201);
      },
      'GET /api/v1/payments/tx-1': () =>
        json(envelope(payment({ id: 'tx-1', status: 'FAILED', checkout: null, retryable: true }))),
      'GET /api/v1/payments/tx-2': () => json(envelope(payment({ id: 'tx-2' }))),
    });
    renderWithProviders(<AppointmentOnlinePayment appointmentId="a-1" />, { session });

    await userEvent.click(screen.getByRole('button', { name: /Collect online payment/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(posted('/api/v1/payments')).toHaveLength(2));
    const [first, second] = posted('/api/v1/payments');
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it('refunds with a reason, behind a confirmation', async () => {
    route({
      'POST /api/v1/payments': () => json(envelope(payment()), 201),
      'GET /api/v1/payments/tx-1': () => json(envelope(payment({ status: 'SUCCEEDED', checkout: null }))),
      'POST /api/v1/payments/tx-1/refund': () =>
        json(envelope(payment({ status: 'REFUNDED', checkout: null, refundedMinor: '3500000' }))),
    });
    renderWithProviders(<AppointmentOnlinePayment appointmentId="a-1" canRefund />, { session });

    await userEvent.click(screen.getByRole('button', { name: /Collect online payment/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Refund' }));
    const confirm = screen.getByRole('button', { name: 'Confirm refund' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Customer cancelled');
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(posted('/api/v1/payments/tx-1/refund')).toEqual([{ reason: 'Customer cancelled' }]),
    );
  });
});

describe('InvoiceOnlinePayment', () => {
  it('pays the open invoice through the billing endpoint', async () => {
    route({
      'POST /api/v1/companies/co-1/billing/inv-1/pay': () =>
        json(envelope(payment({ kind: 'SUBSCRIPTION_INVOICE', reference: 'INV-202610-0001' })), 201),
      'GET /api/v1/payments/tx-1': () =>
        json(envelope(payment({ kind: 'SUBSCRIPTION_INVOICE', reference: 'INV-202610-0001' }))),
    });
    renderWithProviders(
      <InvoiceOnlinePayment
        invoiceId="inv-1"
        invoiceNumber="INV-202610-0001"
        amountMinor="9900000"
        currencyCode="MNT"
      />,
      { session },
    );

    await userEvent.click(screen.getByRole('button', { name: /Pay INV-202610-0001/ }));
    expect(await screen.findByText('Waiting for payment')).toBeInTheDocument();
    expect(posted('/api/v1/companies/co-1/billing/inv-1/pay')[0]!.idempotencyKey).toMatch(/^ui-/);
  });
});

describe('PublicBookingPayment', () => {
  it('pays with the confirmation token and shows the outcome', async () => {
    route({
      'POST /api/v1/public/companies/nomin/payments': () => json(envelope(payment()), 201),
      'GET /api/v1/public/companies/nomin/payments/tx-1': (url) => {
        expect(url.searchParams.get('token')).toBe('v1.payload.sig');
        return json(envelope(payment({ status: 'SUCCEEDED', checkout: null })));
      },
    });
    renderWithProviders(
      <PublicBookingPayment
        slug="nomin"
        offer={{ token: 'v1.payload.sig', amountMinor: '3500000', currencyCode: 'MNT', purpose: 'BOOKING' }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Pay .*35,000\.00/ }));

    expect(await screen.findByText('Your payment was received. See you soon.')).toBeInTheDocument();
    expect(posted('/api/v1/public/companies/nomin/payments')[0]).toMatchObject({
      paymentToken: 'v1.payload.sig',
    });
  });

  it('labels a deposit', () => {
    renderWithProviders(
      <PublicBookingPayment
        slug="nomin"
        offer={{ token: 't', amountMinor: '250000', currencyCode: 'MNT', purpose: 'DEPOSIT' }}
      />,
    );
    expect(screen.getByText('Pay the deposit now')).toBeInTheDocument();
  });
});
