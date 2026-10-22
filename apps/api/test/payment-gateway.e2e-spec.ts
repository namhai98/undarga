import request from 'supertest';
import type { Server } from 'node:http';
import { MockPaymentProvider } from '../src/payments/gateway/mock.provider';
import { PAYMENT_GATEWAY_PROVIDERS } from '../src/payments/gateway/payment-provider';
import { PaymentSigner } from '../src/payments/gateway/payment-signer';
import { PaymentTransactionsService } from '../src/payments/payment-transactions.service';
import { EntitlementsService } from '../src/subscriptions/entitlements.service';
import { syncPlanCatalog } from '../src/subscriptions/plan-catalog';
import { TenantDirectoryService } from '../src/tenancy/directory/tenant-directory.service';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * ONLINE PAYMENTS THROUGH A PROVIDER
 * ===========================================================================
 *
 * Runs against the mock provider with a known signing secret, wired in place
 * of whatever the environment configures. The mock behaves like a hosted
 * gateway: payments start PENDING, the "payer" acts through `mock.simulate`,
 * which returns the signed webhook the gateway would send, and the state is
 * always read back from the provider — never taken from the webhook.
 */
describe('online payments', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;
  let unique = 0;

  const signer = new PaymentSigner(
    'e2e-payment-signing-secret-'.padEnd(48, 'x'),
    'https://api.test',
  );
  const mock = new MockPaymentProvider(signer.sign('mock-webhook', 'key'));

  const as = (token?: string) => {
    const auth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
    return {
      get: (path: string) => auth(request(http).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        auth(request(http).post(`/api/v1${path}`)).send(body),
    };
  };
  const key = () => `key-${Date.now().toString(36)}-${unique++}`;

  /** Post a signed webhook exactly as the gateway would. */
  const deliver = (webhook: { headers: Record<string, string>; rawBody: string }) =>
    request(http).post('/api/v1/payments/webhook/mock').set(webhook.headers).send(webhook.rawBody);

  async function appointment(company: 'A' | 'B' = 'A', totalMinor = 1_000_000n) {
    const seeded = company === 'A' ? world.companyA : world.companyB;
    const row = await harness.prisma.appointment.create({
      data: {
        companyId: seeded.id,
        branchId: seeded.branchId,
        customerId: seeded.customerId,
        appointmentNumber: `PAYT-${company}-${unique++}`,
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        source: 'STAFF',
        startsAt: new Date('2026-11-01T02:00:00Z'),
        endsAt: new Date('2026-11-01T03:00:00Z'),
        bookedTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        totalMinor,
      },
    });
    return row;
  }

  async function startPayment(appointmentId: string, token = ownerA, idempotencyKey = key()) {
    const res = await as(token).post('/payments', { appointmentId, idempotencyKey });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; status: string; amountMinor: string };
  }

  async function providerId(transactionId: string) {
    const row = await harness.prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    return row.providerTransactionId!;
  }

  async function pay(
    transactionId: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' = 'SUCCEEDED',
  ) {
    const res = await deliver(mock.simulate(await providerId(transactionId), outcome));
    expect(res.status).toBe(200);
    return res.body.data;
  }

  async function member(roleKey: string, companyId = world.companyA.id) {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `pay-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId, userAccountId: account.id, status: 'ACTIVE', joinedAt: new Date() },
    });
    const role = await harness.prisma.companyRole.findFirstOrThrow({
      where: { companyId, key: roleKey },
    });
    await harness.prisma.companyUserRole.create({
      data: { companyId, companyUserId: membership.id, roleId: role.id },
    });
    return harness.staffTokenForCompany(account.email, companyId);
  }

  beforeAll(async () => {
    harness = await createTestHarness({
      override: (builder) =>
        builder
          .overrideProvider(PaymentSigner)
          .useValue(signer)
          .overrideProvider(PAYMENT_GATEWAY_PROVIDERS)
          .useValue([mock]),
    });
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    await syncPlanCatalog(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('appointment payment', () => {
    it('succeeds only when the provider confirms, then settles into the books', async () => {
      const appt = await appointment('A', 1_000_000n);
      const started = await startPayment(appt.id);

      expect(started).toMatchObject({
        status: 'PENDING',
        amountMinor: '1000000',
        currencyCode: 'MNT',
      });
      expect((started as unknown as { checkout: { simulated: boolean } }).checkout.simulated).toBe(
        true,
      );

      // Nothing is booked yet: no payment row, appointment still unpaid.
      expect(await harness.prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(0);
      const before = await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
      expect(before.paymentStatus).toBe('UNPAID');

      await pay(started.id);

      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: started.id },
      });
      expect(tx.status).toBe('SUCCEEDED');
      expect(tx.providerPaymentId).toMatch(/^mock_pay_/);
      expect(tx.paymentId).not.toBeNull();

      const payment = await harness.prisma.payment.findUniqueOrThrow({
        where: { id: tx.paymentId! },
      });
      expect(payment).toMatchObject({
        method: 'ONLINE',
        status: 'SUCCEEDED',
        amountMinor: 1_000_000n,
        provider: 'mock',
        providerChargeId: tx.providerPaymentId,
      });
      // The mock charges 2%: the fee is booked, and the ledger balances.
      const ledger = await harness.prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      const debits = ledger.reduce((sum, e) => sum + e.debitMinor, 0n);
      const credits = ledger.reduce((sum, e) => sum + e.creditMinor, 0n);
      expect(debits).toBe(credits);
      expect(ledger.some((e) => e.account === 'PROCESSING_FEES' && e.debitMinor === 20_000n)).toBe(
        true,
      );

      const after = await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
      expect(after.paymentStatus).toBe('PAID');
      expect(after.paidMinor).toBe(1_000_000n);

      // The receipt event was written in the same transaction.
      expect(
        await harness.prisma.outboxEvent.count({
          where: {
            companyId: world.companyA.id,
            type: 'payment.completed',
            payload: { path: ['paymentId'], equals: payment.id },
          },
        }),
      ).toBe(1);

      const read = await as(ownerA).get(`/payments/${started.id}`).expect(200);
      expect(read.body.data).toMatchObject({
        status: 'SUCCEEDED',
        checkout: null,
        paymentId: payment.id,
      });
    });

    it('never takes a status from the client', async () => {
      const appt = await appointment();
      await as(ownerA)
        .post('/payments', { appointmentId: appt.id, idempotencyKey: key(), status: 'SUCCEEDED' })
        .expect(400);

      const started = await startPayment(appt.id);
      // Polling while the provider still says PENDING changes nothing.
      const res = await as(ownerA).get(`/payments/${started.id}`).expect(200);
      expect(res.body.data.status).toBe('PENDING');
      expect(await harness.prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(0);
    });

    it('records a failed payment and allows a retry with a new key', async () => {
      const appt = await appointment();
      const first = await startPayment(appt.id);
      await pay(first.id, 'FAILED');

      const failed = await as(ownerA).get(`/payments/${first.id}`).expect(200);
      expect(failed.body.data).toMatchObject({ status: 'FAILED', retryable: true });
      expect(await harness.prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(0);
      expect(
        (await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
          .paymentStatus,
      ).toBe('UNPAID');

      // The customer is told once, in the same transaction as the failure; a
      // replayed failure webhook adds nothing.
      const failedEvents = () =>
        harness.prisma.outboxEvent.count({
          where: {
            type: 'payment.failed',
            payload: { path: ['paymentTransactionId'], equals: first.id },
          },
        });
      expect(await failedEvents()).toBe(1);
      await pay(first.id, 'FAILED');
      expect(await failedEvents()).toBe(1);

      const retry = await startPayment(appt.id);
      expect(retry.id).not.toBe(first.id);
      expect(retry.status).toBe('PENDING');
    });

    it('refuses an amount above what is owed, and an appointment with nothing owed', async () => {
      const appt = await appointment('A', 500_000n);
      await as(ownerA)
        .post('/payments', { appointmentId: appt.id, amountMinor: '600000', idempotencyKey: key() })
        .expect(400);

      // The seeded appointment is fully paid in cash.
      const res = await as(ownerA)
        .post('/payments', { appointmentId: world.companyA.appointmentId, idempotencyKey: key() })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('books money that arrives after a checkout was cancelled', async () => {
      const appt = await appointment();
      const started = await startPayment(appt.id);
      await as(ownerA).post(`/payments/${started.id}/cancel`).expect(200);
      expect(
        (await harness.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: started.id } }))
          .status,
      ).toBe('CANCELLED');

      // The payer had already scanned the QR. The money moved; it is booked.
      await pay(started.id, 'SUCCEEDED');
      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: started.id },
      });
      expect(tx.status).toBe('SUCCEEDED');
      expect(tx.paymentId).not.toBeNull();
    });

    it('does not settle an amount it did not ask for', async () => {
      const appt = await appointment('A', 1_000_000n);
      const started = await startPayment(appt.id);
      await deliver(
        mock.simulate(await providerId(started.id), 'SUCCEEDED', { paidAmountMinor: 1n }),
      ).expect(200);

      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: started.id },
      });
      expect(tx.status).toBe('PROCESSING');
      expect(tx.failureReason).toMatch(/different amount/);
      expect(await harness.prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(0);
    });
  });

  // ===========================================================================
  describe('duplicate prevention and idempotency', () => {
    it('returns the same transaction for a retried request', async () => {
      const appt = await appointment();
      const idempotencyKey = key();
      const first = await startPayment(appt.id, ownerA, idempotencyKey);
      const second = await startPayment(appt.id, ownerA, idempotencyKey);
      expect(second.id).toBe(first.id);
      expect(
        await harness.prisma.paymentTransaction.count({ where: { appointmentId: appt.id } }),
      ).toBe(1);
    });

    it('keeps one open payment per appointment, even under concurrent requests', async () => {
      const appt = await appointment();
      const results = await Promise.all(
        [key(), key(), key()].map((k) =>
          as(ownerA).post('/payments', { appointmentId: appt.id, idempotencyKey: k }),
        ),
      );
      const ids = new Set(results.map((r) => r.body.data?.id as string));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(ids.size).toBe(1);
      expect(
        await harness.prisma.paymentTransaction.count({ where: { appointmentId: appt.id } }),
      ).toBe(1);
    });

    it('refuses an idempotency key reused for a different payment', async () => {
      const idempotencyKey = key();
      await startPayment((await appointment()).id, ownerA, idempotencyKey);
      const res = await as(ownerA)
        .post('/payments', { appointmentId: (await appointment()).id, idempotencyKey })
        .expect(409);
      expect(res.body.error.details).toMatchObject({ field: 'idempotencyKey' });
    });
  });

  // ===========================================================================
  describe('webhooks', () => {
    it('rejects an invalid signature, records it, and changes nothing', async () => {
      const appt = await appointment();
      const started = await startPayment(appt.id);
      const genuine = mock.simulate(await providerId(started.id), 'SUCCEEDED');

      const forged = await request(http)
        .post('/api/v1/payments/webhook/mock')
        .set({ ...genuine.headers, 'x-mock-signature': 't=1,v1=deadbeef' })
        .send(genuine.rawBody)
        .expect(401);
      expect(forged.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

      // Correctly signed, but with a tampered body.
      await request(http)
        .post('/api/v1/payments/webhook/mock')
        .set(genuine.headers)
        .send(genuine.rawBody.replace('payment.', 'payment.x'))
        .expect(401);

      // Correctly signed, but too old: a replay.
      const stale = mock.signedEvent(
        JSON.parse(genuine.rawBody),
        Math.floor(Date.now() / 1000) - 3_600,
      );
      await request(http)
        .post('/api/v1/payments/webhook/mock')
        .set(stale.headers)
        .send(stale.rawBody)
        .expect(401);

      expect(
        (await harness.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: started.id } }))
          .status,
      ).toBe('PENDING');
      expect(
        await harness.prisma.paymentWebhookEvent.count({
          where: { status: 'REJECTED', signatureValid: false },
        }),
      ).toBeGreaterThanOrEqual(3);
    });

    it('refuses an unknown provider', async () => {
      await request(http).post('/api/v1/payments/webhook/stripe').send('{}').expect(404);
    });

    it('processes a duplicate delivery once', async () => {
      const appt = await appointment();
      const started = await startPayment(appt.id);
      const webhook = mock.simulate(await providerId(started.id), 'SUCCEEDED');

      const first = await deliver(webhook).expect(200);
      const second = await deliver(webhook).expect(200);
      expect(first.body.data).toMatchObject({ duplicate: false, status: 'SUCCEEDED' });
      expect(second.body.data).toMatchObject({ duplicate: true });

      expect(await harness.prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(1);
      const events = await harness.prisma.paymentWebhookEvent.findMany({
        where: { transactionId: started.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'PROCESSED', attempts: 2, signatureValid: true });
    });

    it('takes state from the provider, not from the webhook body', async () => {
      const appt = await appointment();
      const started = await startPayment(appt.id);
      // Genuinely signed, claims success — but the provider says it is unpaid.
      const lie = mock.signedEvent({
        id: `evt_lie_${unique++}`,
        type: 'payment.succeeded',
        data: { providerTransactionId: await providerId(started.id), status: 'SUCCEEDED' },
      });
      const res = await deliver(lie).expect(200);
      expect(res.body.data.status).toBe('PENDING');
      expect(await harness.prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(0);
    });

    it('acknowledges a genuine event about an unknown payment without acting on it', async () => {
      const unknown = mock.signedEvent({
        id: `evt_unknown_${unique++}`,
        type: 'payment.succeeded',
        data: { providerTransactionId: 'mock_tx_doesnotexist' },
      });
      await deliver(unknown).expect(200);
      const event = await harness.prisma.paymentWebhookEvent.findFirstOrThrow({
        where: { providerTransactionId: 'mock_tx_doesnotexist' },
      });
      expect(event.status).toBe('IGNORED');
    });
  });

  // ===========================================================================
  describe('refunds', () => {
    async function paidAppointment(totalMinor = 1_000_000n) {
      const appt = await appointment('A', totalMinor);
      const started = await startPayment(appt.id);
      await pay(started.id);
      return { appt, transactionId: started.id };
    }

    it('refunds through the provider and reverses the books', async () => {
      const { appt, transactionId } = await paidAppointment();

      const res = await as(ownerA)
        .post(`/payments/${transactionId}/refund`, { reason: 'Customer cancelled' })
        .expect(200);
      expect(res.body.data).toMatchObject({ status: 'REFUNDED', refundedMinor: '1000000' });

      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      const refund = await harness.prisma.refund.findFirstOrThrow({
        where: { paymentId: tx.paymentId! },
      });
      expect(refund).toMatchObject({ status: 'SUCCEEDED', amountMinor: 1_000_000n });
      expect(refund.providerRefundId).toMatch(/^mock_re_/);
      expect(
        (await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
          .paymentStatus,
      ).toBe('REFUNDED');
      const reversal = await harness.prisma.ledgerEntry.findMany({
        where: { refundId: refund.id },
      });
      expect(reversal).toHaveLength(2);
    });

    it('supports a partial refund where the provider does', async () => {
      const { transactionId } = await paidAppointment();
      const res = await as(ownerA)
        .post(`/payments/${transactionId}/refund`, {
          amountMinor: '400000',
          reason: 'Partly unhappy',
        })
        .expect(200);
      expect(res.body.data).toMatchObject({ status: 'SUCCEEDED', refundedMinor: '400000' });

      await as(ownerA)
        .post(`/payments/${transactionId}/refund`, { amountMinor: '700000', reason: 'Too much' })
        .expect(400);
    });

    it('records nothing when the provider declines the refund', async () => {
      const { transactionId } = await paidAppointment(1_000_013n);
      const res = await as(ownerA)
        .post(`/payments/${transactionId}/refund`, { reason: 'Declined by the mock' })
        .expect(502);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');

      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(tx).toMatchObject({ status: 'SUCCEEDED', refundedMinor: 0n });
      const payment = await harness.prisma.payment.findUniqueOrThrow({
        where: { id: tx.paymentId! },
      });
      expect(payment.refundedMinor).toBe(0n);
      expect(
        await harness.prisma.refund.count({
          where: { paymentId: payment.id, status: 'SUCCEEDED' },
        }),
      ).toBe(0);
    });

    it('refuses a refund to someone without payment:refund', async () => {
      const { transactionId } = await paidAppointment();
      const receptionist = await member('RECEPTIONIST');
      const res = await as(receptionist)
        .post(`/payments/${transactionId}/refund`, { reason: 'Not allowed' })
        .expect(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
      expect(
        (
          await harness.prisma.paymentTransaction.findUniqueOrThrow({
            where: { id: transactionId },
          })
        ).refundedMinor,
      ).toBe(0n);
    });

    it('refuses to refund a payment that never settled', async () => {
      const started = await startPayment((await appointment()).id);
      await as(ownerA)
        .post(`/payments/${started.id}/refund`, { reason: 'Nothing to refund' })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('a company cannot read, refund or cancel another company’s payment', async () => {
      const appt = await appointment('A');
      const started = await startPayment(appt.id);

      await as(ownerB).get(`/payments/${started.id}`).expect(404);
      await as(ownerB).post(`/payments/${started.id}/cancel`).expect(404);
      await as(ownerB).post(`/payments/${started.id}/refund`, { reason: 'Not yours' }).expect(404);
    });

    it('a company cannot start a payment for another company’s appointment', async () => {
      const appt = await appointment('A');
      await as(ownerB)
        .post('/payments', { appointmentId: appt.id, idempotencyKey: key() })
        .expect(404);
      expect(
        await harness.prisma.paymentTransaction.count({ where: { appointmentId: appt.id } }),
      ).toBe(0);
    });

    it('settles a webhook into the right company only', async () => {
      const appt = await appointment('B');
      const started = await startPayment(appt.id, ownerB);
      await pay(started.id);
      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: started.id },
      });
      expect(tx.companyId).toBe(world.companyB.id);
      const payment = await harness.prisma.payment.findUniqueOrThrow({
        where: { id: tx.paymentId! },
      });
      expect(payment.companyId).toBe(world.companyB.id);
    });
  });

  // ===========================================================================
  describe('subscription payments', () => {
    async function openInvoice(status: 'ACTIVE' | 'PAST_DUE' = 'PAST_DUE') {
      const companyId = world.companyB.id;
      const plan = await harness.prisma.plan.findUniqueOrThrow({ where: { key: 'PRO' } });
      const now = Date.now();
      const fields = {
        planId: plan.id,
        status,
        trialEndsAt: null,
        currentPeriodStart: new Date(now - 30 * 86_400_000),
        currentPeriodEnd: new Date(now + 86_400_000),
        graceEndsAt: status === 'PAST_DUE' ? new Date(now + 5 * 86_400_000) : null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        expiredAt: null,
      };
      const sub = await harness.prisma.subscription.upsert({
        where: { companyId },
        create: { companyId, ...fields },
        update: fields,
      });
      const invoice = await harness.prisma.subscriptionInvoice.create({
        data: {
          companyId,
          subscriptionId: sub.id,
          planId: plan.id,
          planName: plan.name,
          number: `INV-TEST-${unique++}`,
          status: 'OPEN',
          amountMinor: plan.priceMinor,
          totalMinor: plan.priceMinor,
          currencyCode: plan.currencyCode,
          periodStart: new Date(now),
          periodEnd: new Date(now + 30 * 86_400_000),
          issuedAt: new Date(now),
          dueAt: new Date(now - 86_400_000),
        },
      });
      harness.app.get(EntitlementsService).invalidate(companyId);
      harness.app.get(TenantDirectoryService).invalidate(companyId);
      return invoice;
    }

    const payInvoice = (invoiceId: string, token = ownerB) =>
      as(token).post(`/companies/${world.companyB.id}/billing/${invoiceId}/pay`, {
        idempotencyKey: key(),
      });

    it('pays an invoice and reactivates a past-due subscription', async () => {
      const invoice = await openInvoice('PAST_DUE');
      const started = await payInvoice(invoice.id).expect(201);
      expect(started.body.data).toMatchObject({
        kind: 'SUBSCRIPTION_INVOICE',
        status: 'PENDING',
        amountMinor: invoice.totalMinor.toString(),
      });

      await pay(started.body.data.id as string);

      const paid = await harness.prisma.subscriptionInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(paid.status).toBe('PAID');
      const sub = await harness.prisma.subscription.findUniqueOrThrow({
        where: { companyId: world.companyB.id },
      });
      expect(sub.status).toBe('ACTIVE');
      const recorded = await harness.prisma.subscriptionPayment.findFirstOrThrow({
        where: { invoiceId: invoice.id },
      });
      expect(recorded).toMatchObject({ method: 'ONLINE', status: 'SUCCEEDED', provider: 'mock' });

      const tx = await harness.prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: started.body.data.id as string },
      });
      expect(tx.subscriptionPaymentId).toBe(recorded.id);
    });

    it('counts a failed payment and leaves the invoice open', async () => {
      const invoice = await openInvoice('PAST_DUE');
      const started = await payInvoice(invoice.id).expect(201);
      await pay(started.body.data.id as string, 'FAILED');

      const after = await harness.prisma.subscriptionInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(after).toMatchObject({ status: 'OPEN', attemptCount: 1 });
      // The owner is told the payment failed.
      expect(
        await harness.prisma.outboxEvent.count({
          where: {
            type: 'subscription.payment_failed',
            payload: { path: ['invoiceId'], equals: invoice.id },
          },
        }),
      ).toBe(1);
      const sub = await harness.prisma.subscription.findUniqueOrThrow({
        where: { companyId: world.companyB.id },
      });
      expect(sub.status).toBe('PAST_DUE');
      expect(
        await harness.prisma.subscriptionPayment.count({ where: { invoiceId: invoice.id } }),
      ).toBe(0);

      // And it can be paid again.
      await payInvoice(invoice.id).expect(201);
    });

    it('needs billing permission, and only the platform refunds it', async () => {
      const invoice = await openInvoice('ACTIVE');
      const receptionist = await member('RECEPTIONIST', world.companyB.id);
      await payInvoice(invoice.id, receptionist).expect(403);

      const started = await payInvoice(invoice.id).expect(201);
      const id = started.body.data.id as string;
      await as(receptionist).get(`/payments/${id}`).expect(403);
      await pay(id);

      await as(ownerB).post(`/payments/${id}/refund`, { reason: 'Owner tries' }).expect(403);

      const operator = await harness.platformToken(world.weakOperator.email);
      const refunded = await as(operator)
        .post(`/platform/payments/${id}/refund`, { reason: 'Goodwill refund' })
        .expect(200);
      expect(refunded.body.data.status).toBe('REFUNDED');

      // A company token cannot reach the platform route.
      await as(ownerB).post(`/platform/payments/${id}/refund`, { reason: 'Nope' }).expect(401);
    });

    it('refuses to pay an invoice that is not open', async () => {
      const invoice = await openInvoice('ACTIVE');
      await harness.prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: { status: 'VOID' },
      });
      await payInvoice(invoice.id).expect(409);
    });
  });

  // ===========================================================================
  describe('public booking payments', () => {
    const slug = () => world.companyA.slug;

    it('lets the booker pay with the token from the confirmation', async () => {
      const appt = await appointment('A', 800_000n);
      const offer = await harness.app
        .get(PaymentTransactionsService)
        .publicOffer(world.companyA.id, appt.id);
      expect(offer).toMatchObject({ amountMinor: '800000', currencyCode: 'MNT' });

      const started = await as()
        .post(`/public/companies/${slug()}/payments`, {
          paymentToken: offer!.token,
          idempotencyKey: key(),
        })
        .expect(201);
      const id = started.body.data.id as string;
      expect(started.body.data).toMatchObject({ status: 'PENDING', amountMinor: '800000' });
      // No internal ids leak to the anonymous caller.
      expect(started.body.data).not.toHaveProperty('appointmentId');
      expect(started.body.data).not.toHaveProperty('paymentId');

      await as()
        .post(`/public/companies/${slug()}/payments/${id}/simulate`, {
          token: offer!.token,
          outcome: 'SUCCEEDED',
        })
        .expect(200);

      const status = await as()
        .get(`/public/companies/${slug()}/payments/${id}?token=${encodeURIComponent(offer!.token)}`)
        .expect(200);
      expect(status.body.data.status).toBe('SUCCEEDED');
      expect(
        (await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
          .paymentStatus,
      ).toBe('PAID');
    });

    it('charges the company deposit, decided by the server', async () => {
      await harness.prisma.companySettings.update({
        where: { companyId: world.companyA.id },
        data: { requireDeposit: true, depositPercentBps: 2_500 },
      });
      try {
        const appt = await appointment('A', 1_000_000n);
        const offer = await harness.app
          .get(PaymentTransactionsService)
          .publicOffer(world.companyA.id, appt.id);
        expect(offer).toMatchObject({ amountMinor: '250000', purpose: 'DEPOSIT' });
      } finally {
        await harness.prisma.companySettings.update({
          where: { companyId: world.companyA.id },
          data: { requireDeposit: false, depositPercentBps: 0 },
        });
      }
    });

    it('refuses a forged token, and a token under another company', async () => {
      const appt = await appointment('A');
      const offer = await harness.app
        .get(PaymentTransactionsService)
        .publicOffer(world.companyA.id, appt.id);

      await as()
        .post(`/public/companies/${slug()}/payments`, {
          paymentToken: `${offer!.token}x`,
          idempotencyKey: key(),
        })
        .expect(404);
      await as()
        .post(`/public/companies/${world.companyB.slug}/payments`, {
          paymentToken: offer!.token,
          idempotencyKey: key(),
        })
        .expect(404);

      const started = await as()
        .post(`/public/companies/${slug()}/payments`, {
          paymentToken: offer!.token,
          idempotencyKey: key(),
        })
        .expect(201);
      const otherOffer = await harness.app
        .get(PaymentTransactionsService)
        .publicOffer(world.companyA.id, (await appointment('A')).id);
      // One booking's token cannot read another booking's payment.
      await as()
        .get(
          `/public/companies/${slug()}/payments/${started.body.data.id}?token=${encodeURIComponent(otherOffer!.token)}`,
        )
        .expect(404);
    });
  });
});
