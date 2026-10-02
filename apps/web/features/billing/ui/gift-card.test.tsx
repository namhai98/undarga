import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { CustomerGiftCards } from './customer-gift-cards';
import { GiftCardDetail } from './gift-card-detail';
import { GiftCardList } from './gift-card-list';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/gift-cards',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, details } }, status);

const card = (overrides: Record<string, unknown> = {}) => ({
  id: 'gc-1',
  last4: 'PQRS',
  status: 'ACTIVE',
  initialBalanceMinor: '10000000',
  currentBalanceMinor: '6000000',
  currencyCode: 'MNT',
  isRedeemable: true,
  problem: null,
  branchId: null,
  issuedToCustomerId: 'cus-1',
  issuedToName: 'Sara Ochir',
  purchasedByCustomerId: null,
  purchasedByName: null,
  recipientName: null,
  recipientEmail: null,
  message: null,
  issuedAt: '2026-09-01T02:00:00.000Z',
  expiresAt: '2027-09-01T15:59:59.999Z',
  depletedAt: null,
  disabledAt: null,
  disabledReason: null,
  createdAt: '2026-09-01T02:00:00.000Z',
  updatedAt: '2026-09-01T02:00:00.000Z',
  ...overrides,
});

const row = (overrides: Record<string, unknown>) => ({
  id: 'tx-1',
  type: 'ISSUE',
  amountMinor: '10000000',
  balanceAfterMinor: '10000000',
  currencyCode: 'MNT',
  appointmentId: null,
  paymentId: null,
  reversesTransactionId: null,
  reason: null,
  performedByType: 'COMPANY_USER',
  occurredAt: '2026-09-01T02:00:00.000Z',
  refundedMinor: null,
  refundableMinor: null,
  ...overrides,
});

const ledger = [
  row({
    id: 'tx-2',
    type: 'REDEEM',
    amountMinor: '-4000000',
    balanceAfterMinor: '6000000',
    reason: 'Haircut',
    occurredAt: '2026-09-02T02:00:00.000Z',
    refundedMinor: '0',
    refundableMinor: '4000000',
  }),
  row({ id: 'tx-1' }),
];

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

type Handler = (url: URL, init?: RequestInit) => Response | undefined;

