import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import type { Payment } from '@/services/billing.service';
import { RefundDialog } from './refund-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/payments',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const payment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'pay-1',
  paymentNumber: 'PAY-20261015-ABCDEF',
  method: 'CASH',
  purpose: 'BOOKING',
  status: 'SUCCEEDED',
  amountMinor: '5000000',
  feeMinor: '0',
  netMinor: '5000000',
  refundedMinor: '0',
  refundableMinor: '5000000',
  currencyCode: 'MNT',
  appointmentId: 'appt-1',
  appointmentNumber: 'A-1',
  customerId: 'cus-1',
  customerName: 'Sara Ochir',
  branchId: 'br-1',
  branchName: 'Main',
  provider: 'manual',
  providerReference: 'chg_abc',
  failureReason: null,
  createdAt: '2026-10-15T02:00:00.000Z',
  capturedAt: '2026-10-15T02:00:00.000Z',
  ...overrides,
});

const session = sessionWith({
  activeCompanyId: 'co-1',
  permissions: new Set(['payment:read', 'payment:refund']),
  user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
});

/**
 * The refund form is the one screen in this app that moves money the wrong way,
 * so its guardrails are worth pinning: the cap, the confirmation, and the
 * gift-card destination lock.
 */
describe('RefundDialog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(envelope(payment()))));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setup = (overrides: Partial<Payment> = {}) =>
    renderWithProviders(<RefundDialog payment={payment(overrides)} onClose={onClose} />, { session });

  it('defaults to the whole refundable amount, formatted from minor units', () => {
    setup();
    // 5000000 minor units at two places is 50000.00, not 5000000.
    expect(screen.getByLabelText(/Amount/)).toHaveValue('50000.00');
  });

  it('refuses more than is still refundable, without calling the API', async () => {
    const user = userEvent.setup();
    setup({ refundedMinor: '4000000', refundableMinor: '1000000' });

    const amount = screen.getByLabelText(/Amount/);
    await user.clear(amount);
    await user.type(amount, '50000');

    expect(await screen.findByText(/still refundable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a reason, because it goes on the audit trail', async () => {
    const user = userEvent.setup();
    setup();

    // A valid amount alone is not enough.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await user.type(screen.getByLabelText('Reason'), 'Service not performed');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('confirms the amount in words before anything is sent', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Reason'), 'Cancelled late');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // The step that catches "I meant 5,000 not 50,000".
    expect(await screen.findByText(/Refund .*50,000\.00\?/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends minor units, never a float', async () => {
    const user = userEvent.setup();
    setup();

    const amount = screen.getByLabelText(/Amount/);
    await user.clear(amount);
    await user.type(amount, '123.45');
    await user.type(screen.getByLabelText('Reason'), 'Partial');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: /^Refund/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.amountMinor).toBe('12345');
    expect(body.reason).toBe('Partial');
  });

  it('locks a gift-card payment to the card it came from', () => {
    // Handing cash over for a card somebody was given is a different
    // transaction, so the destination is not a choice here.
    setup({ method: 'GIFT_CARD' });

    const destination = screen.getByLabelText('Where it goes');
    expect(destination).toHaveValue('GIFT_CARD');
    expect(destination).toBeDisabled();
    expect(screen.getByText(/can only go back onto that card/i)).toBeInTheDocument();
  });

  it('shows the server’s refusal and keeps the form open', async () => {
    fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Only 1000000 is still refundable on this payment.',
              requestId: 'r',
            },
          },
          400,
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Reason'), 'Will be refused');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: /^Refund/ }));

    expect(await screen.findByText('Could not refund')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
