import { PaymentProviderError } from '../../common/errors';
import { PaymentSigner } from './payment-signer';
import { QPayProvider } from './qpay.provider';

const config = {
  baseUrl: 'https://merchant-sandbox.qpay.mn',
  clientId: 'client',
  clientSecret: 'secret-value',
  invoiceCode: 'TEST_INVOICE',
};
const signer = new PaymentSigner('x'.repeat(40), 'https://api.example.mn');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers auth, then whatever the test queues. */
function fakeFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const fn = jest.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v2/auth/token')) {
      return Promise.resolve(json({ access_token: 'access-1', expires_in: 3600 }));
    }
    const next = queue.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected call'));
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('QPayProvider', () => {
  it('creates an invoice in major units with a signed callback, and maps the checkout', async () => {
    const { fn, calls } = fakeFetch(
      json({
        invoice_id: 'inv-1',
        qr_text: 'QR-TEXT',
        qr_image: 'iVBOR',
        qPay_shortUrl: 'https://qpay.mn/s/abc',
        urls: [
          {
            name: 'khanbank',
            description: 'Khan bank',
            link: 'khanbank://q?qPay_QRcode=x',
            logo: 'l',
          },
        ],
      }),
    );
    const provider = new QPayProvider(config, signer, fn);
    const callbackUrl = signer.callbackUrl('qpay', 'tx-1');

    const result = await provider.createPayment({
      transactionId: 'tx-1',
      idempotencyKey: 'tx-1',
      amountMinor: 3_500_050n,
      currencyCode: 'MNT',
      minorUnit: 2,
      description: 'Appointment',
      reference: 'A-0001',
      callbackUrl,
    });

    expect(result.providerTransactionId).toBe('inv-1');
    expect(result.status).toBe('PENDING');
    expect(result.checkout).toEqual({
      qrText: 'QR-TEXT',
      qrImage: 'data:image/png;base64,iVBOR',
      redirectUrl: 'https://qpay.mn/s/abc',
      deeplinks: [{ name: 'Khan bank', link: 'khanbank://q?qPay_QRcode=x', logo: 'l' }],
    });

    const [auth, create] = calls;
    expect(auth!.init.headers).toEqual({
      Authorization: `Basic ${Buffer.from('client:secret-value').toString('base64')}`,
    });
    expect(create!.url).toBe('https://merchant-sandbox.qpay.mn/v2/invoice');
    const body = JSON.parse(create!.init.body as string);
    expect(body).toMatchObject({
      invoice_code: 'TEST_INVOICE',
      sender_invoice_no: 'tx-1',
      amount: 35000.5,
      callback_url: callbackUrl,
    });
    expect((create!.init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('reports a PAID invoice as SUCCEEDED with the paid amount and fee in minor units', async () => {
    const { fn } = fakeFetch(
      json({
        count: 1,
        paid_amount: 35000,
        rows: [
          {
            payment_id: 777,
            payment_status: 'PAID',
            payment_amount: '35000.00',
            payment_fee: 350,
            payment_currency: 'MNT',
          },
        ],
      }),
    );
    const state = await new QPayProvider(config, signer, fn).getPayment('inv-1');
    expect(state).toEqual({
      status: 'SUCCEEDED',
      providerPaymentId: '777',
      paidAmountMinor: 3_500_000n,
      currencyCode: 'MNT',
      feeMinor: 35_000n,
    });
  });

  it('keeps a declined attempt PENDING, since the QR stays payable', async () => {
    const { fn } = fakeFetch(
      json({ count: 1, rows: [{ payment_id: 1, payment_status: 'FAILED' }] }),
    );
    const state = await new QPayProvider(config, signer, fn).getPayment('inv-1');
    expect(state.status).toBe('PENDING');
    expect(state.failureReason).toMatch(/declined/);
  });

  it('refunds whole payments only', async () => {
    const { fn, calls } = fakeFetch(json({}));
    const provider = new QPayProvider(config, signer, fn);
    const base = {
      providerTransactionId: 'inv-1',
      providerPaymentId: '777',
      paymentAmountMinor: 3_500_000n,
      currencyCode: 'MNT',
      minorUnit: 2,
      idempotencyKey: 'r1',
      reason: 'Customer cancelled',
    };

    expect(await provider.refundPayment({ ...base, amountMinor: 100n })).toMatchObject({
      status: 'FAILED',
    });
    expect(calls).toHaveLength(0);

    expect(await provider.refundPayment({ ...base, amountMinor: 3_500_000n })).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(calls[1]!.url).toBe('https://merchant-sandbox.qpay.mn/v2/payment/refund/777');
    expect(calls[1]!.init.method).toBe('DELETE');
  });

  it('turns an HTTP error into a generic provider error, without the body', async () => {
    const { fn } = fakeFetch(new Response('{"error":"ACCOUNT 123 BLOCKED"}', { status: 500 }));
    const error = await new QPayProvider(config, signer, fn)
      .getPayment('inv-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as Error).message).not.toMatch(/ACCOUNT/);
  });

  it('re-authenticates once on a 401', async () => {
    const { fn, calls } = fakeFetch(
      new Response('', { status: 401 }),
      json({ count: 0, rows: [] }),
    );
    await new QPayProvider(config, signer, fn).getPayment('inv-1');
    expect(calls.filter((c) => c.url.endsWith('/v2/auth/token'))).toHaveLength(2);
  });

  describe('verifyWebhook', () => {
    const provider = new QPayProvider(config, signer, fakeFetch().fn);
    const sig = signer.sign('webhook:qpay', 'tx-1');

    it('accepts our signed callback URL and keys the event on the payment', () => {
      const result = provider.verifyWebhook({
        headers: {},
        query: { tx: 'tx-1', sig, payment_id: '777' },
        rawBody: null,
        body: {},
      });
      expect(result).toMatchObject({ valid: true, transactionId: 'tx-1', eventKey: 'tx-1:777' });
    });

    it('rejects a missing or forged signature, and one for another transaction', () => {
      for (const query of [{ tx: 'tx-1' }, { tx: 'tx-1', sig: 'forged' }, { tx: 'tx-2', sig }]) {
        expect(provider.verifyWebhook({ headers: {}, query, rawBody: null, body: {} }).valid).toBe(
          false,
        );
      }
    });
  });
});

describe('PaymentSigner payment links', () => {
  const company = 'company-a';

  it('round-trips, and binds the token to its company', () => {
    const token = signer.issuePaymentLink(company, 'A-0001', 60_000);
    expect(signer.readPaymentLink(company, token)).toEqual({ appointmentNumber: 'A-0001' });
    expect(signer.readPaymentLink('company-b', token)).toBeNull();
  });

  it('carries no internal ids', () => {
    const token = signer.issuePaymentLink(company, 'A-0001', 60_000);
    const payload = Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8');
    expect(payload).not.toContain(company);
  });

  it('refuses expired, tampered and foreign-secret tokens', () => {
    const expired = signer.issuePaymentLink(company, 'A-0001', 1_000, Date.now() - 10_000);
    expect(signer.readPaymentLink(company, expired)).toBeNull();

    const [v, , sig] = signer.issuePaymentLink(company, 'A-0001', 60_000).split('.');
    const swapped = Buffer.from(JSON.stringify({ n: 'A-9999', e: 9_999_999_999 })).toString(
      'base64url',
    );
    expect(signer.readPaymentLink(company, `${v}.${swapped}.${sig}`)).toBeNull();

    const other = new PaymentSigner('y'.repeat(40), 'https://api.example.mn');
    expect(
      signer.readPaymentLink(company, other.issuePaymentLink(company, 'A-0001', 60_000)),
    ).toBeNull();
  });
});