/** Routes by path; anything unhandled is a 404 so a stray request fails loudly. */
function api(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const handled = handler(url, init);
    if (handled) return Promise.resolve(handled);
    if (url.pathname.endsWith('/companies/co-1')) {
      return Promise.resolve(json(envelope({ id: 'co-1', currencyCode: 'MNT', name: 'Lotus' })));
    }
    return Promise.resolve(apiError(404, 'RESOURCE_NOT_FOUND', 'Not found'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

// =============================================================================
describe('GiftCardList', () => {
  it('shows each card with its customer, balance and status, linked to its page', async () => {
    api((url) =>
      url.pathname.endsWith('/gift-cards')
        ? json(envelope({ items: [card()], total: 1, limit: 25, offset: 0 }))
        : undefined,
    );

    renderWithProviders(<GiftCardList />, { session: session(['giftcard:read']) });

    const link = await screen.findByRole('link', { name: '••••-PQRS' });
    expect(link).toHaveAttribute('href', '/gift-cards/gc-1');
    const tableRow = link.closest('tr')!;
    expect(within(tableRow).getByText('Sara Ochir')).toBeInTheDocument();
    expect(within(tableRow).getByText('Active')).toBeInTheDocument();
    // No issue button without the permission.
    expect(screen.queryByRole('button', { name: 'Issue a card' })).toBeNull();
  });

  it('searches by code or customer and filters by status on the server', async () => {
    const fetchMock = api((url) =>
      url.pathname.endsWith('/gift-cards')
        ? json(envelope({ items: [], total: 0, limit: 25, offset: 0 }))
        : undefined,
    );
    const user = userEvent.setup();

    renderWithProviders(<GiftCardList />, { session: session(['giftcard:read']) });
    await screen.findByText('No gift cards');

    await user.type(screen.getByLabelText('Search'), 'Sara');
    await user.selectOptions(screen.getByLabelText('Status'), 'DISABLED');

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(
        ([input]) => new URL(String(input), 'http://localhost'),
      );
      expect(
        urls.some(
          (u) =>
            u.pathname.endsWith('/gift-cards') &&
            u.searchParams.get('search') === 'Sara' &&
            u.searchParams.get('status') === 'DISABLED',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText('No matching gift cards')).toBeInTheDocument();
  });

  it('issues a card for a chosen customer and shows the code once', async () => {
    let issued: Record<string, unknown> | null = null;
    api((url, init) => {
      if (url.pathname.endsWith('/gift-cards') && init?.method === 'POST') {
        issued = bodyOf(init);
        return json(envelope({ ...card(), code: 'ABCD-EFGH-JKMN-PQRS' }), 201);
      }
      if (url.pathname.endsWith('/gift-cards')) {
        return json(envelope({ items: [], total: 0, limit: 25, offset: 0 }));
      }
      if (url.pathname.endsWith('/customers')) {
        return json(
          envelope({
            items: [{ id: 'cus-1', fullName: 'Sara Ochir', phone: '+97699112233' }],
            total: 1,
            limit: 6,
            offset: 0,
          }),
        );
      }
      return undefined;
    });
    const user = userEvent.setup();

    renderWithProviders(<GiftCardList />, {
      session: session(['giftcard:read', 'giftcard:issue', 'customer:read']),
    });
    await user.click(await screen.findByRole('button', { name: 'Issue a card' }));
    await user.type(screen.getByLabelText('Initial balance (MNT)'), '50000');
    await user.type(screen.getByLabelText('Customer'), 'Sara');
    await user.click(await screen.findByRole('button', { name: /Sara Ochir/ }));
    await user.click(screen.getByRole('button', { name: 'Issue' }));

    expect(await screen.findByText('ABCD-EFGH-JKMN-PQRS')).toBeInTheDocument();
    expect(issued).toEqual({ initialBalanceMinor: '5000000', issuedToCustomerId: 'cus-1' });
  });
});

// =============================================================================
describe('GiftCardDetail', () => {
  function detailApi(current: Record<string, unknown>, onPost?: Handler) {
    return api((url, init) => {
      if (init?.method === 'POST' || init?.method === 'PATCH') return onPost?.(url, init);
      if (url.pathname.endsWith('/gift-cards/gc-1')) return json(envelope(current));
      if (url.pathname.endsWith('/gift-cards/gc-1/transactions')) {
        return json(envelope({ items: ledger, total: ledger.length, limit: 20, offset: 0 }));
      }
      return undefined;
    });
  }

  it('shows initial and current balance, currency, status, expiry and customer', async () => {
    detailApi(card());
    renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read']),
    });

    await screen.findByRole('heading', { name: /Gift card/ });
    const term = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!;
    expect(term('Initial balance')).toHaveTextContent('100,000');
    expect(term('Current balance')).toHaveTextContent('60,000');
    expect(term('Currency')).toHaveTextContent('MNT');
    expect(term('Status')).toHaveTextContent('Active');
    expect(term('Expiry')).not.toHaveTextContent('Never');
    expect(
      within(term('Customer') as HTMLElement).getByRole('link', { name: 'Sara Ochir' }),
    ).toHaveAttribute('href', '/customers/cus-1');

    // The ledger, newest first, with signed amounts.
    expect(await screen.findByRole('cell', { name: 'Redeemed' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Issued' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /^−MNT\s40,000\.00$/ })).toBeInTheDocument();

    // Read-only: no actions at all.
    for (const name of ['Redeem', 'Edit', 'Disable', 'Void', 'Refund']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('disables with a reason, keeping the balance', async () => {
    let sent: Record<string, unknown> | null = null;
    detailApi(card(), (url, init) => {
      if (url.pathname.endsWith('/disable')) {
        sent = bodyOf(init);
        return json(envelope(card({ status: 'DISABLED', disabledReason: 'Reported lost' })));
      }
      return undefined;
    });
    const user = userEvent.setup();

    renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read', 'giftcard:issue']),
    });
    await user.click(await screen.findByRole('button', { name: 'Disable' }));
    const confirm = screen.getAllByRole('button', { name: 'Disable' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Reported lost');
    await user.click(confirm);

    expect(await screen.findByText('Card disabled. Its balance is kept.')).toBeInTheDocument();
    expect(sent).toEqual({ reason: 'Reported lost' });
  });

  it('redeems with one idempotency key per attempt, reused on a retry', async () => {
    const keys: string[] = [];
    let calls = 0;
    detailApi(card(), (url, init) => {
      if (!url.pathname.endsWith('/redeem')) return undefined;
      const body = bodyOf(init);
      keys.push(String(body['idempotencyKey']));
      calls += 1;
      expect(body['amountMinor']).toBe('1500000');
      // The first attempt fails as a network-ish error; the retry succeeds.
      if (calls === 1) return apiError(503, 'SERVICE_UNAVAILABLE', 'Try again');
      return json(
        envelope({
          transactionId: 'tx-9',
          replayed: false,
          card: card({ currentBalanceMinor: '4500000' }),
        }),
      );
    });
    const user = userEvent.setup();

    renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read', 'giftcard:redeem']),
    });
    await user.click(await screen.findByRole('button', { name: 'Redeem' }));
    await user.type(screen.getByLabelText('Amount (MNT)'), '15000');
    const submit = screen.getAllByRole('button', { name: 'Redeem' }).at(-1)!;
    await user.click(submit);
    expect(await screen.findByText('Could not redeem the card.')).toBeInTheDocument();

    await user.click(submit);
    expect(await screen.findByText(/Balance now/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('explains why a redemption was refused', async () => {
    detailApi(card(), (url) =>
      url.pathname.endsWith('/redeem')
        ? apiError(
            400,
            'GIFT_CARD_NOT_USABLE',
            'That card holds 60000 and the redemption is 9000000.',
            {
              reason: 'INSUFFICIENT_BALANCE',
            },
          )
        : undefined,
    );
    const user = userEvent.setup();

    renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read', 'giftcard:redeem']),
    });
    await user.click(await screen.findByRole('button', { name: 'Redeem' }));
    await user.type(screen.getByLabelText('Amount (MNT)'), '90000');
    await user.click(screen.getAllByRole('button', { name: 'Redeem' }).at(-1)!);

    expect(await screen.findByText(/That card holds 60000/)).toBeInTheDocument();
  });

  it('refunds a redemption from its ledger row', async () => {
    let sent: Record<string, unknown> | null = null;
    detailApi(card(), (url, init) => {
      if (!url.pathname.endsWith('/refund')) return undefined;
      sent = bodyOf(init);
      return json(
        envelope({
          transactionId: 'tx-3',
          replayed: false,
          card: card({ currentBalanceMinor: '10000000' }),
        }),
      );
    });
    const user = userEvent.setup();

    renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read', 'giftcard:redeem']),
    });
    // Only the REDEEM row offers a refund.
    const refunds = await screen.findAllByRole('button', { name: 'Refund' });
    expect(refunds).toHaveLength(1);
    await user.click(refunds[0]!);
    await user.type(screen.getByLabelText('Reason'), 'Service cancelled');
    await user.click(screen.getAllByRole('button', { name: 'Refund' }).at(0)!);

    expect(await screen.findByText(/Refunded to the card/)).toBeInTheDocument();
    expect(sent).toMatchObject({ transactionId: 'tx-2', reason: 'Service cancelled' });
    expect(sent).not.toHaveProperty('amountMinor');
  });

  it('offers re-enable only to someone who may adjust', async () => {
    detailApi(
      card({ status: 'DISABLED', isRedeemable: false, problem: 'That card has been disabled.' }),
    );

    const { unmount } = renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read', 'giftcard:issue', 'giftcard:redeem']),
    });
    expect(await screen.findByText('That card has been disabled.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-enable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redeem' })).toBeNull();
    unmount();

    renderWithProviders(<GiftCardDetail giftCardId="gc-1" />, {
      session: session(['giftcard:read', 'giftcard:adjust']),
    });
    expect(await screen.findByRole('button', { name: 'Re-enable' })).toBeInTheDocument();
  });

  it('says so when the card is not found', async () => {
    api(() => undefined);
    renderWithProviders(<GiftCardDetail giftCardId="gc-404" />, {
      session: session(['giftcard:read']),
    });
    expect(await screen.findByText('Gift card not found')).toBeInTheDocument();
  });
});

// =============================================================================
describe('CustomerGiftCards', () => {
  it('lists only this customer’s cards', async () => {
    const fetchMock = api((url) => {
      if (url.pathname.endsWith('/gift-cards')) {
        return json(envelope({ items: [card()], total: 1, limit: 50, offset: 0 }));
      }
      if (url.pathname.endsWith('/customers/cus-1')) {
        return json(envelope({ id: 'cus-1', fullName: 'Sara Ochir' }));
      }
      return undefined;
    });

    renderWithProviders(<CustomerGiftCards customerId="cus-1" />, {
      session: session(['giftcard:read', 'customer:read']),
    });

    expect(await screen.findByRole('link', { name: '••••-PQRS' })).toBeInTheDocument();
    const listCall = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://localhost'))
      .find((u) => u.pathname.endsWith('/gift-cards'))!;
    expect(listCall.searchParams.get('issuedToCustomerId')).toBe('cus-1');
  });

  it('renders nothing, and asks for nothing, without gift-card access', async () => {
    const fetchMock = api(() => undefined);
    const { container } = renderWithProviders(<CustomerGiftCards customerId="cus-1" />, {
      session: session(['customer:read']),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/gift-cards'))).toBe(
      false,
    );
  });
});
