import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * MONEY
 * ===========================================================================
 *
 * Payments, gift cards and promotions in one suite, because they are one
 * transaction: a gift-card payment against a discounted appointment touches all
 * three, and testing them apart would miss exactly the interactions that matter.
 *
 * The cases worth the most here are the concurrent ones. A gift card redeemed
 * twice, or a promotion capped at one redemption used twice, are not edge cases
 * — they are two members of staff at two tills on a Saturday.
 */
describe('billing', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;

  let unique = 0;

  const payUrl = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/payments`;
  const cardUrl = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/gift-cards`;
  const promoUrl = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/promotions`;
  const balanceUrl = (appointmentId: string, companyId = world.companyA.id) =>
    `/api/v1/companies/${companyId}/appointments/${appointmentId}/balance`;

  /** An appointment with a known total. There is no booking module to make one. */
  async function makeAppointment(
    totalMinor: bigint,
    companyId = world.companyA.id,
    branchId = world.companyA.branchId,
    customerId = world.companyA.customerId,
  ) {
    const appointment = await harness.prisma.appointment.create({
      data: {
        companyId,
        branchId,
        customerId,
        appointmentNumber: `TST-${Date.now()}-${unique++}`,
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        source: 'STAFF',
        startsAt: new Date('2026-10-15T02:00:00Z'),
        endsAt: new Date('2026-10-15T03:00:00Z'),
        bookedTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        subtotalMinor: totalMinor,
        totalMinor,
      },
    });
    return appointment.id;
  }

  async function issueCard(balanceMinor: string, body: Record<string, unknown> = {}, token = ownerA, companyId?: string) {
    const res = await request(http)
      .post(cardUrl(companyId))
      .set('Authorization', `Bearer ${token}`)
      .send({ initialBalanceMinor: balanceMinor, ...body })
      .expect(201);
    return res.body.data as { id: string; code: string; currentBalanceMinor: string };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);

    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('taking a payment', () => {
    it('records cash and moves the appointment to PAID', async () => {
      const appointmentId = await makeAppointment(50_000n);

      const res = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '50000', method: 'CASH' })
        .expect(201);

      expect(res.body.data).toMatchObject({
        method: 'CASH',
        purpose: 'BOOKING',
        status: 'SUCCEEDED',
        amountMinor: '50000',
        currencyCode: 'MNT',
        // Inherited from the appointment, so the drawer count attributes it to
        // the right branch.
        branchId: world.companyA.branchId,
      });
      expect(res.body.data.paymentNumber).toMatch(/^PAY-\d{8}-[A-Z2-9]{6}$/);

      const appointment = await harness.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appointment.paidMinor).toBe(50_000n);
      expect(appointment.paymentStatus).toBe('PAID');
    });

    it('posts a balanced double-entry pair', async () => {
      const appointmentId = await makeAppointment(20_000n);
      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '20000', method: 'CASH' })
        .expect(201);

      const payment = await harness.prisma.payment.findFirstOrThrow({ where: { appointmentId } });
      const entries = await harness.prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });

      expect(entries).toHaveLength(2);
      const debits = entries.reduce((sum, e) => sum + e.debitMinor, 0n);
      const credits = entries.reduce((sum, e) => sum + e.creditMinor, 0n);
      expect(debits).toBe(credits);
      expect(entries.map((e) => e.account).sort()).toEqual(['CASH_CLEARING', 'REVENUE']);
    });

    it('records a gateway fee as its own expense row', async () => {
      // Skipping the fee makes revenue look like cash, and the two never
      // reconcile.
      const appointmentId = await makeAppointment(100_000n);
      const res = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '100000', method: 'ONLINE' })
        .expect(201);

      expect(BigInt(res.body.data.feeMinor)).toBeGreaterThan(0n);

      const entries = await harness.prisma.ledgerEntry.findMany({
        where: { paymentId: res.body.data.id },
      });
      expect(entries.map((e) => e.account)).toContain('PROCESSING_FEES');
      // Clearing receives the NET, revenue the gross.
      const clearing = entries.find((e) => e.account === 'ONLINE_CLEARING')!;
      const revenue = entries.find((e) => e.account === 'REVENUE')!;
      expect(clearing.debitMinor).toBe(revenue.creditMinor - BigInt(res.body.data.feeMinor));
    });
  });

  // ===========================================================================
  describe('partial payment and balance', () => {
    it('leaves the appointment PARTIALLY_PAID with the right balance', async () => {
      const appointmentId = await makeAppointment(100_000n);

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '30000', method: 'CASH', purpose: 'DEPOSIT' })
        .expect(201);

      const balance = await request(http)
        .get(balanceUrl(appointmentId))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(balance.body.data).toMatchObject({
        totalMinor: '100000',
        paidMinor: '30000',
        outstandingMinor: '70000',
        isSettled: false,
        paymentStatus: 'PARTIALLY_PAID',
      });
    });

    it('settles when the rest arrives, in a different method', async () => {
      // A deposit in cash and the balance on a card is completely ordinary, and
      // it is why method and purpose are separate columns.
      const appointmentId = await makeAppointment(100_000n);

      for (const [amount, method, purpose] of [
        ['40000', 'CASH', 'DEPOSIT'],
        ['60000', 'CARD', 'BALANCE'],
      ] as const) {
        await request(http)
          .post(payUrl())
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ appointmentId, amountMinor: amount, method, purpose })
          .expect(201);
      }

      const balance = await request(http)
        .get(balanceUrl(appointmentId))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(balance.body.data).toMatchObject({
        outstandingMinor: '0',
        isSettled: true,
        paymentStatus: 'PAID',
      });
    });

    it('never reports a negative balance after an overpayment', async () => {
      const appointmentId = await makeAppointment(10_000n);
      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '15000', method: 'CASH' })
        .expect(201);

      const balance = await request(http)
        .get(balanceUrl(appointmentId))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(balance.body.data.outstandingMinor).toBe('0');
    });
  });

  // ===========================================================================
  describe('idempotency', () => {
    it('returns the same payment for a repeated key rather than charging twice', async () => {
      const appointmentId = await makeAppointment(25_000n);
      const key = `idem-${Date.now()}-${unique++}`;
      const body = { appointmentId, amountMinor: '25000', method: 'CARD', idempotencyKey: key };

      const first = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send(body)
        .expect(201);
      const second = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send(body)
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await harness.prisma.payment.count({ where: { appointmentId } })).toBe(1);
    });

    it('holds under two concurrent submissions of the same key', async () => {
      /**
       * The double-clicked checkout button. The service pre-check loses this
       * race by design; the globally unique column is what actually stops the
       * second charge.
       */
      const appointmentId = await makeAppointment(25_000n);
      const key = `race-${Date.now()}-${unique++}`;
      const body = { appointmentId, amountMinor: '25000', method: 'CARD', idempotencyKey: key };

      const results = await Promise.allSettled([
        request(http).post(payUrl()).set('Authorization', `Bearer ${ownerA}`).send(body),
        request(http).post(payUrl()).set('Authorization', `Bearer ${ownerA}`).send(body),
      ]);

      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 500));
      // One creates, the other either replays it (201) or loses the unique
      // constraint race (409). Never two payments.
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      expect(await harness.prisma.payment.count({ where: { appointmentId } })).toBe(1);
    });
  });

  // ===========================================================================
  describe('a gateway that says no', () => {
    it('records the failure and leaves the appointment untouched', async () => {
      // The mock declines deterministically on an amount whose minor units end
      // in 13, so this is reachable from a test and never by accident.
      const appointmentId = await makeAppointment(10_013n);

      const res = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '10013', method: 'ONLINE' })
        .expect(201);

      expect(res.body.data.status).toBe('FAILED');
      expect(res.body.data.failureReason).toMatch(/decline/i);

      const appointment = await harness.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appointment.paidMinor).toBe(0n);
      expect(appointment.paymentStatus).toBe('UNPAID');
      // A failed charge posts nothing to the ledger.
      expect(
        await harness.prisma.ledgerEntry.count({ where: { paymentId: res.body.data.id } }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  describe('refunds', () => {
    async function paidAppointment(totalMinor: bigint) {
      const appointmentId = await makeAppointment(totalMinor);
      const res = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: totalMinor.toString(), method: 'CASH' })
        .expect(201);
      return { appointmentId, paymentId: res.body.data.id as string };
    }

    it('refunds part and leaves the rest refundable', async () => {
      const { appointmentId, paymentId } = await paidAppointment(50_000n);

      const res = await request(http)
        .post(`${payUrl()}/${paymentId}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '20000', reason: 'One service not performed' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        refundedMinor: '20000',
        refundableMinor: '30000',
      });

      const appointment = await harness.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appointment.refundedMinor).toBe(20_000n);
      expect(appointment.paymentStatus).toBe('PARTIALLY_REFUNDED');
    });

    it('refunds everything left when no amount is given', async () => {
      const { paymentId } = await paidAppointment(30_000n);

      const res = await request(http)
        .post(`${payUrl()}/${paymentId}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ reason: 'Cancelled late' })
        .expect(200);

      expect(res.body.data.refundableMinor).toBe('0');
    });

    it('posts the reversal against REFUNDS, not against REVENUE', async () => {
      // Netting them would make "we refunded 12% of takings last month"
      // unanswerable.
      const { paymentId } = await paidAppointment(40_000n);
      await request(http)
        .post(`${payUrl()}/${paymentId}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '10000', reason: 'Goodwill' })
        .expect(200);

      const refund = await harness.prisma.refund.findFirstOrThrow({ where: { paymentId } });
      const entries = await harness.prisma.ledgerEntry.findMany({
        where: { refundId: refund.id },
      });
      expect(entries.map((e) => e.account).sort()).toEqual(['CASH_CLEARING', 'REFUNDS']);
      expect(entries.reduce((s, e) => s + e.debitMinor, 0n)).toBe(
        entries.reduce((s, e) => s + e.creditMinor, 0n),
      );
    });

    it('refuses more than is left', async () => {
      const { paymentId } = await paidAppointment(20_000n);
      await request(http)
        .post(`${payUrl()}/${paymentId}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '15000', reason: 'First' })
        .expect(200);

      const res = await request(http)
        .post(`${payUrl()}/${paymentId}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '10000', reason: 'Second' })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/still refundable/i);
    });

    it('refuses to refund a payment that never settled', async () => {
      const appointmentId = await makeAppointment(10_013n);
      const failed = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '10013', method: 'ONLINE' })
        .expect(201);

      await request(http)
        .post(`${payUrl()}/${failed.body.data.id}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ reason: 'Nothing to reverse' })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('gift cards', () => {
    it('returns the code exactly once and never again', async () => {
      const card = await issueCard('100000', { recipientName: 'Sara' });
      expect(card.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

      const fetched = await request(http)
        .get(`${cardUrl()}/${card.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      // Only the last four survive: enough to identify the card in a support
      // conversation, not enough to spend it.
      expect(fetched.body.data.code).toBeUndefined();
      expect(fetched.body.data.last4).toBe(card.code.slice(-4));
      expect(JSON.stringify(fetched.body)).not.toContain(card.code);
    });

    it('opens the ledger with an ISSUE row', async () => {
      const card = await issueCard('50000');
      const ledger = await request(http)
        .get(`${cardUrl()}/${card.id}/transactions`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(ledger.body.data.items).toHaveLength(1);
      expect(ledger.body.data.items[0]).toMatchObject({
        type: 'ISSUE',
        amountMinor: '50000',
        balanceAfterMinor: '50000',
      });
    });

    it('looks a card up however the code was typed', async () => {
      const card = await issueCard('30000');

      for (const typed of [
        card.code,
        card.code.toLowerCase(),
        card.code.replace(/-/g, ''),
        ` ${card.code} `,
      ]) {
        const res = await request(http)
          .post(`${cardUrl()}/lookup`)
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ code: typed })
          .expect(200);
        expect(res.body.data).toMatchObject({ id: card.id, isRedeemable: true });
      }
    });

    it('reports an expired card as unusable without saying so differently', async () => {
      const card = await issueCard('30000', {
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

      const res = await request(http)
        .post(`${cardUrl()}/lookup`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ code: card.code })
        .expect(200);

      expect(res.body.data).toMatchObject({ status: 'EXPIRED', isRedeemable: false });
      expect(res.body.data.problem).toMatch(/expired/i);
    });

    it('spends a card through a payment and links the two', async () => {
      const appointmentId = await makeAppointment(40_000n);
      const card = await issueCard('100000');

      const payment = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          appointmentId,
          amountMinor: '40000',
          method: 'GIFT_CARD',
          giftCardCode: card.code,
        })
        .expect(201);

      const after = await request(http)
        .get(`${cardUrl()}/${card.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(after.body.data.currentBalanceMinor).toBe('60000');

      // The card's ledger row points at what consumed it.
      const redemption = await harness.prisma.giftCardTransaction.findFirstOrThrow({
        where: { giftCardId: card.id, type: 'REDEEM' },
      });
      expect(redemption.paymentId).toBe(payment.body.data.id);
      expect(redemption.amountMinor).toBe(-40_000n);
      expect(redemption.balanceAfterMinor).toBe(60_000n);
    });

    it('refuses to overspend a card, and writes nothing', async () => {
      const appointmentId = await makeAppointment(80_000n);
      const card = await issueCard('50000');

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          appointmentId,
          amountMinor: '80000',
          method: 'GIFT_CARD',
          giftCardCode: card.code,
        })
        .expect(400);

      // The whole point of doing the redemption inside the payment transaction.
      expect(await harness.prisma.payment.count({ where: { appointmentId } })).toBe(0);
      const unchanged = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
      expect(unchanged.currentBalanceMinor).toBe(50_000n);
    });

    it('marks a card DEPLETED when it is spent out', async () => {
      const appointmentId = await makeAppointment(25_000n);
      const card = await issueCard('25000');

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          appointmentId,
          amountMinor: '25000',
          method: 'GIFT_CARD',
          giftCardCode: card.code,
        })
        .expect(201);

      const after = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
      expect(after.status).toBe('DEPLETED');
      expect(after.currentBalanceMinor).toBe(0n);
    });

    it('refuses to spend a depleted card a second time', async () => {
      const card = await issueCard('10000');
      const first = await makeAppointment(10_000n);
      const second = await makeAppointment(10_000n);

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId: first, amountMinor: '10000', method: 'GIFT_CARD', giftCardCode: card.code })
        .expect(201);

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId: second, amountMinor: '10000', method: 'GIFT_CARD', giftCardCode: card.code })
        .expect(400);
    });

    it('survives ten concurrent redemptions of the same card', async () => {
      /**
       * ===================================================================
       * THE CASE THE WHOLE DESIGN IS FOR
       * ===================================================================
       *
       * Two tills, one card, the same second. Read-then-write would let both
       * see 100,000 and both take 30,000. `SELECT … FOR UPDATE` serialises
       * them; `CHECK (current_balance_minor >= 0)` is the backstop if a
       * refactor ever drops the lock.
       *
       * The assertion is not "some fail" — it is that the balance and the
       * ledger agree exactly with the number that succeeded.
       */
      const card = await issueCard('100000');
      const appointments = await Promise.all(
        Array.from({ length: 10 }, () => makeAppointment(30_000n)),
      );

      const results = await Promise.allSettled(
        appointments.map((appointmentId) =>
          request(http)
            .post(payUrl())
            .set('Authorization', `Bearer ${ownerA}`)
            .send({
              appointmentId,
              amountMinor: '30000',
              method: 'GIFT_CARD',
              giftCardCode: card.code,
            }),
        ),
      );

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 201,
      ).length;

      // 100,000 divided by 30,000 is three, and no arrangement of concurrency
      // may produce a fourth.
      expect(succeeded).toBe(3);

      const after = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
      expect(after.currentBalanceMinor).toBe(10_000n);
      expect(after.currentBalanceMinor).toBeGreaterThanOrEqual(0n);

      const verified = await request(http)
        .get(`${cardUrl()}/${card.id}/verify`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(verified.body.data).toMatchObject({
        consistent: true,
        replayedBalanceMinor: '10000',
        storedBalanceMinor: '10000',
      });
    });

    it('credits the card back when a gift-card payment is refunded', async () => {
      const appointmentId = await makeAppointment(30_000n);
      const card = await issueCard('50000');

      const payment = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '30000', method: 'GIFT_CARD', giftCardCode: card.code })
        .expect(201);

      await request(http)
        .post(`${payUrl()}/${payment.body.data.id}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '10000', reason: 'Service not performed' })
        .expect(200);

      const after = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
      // Handing cash back for a card somebody was given is a different
      // transaction; ORIGINAL_METHOD on a gift-card payment means the card.
      expect(after.currentBalanceMinor).toBe(30_000n);
    });

    it('keeps the ledger self-consistent through issue, spend and refund', async () => {
      const appointmentId = await makeAppointment(20_000n);
      const card = await issueCard('60000');
      const payment = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '20000', method: 'GIFT_CARD', giftCardCode: card.code })
        .expect(201);
      await request(http)
        .post(`${payUrl()}/${payment.body.data.id}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '5000', reason: 'Partial' })
        .expect(200);

      const verified = await request(http)
        .get(`${cardUrl()}/${card.id}/verify`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);

      expect(verified.body.data).toMatchObject({
        consistent: true,
        transactionCount: 3,
        storedBalanceMinor: '45000',
      });
    });

    it('refuses an adjustment with no reason, and one that overdraws', async () => {
      const card = await issueCard('20000');

      await request(http)
        .post(`${cardUrl()}/${card.id}/adjust`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '-5000' })
        .expect(400);

      await request(http)
        .post(`${cardUrl()}/${card.id}/adjust`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '-50000', reason: 'Too much' })
        .expect(400);

      const unchanged = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
      expect(unchanged.currentBalanceMinor).toBe(20_000n);
    });

    it('voids a card and writes the remaining balance off explicitly', async () => {
      const card = await issueCard('40000');

      await request(http)
        .post(`${cardUrl()}/${card.id}/void`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ reason: 'Reported stolen' })
        .expect(204);

      const after = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
      expect(after).toMatchObject({ status: 'VOID', currentBalanceMinor: 0n });

      // The liability leaving the books has a row explaining itself.
      const written = await harness.prisma.giftCardTransaction.findFirstOrThrow({
        where: { giftCardId: card.id, type: 'VOID' },
      });
      expect(written.amountMinor).toBe(-40_000n);
      expect(written.reason).toBe('Reported stolen');
    });

    it('cannot spend another company’s card', async () => {
      const theirs = await issueCard('100000', {}, ownerB, world.companyB.id);
      const appointmentId = await makeAppointment(10_000n);

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '10000', method: 'GIFT_CARD', giftCardCode: theirs.code })
        .expect(404);

      const unchanged = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(unchanged.currentBalanceMinor).toBe(100_000n);
    });

    it('cannot even look another company’s card up', async () => {
      const theirs = await issueCard('50000', {}, ownerB, world.companyB.id);

      await request(http)
        .post(`${cardUrl()}/lookup`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ code: theirs.code })
        .expect(404);
      await request(http)
        .get(`${cardUrl()}/${theirs.id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('promotions', () => {
    async function makePromotion(body: Record<string, unknown>, token = ownerA, companyId?: string) {
      const res = await request(http)
        .post(promoUrl(companyId))
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: `Promo ${unique++}`,
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 86_400_000).toISOString(),
          ...body,
        })
        .expect(201);
      return res.body.data as { id: string; name: string };
    }

    it('quotes a percentage against a hypothetical basket', async () => {
      const promo = await makePromotion({ discountType: 'PERCENTAGE', discountValueBps: 1500 });

      const res = await request(http)
        .post(`${promoUrl()}/quote`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, subtotalMinor: '100000' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        applicable: true,
        discountMinor: '15000',
        totalMinor: '85000',
      });
    });

    it('never quotes a total below zero', async () => {
      // A 50,000 voucher against a 30,000 basket is an ordinary configuration.
      const promo = await makePromotion({
        discountType: 'FIXED_AMOUNT',
        discountAmountMinor: '50000',
      });

      const res = await request(http)
        .post(`${promoUrl()}/quote`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, subtotalMinor: '30000' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        discountMinor: '30000',
        totalMinor: '0',
        cappedBy: 'subtotal',
      });
    });

    it('honours a maximum discount', async () => {
      const promo = await makePromotion({
        discountType: 'PERCENTAGE',
        discountValueBps: 5000,
        maxDiscountMinor: '10000',
      });

      const res = await request(http)
        .post(`${promoUrl()}/quote`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, subtotalMinor: '100000' })
        .expect(200);
      expect(res.body.data).toMatchObject({ discountMinor: '10000', cappedBy: 'maxDiscount' });
    });

    it('explains an ineligible promotion instead of erroring', async () => {
      const promo = await makePromotion({
        discountType: 'PERCENTAGE',
        discountValueBps: 1000,
        minPurchaseMinor: '200000',
      });

      const res = await request(http)
        .post(`${promoUrl()}/quote`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, subtotalMinor: '50000' })
        .expect(200);

      expect(res.body.data.applicable).toBe(false);
      expect(res.body.data.problem.code).toBe('BELOW_MINIMUM');
    });

    it('refuses a promotion that has not started or has ended', async () => {
      const future = await makePromotion({
        discountType: 'PERCENTAGE',
        discountValueBps: 1000,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const past = await makePromotion({
        discountType: 'PERCENTAGE',
        discountValueBps: 1000,
        startsAt: new Date(Date.now() - 172_800_000).toISOString(),
        endsAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

      for (const [id, code] of [
        [future.id, 'NOT_STARTED'],
        [past.id, 'ENDED'],
      ] as const) {
        const res = await request(http)
          .post(`${promoUrl()}/quote`)
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ promotionId: id, subtotalMinor: '50000' })
          .expect(200);
        expect(res.body.data.problem.code).toBe(code);
      }
    });

    it('applies to an appointment and moves the total', async () => {
      const appointmentId = await makeAppointment(100_000n);
      const promo = await makePromotion({ discountType: 'PERCENTAGE', discountValueBps: 2000 });

      const res = await request(http)
        .post(`${promoUrl()}/apply`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, appointmentId })
        .expect(200);

      expect(res.body.data).toMatchObject({ discountMinor: '20000', totalMinor: '80000' });

      const appointment = await harness.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appointment.discountMinor).toBe(20_000n);
      expect(appointment.totalMinor).toBe(80_000n);
    });

    it('refuses to apply the same promotion twice to one ticket', async () => {
      const appointmentId = await makeAppointment(50_000n);
      const promo = await makePromotion({ discountType: 'PERCENTAGE', discountValueBps: 1000 });

      await request(http)
        .post(`${promoUrl()}/apply`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, appointmentId })
        .expect(200);

      await request(http)
        .post(`${promoUrl()}/apply`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, appointmentId })
        .expect(409);
    });

    it('respects a redemption limit under concurrency', async () => {
      /**
       * "Limited to the first two customers" is a promise with legal weight.
       * Read-then-write would let five concurrent applies all pass the check
       * before any of them wrote; the conditional UPDATE is what makes the cap
       * real.
       */
      const promo = await makePromotion({
        discountType: 'FIXED_AMOUNT',
        discountAmountMinor: '5000',
        maxRedemptions: 2,
      });
      const appointments = await Promise.all(
        Array.from({ length: 5 }, () => makeAppointment(50_000n)),
      );

      const results = await Promise.allSettled(
        appointments.map((appointmentId) =>
          request(http)
            .post(`${promoUrl()}/apply`)
            .set('Authorization', `Bearer ${ownerA}`)
            .send({ promotionId: promo.id, appointmentId }),
        ),
      );

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 200,
      ).length;
      expect(succeeded).toBe(2);

      const after = await harness.prisma.promotion.findUniqueOrThrow({ where: { id: promo.id } });
      expect(after.redeemedCount).toBe(2);
      expect(
        await harness.prisma.promotionRedemption.count({ where: { promotionId: promo.id } }),
      ).toBe(2);
    });

    it('records a per-line allocation that sums to the discount', async () => {
      // What makes refunding one service out of three exact later.
      const appointmentId = await makeAppointment(0n);
      const service = await harness.prisma.service.create({
        data: {
          companyId: world.companyA.id,
          name: `Alloc ${unique++}`,
          durationMin: 30,
          priceMinor: 30_000n,
          currencyCode: 'MNT',
        },
      });
      for (const amount of [30_000n, 70_000n]) {
        await harness.prisma.appointmentItem.create({
          data: {
            companyId: world.companyA.id,
            appointmentId,
            branchId: world.companyA.branchId,
            serviceId: service.id,
            startsAt: new Date('2026-10-15T02:00:00Z'),
            endsAt: new Date('2026-10-15T03:00:00Z'),
            durationMin: 30,
            unitPriceMinor: amount,
            totalMinor: amount,
            // Denormalised service details as at booking time; the column is
            // required, and a receipt must not depend on a mutable join.
            snapshot: { serviceName: service.name, priceMinor: amount.toString() },
          },
        });
      }

      const promo = await makePromotion({ discountType: 'PERCENTAGE', discountValueBps: 1000 });
      await request(http)
        .post(`${promoUrl()}/apply`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, appointmentId })
        .expect(200);

      const redemption = await harness.prisma.promotionRedemption.findFirstOrThrow({
        where: { appointmentId },
      });
      const allocation = redemption.allocation as Array<{ discountMinor: string }>;
      const summed = allocation.reduce((sum, line) => sum + BigInt(line.discountMinor), 0n);
      expect(summed).toBe(redemption.discountMinor);
      expect(summed).toBe(10_000n);
    });

    it('cannot target another company’s service', async () => {
      const theirService = await harness.prisma.service.create({
        data: {
          companyId: world.companyB.id,
          name: 'Theirs',
          durationMin: 30,
          priceMinor: 1000n,
          currencyCode: 'MNT',
        },
      });

      await request(http)
        .post(promoUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          name: 'Cross',
          status: 'ACTIVE',
          startsAt: new Date().toISOString(),
          discountType: 'PERCENTAGE',
          discountValueBps: 1000,
          serviceIds: [theirService.id],
        })
        .expect(404);
    });

    it('cannot apply to another company’s appointment', async () => {
      const theirAppointment = await makeAppointment(
        50_000n,
        world.companyB.id,
        world.companyB.branchId,
        world.companyB.customerId,
      );
      const promo = await makePromotion({ discountType: 'PERCENTAGE', discountValueBps: 1000 });

      await request(http)
        .post(`${promoUrl()}/apply`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ promotionId: promo.id, appointmentId: theirAppointment })
        .expect(404);
    });

    it('refuses a discount shape that does not match its type', async () => {
      for (const body of [
        { discountType: 'PERCENTAGE', discountAmountMinor: '5000' },
        { discountType: 'FIXED_AMOUNT', discountValueBps: 1000 },
        { discountType: 'PERCENTAGE', discountValueBps: 20000 },
        { discountType: 'FREE_SERVICE' },
      ]) {
        await request(http)
          .post(promoUrl())
          .set('Authorization', `Bearer ${ownerA}`)
          .send({ name: 'Bad', startsAt: new Date().toISOString(), ...body })
          .expect(400);
      }
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('cannot pay another company’s appointment', async () => {
      const theirs = await makeAppointment(
        50_000n,
        world.companyB.id,
        world.companyB.branchId,
        world.companyB.customerId,
      );

      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId: theirs, amountMinor: '50000', method: 'CASH' })
        .expect(404);

      expect(await harness.prisma.payment.count({ where: { appointmentId: theirs } })).toBe(0);
    });

    it('cannot read, refund or list another company’s payment', async () => {
      const theirAppointment = await makeAppointment(
        20_000n,
        world.companyB.id,
        world.companyB.branchId,
        world.companyB.customerId,
      );
      const theirPayment = await request(http)
        .post(payUrl(world.companyB.id))
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ appointmentId: theirAppointment, amountMinor: '20000', method: 'CASH' })
        .expect(201);

      const id = theirPayment.body.data.id as string;

      await request(http)
        .get(`${payUrl()}/${id}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
      await request(http)
        .post(`${payUrl()}/${id}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ reason: 'Not mine' })
        .expect(404);

      const list = await request(http)
        .get(`${payUrl()}?limit=100`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      expect(list.body.data.items.map((p: { id: string }) => p.id)).not.toContain(id);

      // Unrefunded, untouched.
      const row = await harness.prisma.payment.findUniqueOrThrow({ where: { id } });
      expect(row.refundedMinor).toBe(0n);
    });

    it('cannot read another company’s appointment balance', async () => {
      const theirs = await makeAppointment(
        10_000n,
        world.companyB.id,
        world.companyB.branchId,
        world.companyB.customerId,
      );

      await request(http)
        .get(balanceUrl(theirs))
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('rejects an anonymous caller everywhere', async () => {
      await request(http).get(payUrl()).expect(401);
      await request(http).get(cardUrl()).expect(401);
      await request(http).get(promoUrl()).expect(401);
    });

    it('separates taking money from refunding it', async () => {
      /**
       * The person at the till and the person who can hand money back are
       * usually different people. RECEPTIONIST holds `payment:write` and not
       * `payment:refund`.
       */
      const reception = await memberWithRole(SYSTEM_ROLES.RECEPTIONIST);
      const appointmentId = await makeAppointment(15_000n);

      const payment = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${reception}`)
        .send({ appointmentId, amountMinor: '15000', method: 'CASH' })
        .expect(201);

      await request(http)
        .post(`${payUrl()}/${payment.body.data.id}/refund`)
        .set('Authorization', `Bearer ${reception}`)
        .send({ reason: 'Should be refused' })
        .expect(403);
    });

    it('lets a read-only member look and not touch', async () => {
      const reader = await memberWithRole(SYSTEM_ROLES.READ_ONLY);

      await request(http).get(payUrl()).set('Authorization', `Bearer ${reader}`).expect(200);
      await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${reader}`)
        .send({ amountMinor: '1000', method: 'CASH' })
        .expect(403);
    });

    it('separates issuing a gift card from adjusting one', async () => {
      // Adjusting writes money onto a card without anybody paying for it.
      // RECEPTIONIST holds `giftcard:issue` and not `giftcard:adjust`.
      const reception = await memberWithRole(SYSTEM_ROLES.RECEPTIONIST);
      const card = await issueCard('10000');

      await request(http)
        .post(cardUrl())
        .set('Authorization', `Bearer ${reception}`)
        .send({ initialBalanceMinor: '10000' })
        .expect(201);

      await request(http)
        .post(`${cardUrl()}/${card.id}/adjust`)
        .set('Authorization', `Bearer ${reception}`)
        .send({ amountMinor: '5000', reason: 'Should be refused' })
        .expect(403);
    });

    it('refuses promotion editing to a role that may only read them', async () => {
      const reception = await memberWithRole(SYSTEM_ROLES.RECEPTIONIST);

      await request(http).get(promoUrl()).set('Authorization', `Bearer ${reception}`).expect(200);
      await request(http)
        .post(promoUrl())
        .set('Authorization', `Bearer ${reception}`)
        .send({
          name: 'Nope',
          startsAt: new Date().toISOString(),
          discountType: 'PERCENTAGE',
          discountValueBps: 1000,
        })
        .expect(403);
    });
  });

  // ===========================================================================
  describe('audit', () => {
    it('records the money events against the company', async () => {
      const appointmentId = await makeAppointment(12_000n);
      const payment = await request(http)
        .post(payUrl())
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ appointmentId, amountMinor: '12000', method: 'CASH' })
        .expect(201);
      await request(http)
        .post(`${payUrl()}/${payment.body.data.id}/refund`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ amountMinor: '2000', reason: 'Audited' })
        .expect(200);
      const card = await issueCard('5000');

      for (const [action, resourceId] of [
        ['payment.created', payment.body.data.id],
        ['gift_card.issued', card.id],
      ] as const) {
        const entry = await harness.prisma.auditLog.findFirst({ where: { action, resourceId } });
        expect(entry?.companyId).toBe(world.companyA.id);
      }

      expect(
        await harness.prisma.auditLog.count({ where: { action: 'payment.refunded' } }),
      ).toBeGreaterThan(0);
    });

    it('never records a gift-card code', async () => {
      const card = await issueCard('9000');
      const entry = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'gift_card.issued', resourceId: card.id },
      });
      expect(JSON.stringify(entry.after)).not.toContain(card.code);
      expect(JSON.stringify(entry.after)).toContain(card.code.slice(-4));
    });
  });

  // ===========================================================================

  async function memberWithRole(roleKey: string): Promise<string> {
    const known = await harness.prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `bill-${roleKey}-${Date.now()}-${unique++}@example.com`,
        fullName: `${roleKey} Person`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await harness.prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
    });
    await harness.prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });

    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }
});
