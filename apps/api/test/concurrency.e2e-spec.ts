import request from 'supertest';
import type { Server } from 'node:http';
import { MockPaymentProvider } from '../src/payments/gateway/mock.provider';
import { PAYMENT_GATEWAY_PROVIDERS } from '../src/payments/gateway/payment-provider';
import { PaymentSigner } from '../src/payments/gateway/payment-signer';
import { syncPlanCatalog } from '../src/subscriptions/plan-catalog';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * CONCURRENCY REGRESSIONS (Task #31)
 * ===========================================================================
 *
 * Races not covered by the feature suites. The booking/time-off and
 * booking/resource-block races were real bugs: an appointment could land
 * inside time off (or a resource block) approved while the booking was in
 * flight, with neither side noticing. Both now serialise on the same advisory
 * lock (appointments/booking-locks.ts) and the booking re-checks under it.
 * Those two tests force the race window open deterministically by pausing the
 * booking right after its availability check.
 */
describe('concurrency — payments', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let unique = 0;

  const signer = new PaymentSigner(
    'e2e-payment-signing-secret-'.padEnd(48, 'x'),
    'https://api.test',
  );
  const mock = new MockPaymentProvider(signer.sign('mock-webhook', 'key'));
  const key = () => `qa-${Date.now().toString(36)}-${unique++}`;
  const deliver = (webhook: { headers: Record<string, string>; rawBody: string }) =>
    request(http).post('/api/v1/payments/webhook/mock').set(webhook.headers).send(webhook.rawBody);
  const post = (path: string, body: object) =>
    request(http).post(`/api/v1${path}`).set('Authorization', `Bearer ${ownerA}`).send(body);

  async function appointment(totalMinor = 1_000_000n) {
    return harness.prisma.appointment.create({
      data: {
        companyId: world.companyA.id,
        branchId: world.companyA.branchId,
        customerId: world.companyA.customerId,
        appointmentNumber: `QA-${unique++}`,
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
  }

  async function started(appointmentId: string) {
    const res = await post('/payments', { appointmentId, idempotencyKey: key() });
    expect(res.status).toBe(201);
    const row = await harness.prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    return { id: row.id, providerId: row.providerTransactionId! };
  }

  beforeAll(async () => {
    harness = await createTestHarness({
      override: (b) =>
        b
          .overrideProvider(PaymentSigner)
          .useValue(signer)
          .overrideProvider(PAYMENT_GATEWAY_PROVIDERS)
          .useValue([mock]),
    });
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    await syncPlanCatalog(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('settles a webhook delivered five times at once exactly once', async () => {
    const appt = await appointment();
    const tx = await started(appt.id);
    const webhook = mock.simulate(tx.providerId, 'SUCCEEDED');
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(webhook)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);

    const payments = await harness.prisma.payment.findMany({ where: { appointmentId: appt.id } });
    expect(payments).toHaveLength(1);
    // One journal: revenue, clearing and the processing fee — as for a single delivery.
    const ledger = await harness.prisma.ledgerEntry.findMany({
      where: { paymentId: payments[0]!.id },
    });
    expect(ledger).toHaveLength(3);
    expect(new Set(ledger.map((l) => l.journalId)).size).toBe(1);
    const after = await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.paidMinor).toBe(1_000_000n);
    expect(after.paymentStatus).toBe('PAID');
  });

  it('refunds a payment once under three concurrent full refunds', async () => {
    const appt = await appointment();
    const tx = await started(appt.id);
    await deliver(mock.simulate(tx.providerId, 'SUCCEEDED')).expect(200);

    const results = await Promise.all(
      [1, 2, 3].map(() => post(`/payments/${tx.id}/refund`, { reason: 'Concurrent' })),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);

    const row = await harness.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    const refunds = await harness.prisma.refund.findMany({
      where: { paymentId: row.paymentId!, status: 'SUCCEEDED' },
    });
    const refunded = refunds.reduce((sum, r) => sum + r.amountMinor, 0n);
    expect(refunded).toBe(1_000_000n);
    expect(refunds).toHaveLength(1);
  });

  it('never refunds more than was paid under concurrent partial refunds', async () => {
    const appt = await appointment();
    const tx = await started(appt.id);
    await deliver(mock.simulate(tx.providerId, 'SUCCEEDED')).expect(200);

    await Promise.all(
      [1, 2].map(() =>
        post(`/payments/${tx.id}/refund`, { amountMinor: '600000', reason: 'Half and more' }),
      ),
    );
    const row = await harness.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    const refunds = await harness.prisma.refund.findMany({
      where: { paymentId: row.paymentId!, status: 'SUCCEEDED' },
    });
    const refunded = refunds.reduce((sum, r) => sum + r.amountMinor, 0n);
    expect(refunded).toBeLessThanOrEqual(1_000_000n);
    expect(refunds).toHaveLength(1);
  });
});

describe('concurrency — booking', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let owner: string;
  let massage: string;
  let cut: string;
  let e1: string;
  let e2: string;

  const day = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30 + n);
    return d.toISOString().slice(0, 10);
  };
  const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+08:00`;
  const A = () => `/api/v1/companies/${world.companyA.id}`;
  const post = (path: string, body: object) =>
    request(http).post(`${A()}${path}`).set('Authorization', `Bearer ${owner}`).send(body);

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    owner = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    const { prisma } = harness;
    const companyId = world.companyA.id;
    const branchId = world.companyA.branchId;
    await prisma.businessHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        branchId,
        dayOfWeek,
        opensAt: new Date('1970-01-01T09:00:00.000Z'),
        closesAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
    const svc = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.service.create({
        data: {
          companyId,
          name,
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 1000n,
          currencyCode: 'MNT',
          requiresEmployee: true,
          ...extra,
        },
      });
    cut = (await svc('Cut')).id;
    massage = (await svc('Massage', { requiresResource: true })).id;
    const type = await prisma.resourceType.create({
      data: { companyId, key: 'room', name: 'Room', kind: 'ROOM' },
    });
    await prisma.serviceResourceRequirement.create({
      data: { companyId, serviceId: massage, resourceTypeId: type.id, quantity: 1 },
    });
    await prisma.resource.create({
      data: { companyId, branchId, resourceTypeId: type.id, name: 'Only room' },
    });
    await prisma.serviceBranch.createMany({
      data: [cut, massage].map((serviceId) => ({ companyId, serviceId, branchId })),
    });
    const employee = async (name: string) => {
      const e = await prisma.employee.create({
        data: { companyId, displayName: name, status: 'ACTIVE', isBookable: true },
      });
      await prisma.employeeBranch.create({ data: { companyId, employeeId: e.id, branchId } });
      await prisma.employeeService.createMany({
        data: [cut, massage].map((serviceId) => ({ companyId, employeeId: e.id, serviceId })),
      });
      await prisma.employeeSchedule.createMany({
        data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          companyId,
          employeeId: e.id,
          branchId,
          dayOfWeek,
          startsAt: new Date('1970-01-01T09:00:00.000Z'),
          endsAt: new Date('1970-01-01T18:00:00.000Z'),
          effectiveFrom: new Date('2025-01-01'),
        })),
      });
      return e.id;
    };
    e1 = await employee('Ari');
    e2 = await employee('Bat');
  });

  afterAll(async () => harness.close());

  it('two staff racing for the only room: exactly one booking', async () => {
    const book = (employeeId: string) =>
      post('/appointments', {
        branchId: world.companyA.branchId,
        customerId: world.companyA.customerId,
        serviceId: massage,
        employeeId,
        startsAt: at(day(1), '10:00'),
      });
    const results = await Promise.all([book(e1), book(e2), book(e1), book(e2)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  /**
   * Hold the next booking right after its availability check until released,
   * so a competing write can be made exactly inside the race window.
   */
  function holdAfterAvailabilityCheck() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AvailabilityService } = require('../src/availability/availability.service');
    const availability = harness.app.get(AvailabilityService);
    const original = availability.getDay.bind(availability);
    let reached!: () => void;
    let release!: () => void;
    const checked = new Promise<void>((r) => (reached = r));
    const released = new Promise<void>((r) => (release = r));
    const spy = jest
      .spyOn(availability, 'getDay')
      .mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        reached();
        await released;
        return result;
      });
    return { spy, checked, release };
  }

  it('time off approved while a booking is in flight: never both', async () => {
    const hold = holdAfterAvailabilityCheck();
    try {
      const d = day(20);
      const booking = post('/appointments', {
        branchId: world.companyA.branchId,
        customerId: world.companyA.customerId,
        serviceId: cut,
        employeeId: e1,
        startsAt: at(d, '10:00'),
      }).then((r) => r); // supertest sends only once awaited: start it now
      await hold.checked; // the booking has passed its availability check
      const timeOff = await post('/time-off', {
        employeeId: e1,
        type: 'SICK',
        startsAt: at(d, '09:00'),
        endsAt: at(d, '18:00'),
      });
      hold.release();
      const booked = await booking;

      expect(timeOff.status).toBe(201);
      expect(booked.status).toBe(409);
      expect(booked.body.error.code).toBe('SLOT_UNAVAILABLE');
      const inside = await harness.prisma.appointment.count({
        where: { companyId: world.companyA.id, startsAt: new Date(at(d, '10:00')) },
      });
      expect(inside).toBe(0);
    } finally {
      hold.release();
      hold.spy.mockRestore();
    }
  });

  it('a resource blocked while a booking is in flight: never both', async () => {
    const hold = holdAfterAvailabilityCheck();
    try {
      const d = day(21);
      const room = await harness.prisma.resource.findFirstOrThrow({
        where: { companyId: world.companyA.id },
      });
      const booking = post('/appointments', {
        branchId: world.companyA.branchId,
        customerId: world.companyA.customerId,
        serviceId: massage,
        employeeId: e1,
        startsAt: at(d, '10:00'),
      }).then((r) => r);
      await hold.checked;
      const block = await post(`/resources/${room.id}/unavailability`, {
        startsAt: at(d, '09:00'),
        endsAt: at(d, '18:00'),
        reason: 'MAINTENANCE',
      });
      hold.release();
      const booked = await booking;

      expect(block.status).toBe(201);
      expect(booked.status).toBe(409);
      expect(booked.body.error.details.reason).toBe('RESOURCE_UNAVAILABLE');
    } finally {
      hold.release();
      hold.spy.mockRestore();
    }
  });
});

describe('concurrency — time off', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let owner: string;
  let employeeId: string;

  const A = () => `/api/v1/companies/${world.companyA.id}`;
  const send = (method: 'post' | 'patch', path: string, body: object) =>
    request(http)[method](`${A()}${path}`).set('Authorization', `Bearer ${owner}`).send(body);

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    owner = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    const e = await harness.prisma.employee.create({
      data: { companyId: world.companyA.id, displayName: 'Cee', status: 'ACTIVE', isBookable: true },
    });
    employeeId = e.id;
  });

  afterAll(async () => harness.close());

  it('approve and reject at once: the loser is refused, never reported as done', async () => {
    for (let round = 0; round < 3; round++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 90 + round);
      const date = d.toISOString().slice(0, 10);
      // A pending request, as a requester would have made it.
      const { id } = await harness.prisma.employeeTimeOff.create({
        data: {
          companyId: world.companyA.id,
          employeeId,
          type: 'VACATION',
          status: 'PENDING',
          startsAt: new Date(`${date}T01:00:00Z`),
          endsAt: new Date(`${date}T10:00:00Z`),
        },
      });

      const wanted = ['APPROVED', 'REJECTED'] as const;
      const results = await Promise.all(
        wanted.map((status) => send('patch', `/time-off/${id}`, { status })),
      );

      // Whatever the interleaving, a 200 means what was asked for happened.
      const ok = results.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);
      const winner = wanted[results.indexOf(ok[0]!)]!;
      expect(ok[0]!.body.data.status).toBe(winner);
      const row = await harness.prisma.employeeTimeOff.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(winner);
      // And the audit trail records only the change that happened.
      const audited = await harness.prisma.auditLog.findMany({
        where: { resourceId: id, action: { in: ['time_off.approved', 'time_off.rejected'] } },
      });
      expect(audited.map((a) => a.action)).toEqual([`time_off.${winner.toLowerCase()}`]);
    }
  });
});
