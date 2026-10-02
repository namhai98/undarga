import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * GIFT CARDS
 * ===========================================================================
 *
 * Stored value on its own terms: issue, look up, change, disable, redeem,
 * refund and adjust — without the payments module. `billing.e2e-spec.ts`
 * covers the path where a payment spends a card; this suite covers the card.
 *
 * The assertions that matter most are about the ledger: that every balance
 * change left exactly one row, that the rows replay to the stored balance, and
 * that no arrangement of concurrent requests takes a card below zero or spends
 * a redemption twice.
 */
describe('gift cards', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  let ownerA: string;
  let ownerB: string;
  let unique = 0;

  const url = (companyId = world.companyA.id) => `/api/v1/companies/${companyId}/gift-cards`;

  const as = (token: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(http).post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) =>
      request(http).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function issue(
    balanceMinor: string,
    body: Record<string, unknown> = {},
    token = ownerA,
    companyId?: string,
  ) {
    const res = await as(token).post(url(companyId), { initialBalanceMinor: balanceMinor, ...body });
    expect(res.status).toBe(201);
    return res.body.data as {
      id: string;
      code: string;
      last4: string;
      currentBalanceMinor: string;
      initialBalanceMinor: string;
    };
  }

  function redeem(cardId: string, amountMinor: string, extra: object = {}, token = ownerA) {
    return as(token).post(`${url()}/${cardId}/redeem`, { amountMinor, ...extra });
  }

  async function stored(cardId: string) {
    return harness.prisma.giftCard.findUniqueOrThrow({ where: { id: cardId } });
  }

  async function ledger(cardId: string) {
    return harness.prisma.giftCardTransaction.findMany({
      where: { giftCardId: cardId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  }

  async function verify(cardId: string) {
    const res = await as(ownerA).get(`${url()}/${cardId}/verify`).expect(200);
    return res.body.data as { consistent: boolean; storedBalanceMinor: string; transactionCount: number };
  }

  async function customer(firstName: string, companyId = world.companyA.id) {
    const row = await harness.prisma.companyCustomer.create({
      data: { companyId, firstName, lastName: 'Gift', phone: `+9768${String(unique++).padStart(7, '0')}` },
    });
    return row.id;
  }

  async function appointment(customerId: string, companyId = world.companyA.id, branchId = world.companyA.branchId) {
    const row = await harness.prisma.appointment.create({
      data: {
        companyId,
        branchId,
        customerId,
        appointmentNumber: `GC-${Date.now()}-${unique++}`,
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        source: 'STAFF',
        startsAt: new Date('2026-11-15T02:00:00Z'),
        endsAt: new Date('2026-11-15T03:00:00Z'),
        bookedTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        subtotalMinor: 50_000n,
        totalMinor: 50_000n,
      },
    });
    return row.id;
  }

  /** A fresh member of company A holding exactly one system role. */
  async function member(roleKey: string): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `gc-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await prisma.companyRole.findFirstOrThrow({
      where: { companyId: world.companyA.id, key: roleKey },
    });
    await prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });
    return harness.staffTokenForCompany(account.email, world.companyA.id);
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
  describe('creation', () => {
    it('issues a card with everything the screen shows, and the code once', async () => {
      const owner = await customer('Saraa');
      const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      const card = await issue('150000', { issuedToCustomerId: owner, expiresAt });

      expect(card.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
      const detail = await as(ownerA).get(`${url()}/${card.id}`).expect(200);
      expect(detail.body.data).toMatchObject({
        id: card.id,
        last4: card.code.slice(-4),
        initialBalanceMinor: '150000',
        currentBalanceMinor: '150000',
        currencyCode: 'MNT',
        status: 'ACTIVE',
        expiresAt,
        issuedToCustomerId: owner,
        issuedToName: 'Saraa Gift',
        isRedeemable: true,
      });
      expect(detail.body.data.code).toBeUndefined();
      expect(JSON.stringify(detail.body)).not.toContain(card.code);
    });

    it('opens the ledger with one ISSUE row that records who issued it', async () => {
      const card = await issue('40000');
      const rows = await ledger(card.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'ISSUE',
        amountMinor: 40_000n,
        balanceAfterMinor: 40_000n,
        performedByType: 'COMPANY_USER',
      });
      expect(rows[0]!.performedById).not.toBeNull();
    });

    it('refuses a zero balance, an unknown currency and another company’s customer', async () => {
      await as(ownerA).post(url(), { initialBalanceMinor: '0' }).expect(400);
      await as(ownerA).post(url(), { initialBalanceMinor: '-100' }).expect(400);
      await as(ownerA).post(url(), { initialBalanceMinor: '100', currencyCode: 'ZZZ' }).expect(400);
      await as(ownerA)
        .post(url(), { initialBalanceMinor: '100', issuedToCustomerId: world.companyB.customerId })
        .expect(404);
    });

    it('never stores two cards under one code', async () => {
      const card = await issue('1000');
      const row = await stored(card.id);
      // Codes are 16 characters from a 31-letter alphabet, so a collision will
      // not happen by chance; the unique index is what makes it impossible.
      await expect(
        harness.prisma.giftCard.create({
          data: {
            companyId: world.companyA.id,
            codeHash: row.codeHash,
            codeLast4: row.codeLast4,
            status: 'ACTIVE',
            initialBalanceMinor: 1n,
            currentBalanceMinor: 1n,
            currencyCode: 'MNT',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ===========================================================================
  describe('balance and search', () => {
    it('reports the balance and follows it through a redemption', async () => {
      const card = await issue('80000');
      const before = await as(ownerA).get(`${url()}/${card.id}/balance`).expect(200);
      expect(before.body.data).toMatchObject({
        initialBalanceMinor: '80000',
        currentBalanceMinor: '80000',
        currencyCode: 'MNT',
        status: 'ACTIVE',
        isRedeemable: true,
        problemCode: null,
      });

      await redeem(card.id, '30000').expect(200);
      const after = await as(ownerA).get(`${url()}/${card.id}/balance`).expect(200);
      expect(after.body.data).toMatchObject({ initialBalanceMinor: '80000', currentBalanceMinor: '50000' });
    });

    it('finds a card by its full code however it was typed, by last four, and by customer', async () => {
      const owner = await customer(`Uranchimeg${unique}`);
      const card = await issue('5000', { issuedToCustomerId: owner });

      for (const search of [card.code, card.code.toLowerCase().replace(/-/g, ''), card.last4]) {
        const res = await as(ownerA).get(url()).query({ search }).expect(200);
        expect(res.body.data.items.map((c: { id: string }) => c.id)).toContain(card.id);
      }

      const byName = await as(ownerA).get(url()).query({ search: 'uranchimeg' }).expect(200);
      expect(byName.body.data.items.map((c: { id: string }) => c.id)).toContain(card.id);

      const byOwner = await as(ownerA).get(url()).query({ issuedToCustomerId: owner }).expect(200);
      expect(byOwner.body.data.items).toHaveLength(1);
      expect(byOwner.body.data.items[0].id).toBe(card.id);
    });

    it('filters on the effective status and paginates', async () => {
      const expired = await issue('1000', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
      const live = await issue('1000');

      const expiredList = await as(ownerA).get(url()).query({ status: 'EXPIRED', limit: 100 }).expect(200);
      const expiredIds = expiredList.body.data.items.map((c: { id: string }) => c.id);
      expect(expiredIds).toContain(expired.id);
      expect(expiredIds).not.toContain(live.id);

      const activeList = await as(ownerA).get(url()).query({ status: 'ACTIVE', limit: 100 }).expect(200);
      const activeIds = activeList.body.data.items.map((c: { id: string }) => c.id);
      expect(activeIds).toContain(live.id);
      expect(activeIds).not.toContain(expired.id);

      const page = await as(ownerA).get(url()).query({ limit: 1, offset: 1 }).expect(200);
      expect(page.body.data).toMatchObject({ limit: 1, offset: 1 });
      expect(page.body.data.items).toHaveLength(1);
      expect(page.body.data.total).toBeGreaterThan(1);
    });
  });

  // ===========================================================================
  describe('expiry', () => {
    it('refuses to spend an expired card and writes nothing', async () => {
      const card = await issue('20000', { expiresAt: new Date(Date.now() - 60_000).toISOString() });

      const detail = await as(ownerA).get(`${url()}/${card.id}`).expect(200);
      expect(detail.body.data).toMatchObject({ status: 'EXPIRED', isRedeemable: false });

      const res = await redeem(card.id, '1000').expect(400);
      expect(res.body.error).toMatchObject({ code: 'GIFT_CARD_NOT_USABLE', details: { reason: 'EXPIRED' } });
      expect(await ledger(card.id)).toHaveLength(1);
      expect((await stored(card.id)).currentBalanceMinor).toBe(20_000n);
    });

    it('accepts only a future expiry, and null for never — which makes the card usable again', async () => {
      const card = await issue('20000', { expiresAt: new Date(Date.now() - 60_000).toISOString() });

      await as(ownerA)
        .patch(`${url()}/${card.id}`, { expiresAt: new Date(Date.now() - 1000).toISOString() })
        .expect(400);

      const res = await as(ownerA).patch(`${url()}/${card.id}`, { expiresAt: null }).expect(200);
      expect(res.body.data).toMatchObject({ expiresAt: null, status: 'ACTIVE', isRedeemable: true });
      await redeem(card.id, '1000').expect(200);
    });
  });

  // ===========================================================================
  describe('disable', () => {
    it('blocks every redemption but keeps the balance, and can be undone', async () => {
      const card = await issue('30000');

      const disabled = await as(ownerA)
        .post(`${url()}/${card.id}/disable`, { reason: 'Reported lost' })
        .expect(200);
      expect(disabled.body.data).toMatchObject({
        status: 'DISABLED',
        currentBalanceMinor: '30000',
        disabledReason: 'Reported lost',
        isRedeemable: false,
      });

      const refused = await redeem(card.id, '1000').expect(400);
      expect(refused.body.error.details).toMatchObject({ reason: 'DISABLED' });
      await as(ownerA).post(`${url()}/${card.id}/disable`, { reason: 'Again' }).expect(409);

      // No money moved, so no ledger row.
      expect(await ledger(card.id)).toHaveLength(1);

      const enabled = await as(ownerA).post(`${url()}/${card.id}/enable`).expect(200);
      expect(enabled.body.data).toMatchObject({ status: 'ACTIVE', disabledReason: null });
      await redeem(card.id, '1000').expect(200);
    });

    it('keeps a disabled card disabled through an adjustment', async () => {
      const card = await issue('30000');
      await redeem(card.id, '10000').expect(200);
      await as(ownerA).post(`${url()}/${card.id}/disable`, { reason: 'Dispute' }).expect(200);

      await as(ownerA)
        .post(`${url()}/${card.id}/adjust`, { amountMinor: '5000', reason: 'Goodwill' })
        .expect(200);
      const after = await stored(card.id);
      expect(after).toMatchObject({ status: 'DISABLED', currentBalanceMinor: 25_000n });
    });

    it('treats a voided card as closed: no disable, no edit, no adjustment back to life', async () => {
      const card = await issue('30000');
      await as(ownerA).post(`${url()}/${card.id}/void`, { reason: 'Issued in error' }).expect(204);

      await as(ownerA).post(`${url()}/${card.id}/disable`, { reason: 'x'.repeat(5) }).expect(409);
      await as(ownerA).patch(`${url()}/${card.id}`, { recipientName: 'Someone' }).expect(409);
      await as(ownerA)
        .post(`${url()}/${card.id}/adjust`, { amountMinor: '5000', reason: 'Resurrect' })
        .expect(409);
      expect(await stored(card.id)).toMatchObject({ status: 'VOID', currentBalanceMinor: 0n });
    });
  });

  // ===========================================================================
  describe('ledger', () => {
    it('records ISSUE, REDEEM, REFUND and ADJUSTMENT, each with the balance it produced', async () => {
      const card = await issue('100000');
      const spent = await redeem(card.id, '40000', { note: 'Haircut' }).expect(200);
      expect(spent.body.data.card.currentBalanceMinor).toBe('60000');

      await as(ownerA)
        .post(`${url()}/${card.id}/refund`, {
          transactionId: spent.body.data.transactionId,
          amountMinor: '15000',
          reason: 'Shorter service',
        })
        .expect(200);
      await as(ownerA)
        .post(`${url()}/${card.id}/adjust`, { amountMinor: '-5000', reason: 'Correction' })
        .expect(200);

      const rows = await ledger(card.id);
      expect(rows.map((r) => [r.type, r.amountMinor, r.balanceAfterMinor])).toEqual([
        ['ISSUE', 100_000n, 100_000n],
        ['REDEEM', -40_000n, 60_000n],
        ['REFUND', 15_000n, 75_000n],
        ['ADJUSTMENT', -5_000n, 70_000n],
      ]);
      expect(rows[2]!.reversesTransactionId).toBe(rows[1]!.id);
      expect(rows.every((r) => r.performedById !== null)).toBe(true);

      expect(await verify(card.id)).toMatchObject({
        consistent: true,
        storedBalanceMinor: '70000',
        transactionCount: 4,
      });

      // The API view: newest first, with what is left to refund on the redemption.
      const api = await as(ownerA).get(`${url()}/${card.id}/transactions`).expect(200);
      expect(api.body.data.total).toBe(4);
      expect(api.body.data.items.map((r: { type: string }) => r.type)).toEqual([
        'ADJUSTMENT',
        'REFUND',
        'REDEEM',
        'ISSUE',
      ]);
      expect(api.body.data.items[2]).toMatchObject({ refundedMinor: '15000', refundableMinor: '25000' });
    });

    it('cannot be rewritten, even with direct database access', async () => {
      const card = await issue('10000');
      const [row] = await ledger(card.id);

      await expect(
        harness.prisma.giftCardTransaction.update({
          where: { id: row!.id },
          data: { amountMinor: 999_999n },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        harness.prisma.giftCardTransaction.delete({ where: { id: row!.id } }),
      ).rejects.toThrow(/append-only/);
    });

    it('cannot hold a negative balance, even with direct database access', async () => {
      const card = await issue('10000');
      await expect(
        harness.prisma.giftCard.update({ where: { id: card.id }, data: { currentBalanceMinor: -1n } }),
      ).rejects.toThrow(/gift_card_balance_nonneg/);
    });

    it('refuses to change the balance or currency through an update', async () => {
      const card = await issue('10000');
      await as(ownerA).patch(`${url()}/${card.id}`, { currentBalanceMinor: '999999' }).expect(400);
      await as(ownerA).patch(`${url()}/${card.id}`, { initialBalanceMinor: '999999' }).expect(400);
      await as(ownerA).patch(`${url()}/${card.id}`, { currencyCode: 'USD' }).expect(400);
      expect(await stored(card.id)).toMatchObject({
        currentBalanceMinor: 10_000n,
        initialBalanceMinor: 10_000n,
        currencyCode: 'MNT',
      });
      expect(await ledger(card.id)).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('invalid redemption', () => {
    it('refuses a zero, negative or malformed amount', async () => {
      const card = await issue('10000');
      await redeem(card.id, '0').expect(400);
      await redeem(card.id, '-100').expect(400);
      await redeem(card.id, '10.5').expect(400);
      expect(await ledger(card.id)).toHaveLength(1);
    });

    it('404s an unknown card', async () => {
      await redeem('00000000-0000-7000-8000-000000000000', '100').expect(404);
    });

    it('refuses more than the balance, and writes nothing', async () => {
      const card = await issue('50000');
      const res = await redeem(card.id, '50001').expect(400);
      expect(res.body.error).toMatchObject({
        code: 'GIFT_CARD_NOT_USABLE',
        details: { reason: 'INSUFFICIENT_BALANCE' },
      });
      expect((await stored(card.id)).currentBalanceMinor).toBe(50_000n);
      expect(await ledger(card.id)).toHaveLength(1);
    });

    it('spends exactly the balance, then refuses a depleted card', async () => {
      const card = await issue('50000');
      await redeem(card.id, '50000').expect(200);
      expect(await stored(card.id)).toMatchObject({ status: 'DEPLETED', currentBalanceMinor: 0n });

      const res = await redeem(card.id, '1').expect(400);
      expect(res.body.error.details).toMatchObject({ reason: 'NO_BALANCE' });
    });

    it('caps refunds at what the redemption took', async () => {
      const card = await issue('50000');
      const spent = await redeem(card.id, '20000').expect(200);
      const transactionId = spent.body.data.transactionId as string;

      const tooMuch = await as(ownerA)
        .post(`${url()}/${card.id}/refund`, { transactionId, amountMinor: '20001', reason: 'Oops' })
        .expect(400);
      expect(tooMuch.body.error.details).toMatchObject({ reason: 'REFUND_EXCEEDS_REDEMPTION' });

      // Omitted amount = everything left.
      await as(ownerA).post(`${url()}/${card.id}/refund`, { transactionId, reason: 'Cancelled' }).expect(200);
      const again = await as(ownerA)
        .post(`${url()}/${card.id}/refund`, { transactionId, reason: 'Cancelled twice' })
        .expect(400);
      expect(again.body.error.details).toMatchObject({ reason: 'ALREADY_REFUNDED' });
      expect((await stored(card.id)).currentBalanceMinor).toBe(50_000n);
    });

    it('refuses to refund a row that is not a redemption of this card', async () => {
      const card = await issue('50000');
      const other = await issue('50000');
      const spent = await redeem(other.id, '1000').expect(200);
      const [issueRow] = await ledger(card.id);

      await as(ownerA)
        .post(`${url()}/${card.id}/refund`, { transactionId: spent.body.data.transactionId, reason: 'Wrong card' })
        .expect(404);
      await as(ownerA)
        .post(`${url()}/${card.id}/refund`, { transactionId: issueRow!.id, reason: 'Not a redemption' })
        .expect(404);
    });
  });

  // ===========================================================================
  describe('concurrency', () => {
    it('lets ten simultaneous redemptions take only what the card holds', async () => {
      const card = await issue('100000');
      const results = await Promise.all(
        Array.from({ length: 10 }, () => redeem(card.id, '30000')),
      );

      // 100,000 / 30,000 = 3. No interleaving may produce a fourth.
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      for (const failed of results.filter((r) => r.status !== 200)) {
        expect(failed.status).toBe(400);
        expect(failed.body.error.details).toMatchObject({ reason: 'INSUFFICIENT_BALANCE' });
      }
      expect((await stored(card.id)).currentBalanceMinor).toBe(10_000n);
      expect(await verify(card.id)).toMatchObject({ consistent: true, transactionCount: 4 });
    });

    it('spends once for one idempotency key, however many times it is sent at once', async () => {
      const card = await issue('100000');
      const idempotencyKey = `redeem-${Date.now()}-${unique++}`;

      const results = await Promise.all(
        Array.from({ length: 6 }, () => redeem(card.id, '25000', { idempotencyKey })),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      const ids = new Set(results.map((r) => r.body.data.transactionId as string));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.body.data.replayed === false)).toHaveLength(1);
      expect((await stored(card.id)).currentBalanceMinor).toBe(75_000n);
      expect(await ledger(card.id)).toHaveLength(2);
    });

    it('refuses an idempotency key reused for a different amount', async () => {
      const card = await issue('100000');
      const idempotencyKey = `redeem-${Date.now()}-${unique++}`;
      await redeem(card.id, '1000', { idempotencyKey }).expect(200);
      await redeem(card.id, '2000', { idempotencyKey }).expect(409);
      expect((await stored(card.id)).currentBalanceMinor).toBe(99_000n);
    });

    it('gives a redemption back only once under concurrent refunds', async () => {
      const card = await issue('50000');
      const spent = await redeem(card.id, '20000').expect(200);
      const transactionId = spent.body.data.transactionId as string;

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          as(ownerA).post(`${url()}/${card.id}/refund`, { transactionId, reason: 'Double click' }),
        ),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await stored(card.id)).currentBalanceMinor).toBe(50_000n);
      expect(await verify(card.id)).toMatchObject({ consistent: true, transactionCount: 3 });
    });

    it('never lets a disable and a redemption race into a spend on a disabled card', async () => {
      const card = await issue('100000');
      const [spend, disable] = await Promise.all([
        redeem(card.id, '10000'),
        as(ownerA).post(`${url()}/${card.id}/disable`, { reason: 'Stolen' }),
      ]);
      expect(disable.status).toBe(200);

      const rows = await ledger(card.id);
      expect((await stored(card.id)).status).toBe('DISABLED');
      // Either order is fine: the redemption committed first, or it saw the
      // card disabled. Both hold the same row lock, so there is no third case.
      if (spend.status === 200) {
        expect(rows.filter((r) => r.type === 'REDEEM')).toHaveLength(1);
      } else {
        expect(spend.body.error.details).toMatchObject({ reason: 'DISABLED' });
        expect(rows).toHaveLength(1);
      }
      expect(await verify(card.id)).toMatchObject({ consistent: true });
    });
  });

  // ===========================================================================
  describe('customer ownership', () => {
    it('assigns, reassigns and detaches a card — only to this company’s customers', async () => {
      const first = await customer('Temuulen');
      const second = await customer('Anu');
      const card = await issue('10000', { issuedToCustomerId: first });

      const moved = await as(ownerA).patch(`${url()}/${card.id}`, { issuedToCustomerId: second }).expect(200);
      expect(moved.body.data).toMatchObject({ issuedToCustomerId: second, issuedToName: 'Anu Gift' });

      await as(ownerA)
        .patch(`${url()}/${card.id}`, { issuedToCustomerId: world.companyB.customerId })
        .expect(404);
      expect((await stored(card.id)).issuedToCustomerId).toBe(second);

      const detached = await as(ownerA).patch(`${url()}/${card.id}`, { issuedToCustomerId: null }).expect(200);
      expect(detached.body.data).toMatchObject({ issuedToCustomerId: null, issuedToName: null });
    });

    it('spends an owned card only on its owner’s booking', async () => {
      const owner = await customer('Bold');
      const stranger = await customer('Stranger');
      const card = await issue('50000', { issuedToCustomerId: owner });

      const refused = await redeem(card.id, '10000', { appointmentId: await appointment(stranger) }).expect(400);
      expect(refused.body.error.details).toMatchObject({ reason: 'WRONG_CUSTOMER' });
      expect(await ledger(card.id)).toHaveLength(1);

      const ownAppointment = await appointment(owner);
      await redeem(card.id, '10000', { appointmentId: ownAppointment }).expect(200);
      const redemption = (await ledger(card.id)).find((r) => r.type === 'REDEEM')!;
      expect(redemption.appointmentId).toBe(ownAppointment);
    });

    it('spends an unowned card on anybody’s booking', async () => {
      const card = await issue('50000');
      await redeem(card.id, '10000', { appointmentId: await appointment(await customer('Anyone')) }).expect(200);
    });

    it('lists only the cards issued to a customer', async () => {
      const owner = await customer('Listed');
      const mine = await issue('1000', { issuedToCustomerId: owner });
      await issue('1000');

      const res = await as(ownerA).get(url()).query({ issuedToCustomerId: owner }).expect(200);
      expect(res.body.data.items.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    });
  });

  // ===========================================================================
  describe('tenant isolation', () => {
    it('makes another company’s card invisible and untouchable', async () => {
      const theirs = await issue('70000', {}, ownerB, world.companyB.id);
      const base = `${url()}/${theirs.id}`;

      await as(ownerA).get(base).expect(404);
      await as(ownerA).get(`${base}/balance`).expect(404);
      await as(ownerA).get(`${base}/transactions`).expect(404);
      await as(ownerA).get(`${base}/verify`).expect(404);
      await as(ownerA).patch(base, { recipientName: 'Hijack' }).expect(404);
      await as(ownerA).post(`${base}/disable`, { reason: 'Hostile' }).expect(404);
      await as(ownerA).post(`${base}/redeem`, { amountMinor: '1000' }).expect(404);
      await as(ownerA).post(`${base}/adjust`, { amountMinor: '-1000', reason: 'Hostile' }).expect(404);
      await as(ownerA).post(`${base}/void`, { reason: 'Hostile' }).expect(404);
      await as(ownerA).post(`${url()}/lookup`, { code: theirs.code }).expect(404);

      const list = await as(ownerA).get(url()).query({ search: theirs.code }).expect(200);
      expect(list.body.data.items).toHaveLength(0);

      const after = await stored(theirs.id);
      expect(after).toMatchObject({ status: 'ACTIVE', currentBalanceMinor: 70_000n, recipientName: null });
      expect(await ledger(theirs.id)).toHaveLength(1);
    });

    it('refuses another company’s appointment on a redemption', async () => {
      const card = await issue('50000');
      await redeem(card.id, '1000', { appointmentId: world.companyB.appointmentId }).expect(404);
      expect(await ledger(card.id)).toHaveLength(1);
    });

    it('refuses a company id the caller is not a member of', async () => {
      const theirs = await issue('1000', {}, ownerB, world.companyB.id);
      await as(ownerA).get(url(world.companyB.id)).expect(404);
      await as(ownerA).get(`${url(world.companyB.id)}/${theirs.id}`).expect(404);
    });

    it('exposes nothing through the public API', async () => {
      const card = await issue('1000');
      const pub = `/api/v1/public/companies/${world.companyA.slug}`;
      await request(http).get(`${pub}/gift-cards`).expect(404);
      await request(http).get(`${pub}/gift-cards/${card.id}`).expect(404);
      await request(http).get(`${pub}/gift-cards/${card.id}/transactions`).expect(404);
      await request(http).post(`${pub}/gift-cards/lookup`).send({ code: card.code }).expect(404);
    });
  });

  // ===========================================================================
  describe('permissions', () => {
    it('rejects an anonymous caller', async () => {
      await request(http).get(url()).expect(401);
      await request(http).post(url()).send({ initialBalanceMinor: '100' }).expect(401);
    });

    it('lets a read-only member look but not touch', async () => {
      const token = await member(SYSTEM_ROLES.READ_ONLY);
      const card = await issue('10000');

      await as(token).get(url()).expect(200);
      await as(token).get(`${url()}/${card.id}`).expect(200);
      await as(token).get(`${url()}/${card.id}/balance`).expect(200);
      await as(token).get(`${url()}/${card.id}/transactions`).expect(200);

      await as(token).post(url(), { initialBalanceMinor: '100' }).expect(403);
      await as(token).patch(`${url()}/${card.id}`, { recipientName: 'X' }).expect(403);
      await as(token).post(`${url()}/${card.id}/disable`, { reason: 'Nope' }).expect(403);
      await redeem(card.id, '100', {}, token).expect(403);
      expect(await ledger(card.id)).toHaveLength(1);
    });

    it('lets a receptionist issue, edit, disable and redeem — but not re-enable, adjust or void', async () => {
      const token = await member(SYSTEM_ROLES.RECEPTIONIST);
      const res = await as(token).post(url(), { initialBalanceMinor: '20000' }).expect(201);
      const id = res.body.data.id as string;

      await as(token).patch(`${url()}/${id}`, { recipientName: 'Gift for Mom' }).expect(200);
      const spent = await redeem(id, '5000', {}, token).expect(200);
      await as(token)
        .post(`${url()}/${id}/refund`, { transactionId: spent.body.data.transactionId, reason: 'Undo' })
        .expect(200);
      await as(token).post(`${url()}/${id}/disable`, { reason: 'Customer asked' }).expect(200);

      await as(token).post(`${url()}/${id}/enable`).expect(403);
      await as(token).post(`${url()}/${id}/adjust`, { amountMinor: '-100', reason: 'x'.repeat(3) }).expect(403);
      await as(token).post(`${url()}/${id}/void`, { reason: 'x'.repeat(3) }).expect(403);
    });

    it('keeps gift cards away from an employee', async () => {
      const token = await member(SYSTEM_ROLES.EMPLOYEE);
      const card = await issue('10000');
      await as(token).get(url()).expect(403);
      await as(token).get(`${url()}/${card.id}/balance`).expect(403);
      await redeem(card.id, '100', {}, token).expect(403);
    });
  });

  // ===========================================================================
  describe('audit', () => {
    it('records every change against the company and never the code', async () => {
      const card = await issue('10000');
      await as(ownerA).patch(`${url()}/${card.id}`, { recipientName: 'Audit' }).expect(200);
      await redeem(card.id, '1000').expect(200);
      await as(ownerA).post(`${url()}/${card.id}/disable`, { reason: 'Audit' }).expect(200);
      await as(ownerA).post(`${url()}/${card.id}/enable`).expect(200);

      const entries = await harness.prisma.auditLog.findMany({ where: { resourceId: card.id } });
      expect(entries.map((e) => e.action).sort()).toEqual([
        'gift_card.disabled',
        'gift_card.enabled',
        'gift_card.issued',
        'gift_card.redeemed',
        'gift_card.updated',
      ]);
      expect(entries.every((e) => e.companyId === world.companyA.id)).toBe(true);
      const recorded = JSON.stringify(entries.map((e) => [e.before, e.after, e.metadata]));
      expect(recorded).not.toContain(card.code);
      expect(recorded).not.toContain(card.code.replace(/-/g, ''));
    });
  });
});
