import request from 'supertest';
import type { Server } from 'node:http';
import { MailerService } from '../src/mail/mailer.service';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * CUSTOMER PORTAL
 * ===========================================================================
 *
 * Customers and appointments are made through the real public booking
 * endpoint, so cancel and reschedule run against bookings the Appointment
 * Engine itself created. Sign-in codes are captured from the mailer.
 */
describe('customer portal', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let mailer: MailerService;
  let service: string;
  let unique = 0;

  const SLUG = 'company-a';
  const api = (path: string) => `/api/v1${path}`;
  const as = (token?: string) => {
    const auth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
    return {
      get: (path: string) => auth(request(http).get(api(path))),
      post: (path: string, body: object = {}) => auth(request(http).post(api(path))).send(body),
      patch: (path: string, body: object = {}) => auth(request(http).patch(api(path))).send(body),
    };
  };
  const at = (daysAhead: number, hhmm: string) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysAhead);
    return `${d.toISOString().slice(0, 10)}T${hhmm}:00+08:00`;
  };

  /** A new customer, made the way a real one is: by booking online. */
  async function bookAs(email: string, startsAt: string, phone?: string) {
    const res = await request(http)
      .post(api(`/public/companies/${SLUG}/bookings`))
      .send({
        branchId: world.companyA.branchId,
        serviceId: service,
        startsAt,
        customer: { firstName: 'Saraa', lastName: 'Dorj', email, phone: phone ?? phoneFor(email) },
      });
    expect(res.status).toBe(201);
    const appointment = await harness.prisma.appointment.findFirstOrThrow({
      where: { companyId: world.companyA.id, appointmentNumber: res.body.data.appointmentNumber },
    });
    return appointment;
  }
  const phones = new Map<string, string>();
  const phoneFor = (email: string) => {
    if (!phones.has(email)) phones.set(email, `+9768${String(1_000_000 + unique++).slice(-7)}`);
    return phones.get(email)!;
  };
  const newEmail = (label: string) => `portal-${label}-${Date.now()}-${unique++}@example.com`;

  /** Request a code, read it from the mailer, exchange it. */
  async function signIn(email: string, slug = SLUG) {
    const spy = jest.spyOn(mailer, 'sendCustomerSignInCode').mockResolvedValue();
    await as().post(`/customer/auth/${slug}/request-code`, { email }).expect(202);
    const code = spy.mock.calls.at(-1)?.[0].code;
    spy.mockRestore();
    expect(code).toMatch(/^\d{6}$/);
    const res = await as().post(`/customer/auth/${slug}/verify`, { email, code }).expect(200);
    return { token: res.body.data.accessToken as string, cookie: res.headers['set-cookie'] as unknown as string[] };
  }

  async function customerByEmail(email: string, companyId = world.companyA.id) {
    return harness.prisma.companyCustomer.findFirstOrThrow({ where: { companyId, email } });
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    mailer = harness.app.get(MailerService);

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
    service = (
      await prisma.service.create({
        data: {
          companyId,
          name: 'Haircut',
          status: 'ACTIVE',
          durationMin: 60,
          priceMinor: 4_500_000n,
          currencyCode: 'MNT',
          isOnlineBookable: true,
        },
      })
    ).id;
    await prisma.serviceBranch.create({ data: { companyId, serviceId: service, branchId } });
    const employee = await prisma.employee.create({
      data: { companyId, displayName: 'Ari', status: 'ACTIVE', isBookable: true },
    });
    await prisma.employeeProfile.create({
      data: { companyId, employeeId: employee.id, jobTitle: 'Stylist', phone: '+97611112222' },
    });
    await prisma.employeeBranch.create({ data: { companyId, employeeId: employee.id, branchId } });
    await prisma.employeeService.create({ data: { companyId, employeeId: employee.id, serviceId: service } });
    await prisma.employeeSchedule.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        employeeId: employee.id,
        branchId,
        dayOfWeek,
        startsAt: new Date('1970-01-01T09:00:00.000Z'),
        endsAt: new Date('1970-01-01T18:00:00.000Z'),
        effectiveFrom: new Date('2025-01-01'),
      })),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('authentication', () => {
    it('answers a code request the same way whether or not the email is a customer', async () => {
      const spy = jest.spyOn(mailer, 'sendCustomerSignInCode').mockResolvedValue();
      const unknown = await as()
        .post(`/customer/auth/${SLUG}/request-code`, { email: 'nobody@example.com' })
        .expect(202);
      expect(spy).not.toHaveBeenCalled();

      const known = await as()
        .post(`/customer/auth/${SLUG}/request-code`, { email: 'customer@company-a.test' })
        .expect(202);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(known.body.data).toEqual(unknown.body.data);
    });

    it('signs in with the emailed code, links an identity, and sets a scoped HttpOnly cookie', async () => {
      const email = 'customer@company-a.test';
      const { token, cookie } = await signIn(email);
      expect(token).toBeTruthy();
      expect(cookie.join(';')).toMatch(/undarga_crt=.+; Path=\/api\/v1\/customer\/auth\/company-a.*HttpOnly/);

      const customer = await customerByEmail(email);
      expect(customer.customerIdentityId).not.toBeNull();
      const identity = await harness.prisma.customerIdentity.findUniqueOrThrow({
        where: { id: customer.customerIdentityId! },
      });
      expect(identity.emailVerifiedAt).not.toBeNull();

      const me = await as(token).get('/customer/me').expect(200);
      expect(me.body.data).toMatchObject({ email, company: { slug: SLUG } });
    });

    it('refuses a wrong code, and burns the code after five wrong guesses', async () => {
      const email = newEmail('guess');
      await bookAs(email, at(9, '10:00'));
      const spy = jest.spyOn(mailer, 'sendCustomerSignInCode').mockResolvedValue();
      await as().post(`/customer/auth/${SLUG}/request-code`, { email }).expect(202);
      const code = spy.mock.calls[0]![0].code;
      const wrong = code === '000000' ? '111111' : '000000';

      const first = await as().post(`/customer/auth/${SLUG}/verify`, { email, code: wrong }).expect(401);
      expect(first.body.error.code).toBe('SIGN_IN_CODE_INVALID');
      for (let i = 0; i < 4; i++) {
        await as().post(`/customer/auth/${SLUG}/verify`, { email, code: wrong }).expect(401);
      }
      // Burnt: the right code no longer works either.
      await as().post(`/customer/auth/${SLUG}/verify`, { email, code }).expect(401);
    });

    it('counts every one of many parallel wrong guesses', async () => {
      const email = newEmail('parallel-guess');
      await bookAs(email, at(19, '10:00'));
      const spy = jest.spyOn(mailer, 'sendCustomerSignInCode').mockResolvedValue();
      await as().post(`/customer/auth/${SLUG}/request-code`, { email }).expect(202);
      const code = spy.mock.calls[0]![0].code;
      const wrong = (n: number) => String((Number(code) + 1 + n) % 1_000_000).padStart(6, '0');

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          as().post(`/customer/auth/${SLUG}/verify`, { email, code: wrong(n) }),
        ),
      );
      expect(results.every((r) => r.status === 401)).toBe(true);

      const customer = await customerByEmail(email);
      const row = await harness.prisma.customerLoginCode.findFirstOrThrow({
        where: { companyCustomerId: customer.id },
        orderBy: { createdAt: 'desc' },
      });
      // Read-then-write would lose most of these to one another.
      expect(row.attempts).toBeGreaterThanOrEqual(5);
      expect(row.consumedAt).not.toBeNull();
      await as().post(`/customer/auth/${SLUG}/verify`, { email, code }).expect(401);
    });

    it('stops sending codes after five an hour, without saying so', async () => {
      const email = newEmail('cap');
      await bookAs(email, at(9, '17:00'));
      const spy = jest.spyOn(mailer, 'sendCustomerSignInCode').mockResolvedValue();
      const answers = [];
      for (let i = 0; i < 6; i++) {
        const res = await as().post(`/customer/auth/${SLUG}/request-code`, { email }).expect(202);
        answers.push(res.body.data);
      }
      expect(spy).toHaveBeenCalledTimes(5);
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    });

    it('keeps the realms apart', async () => {
      const email = newEmail('realms');
      await bookAs(email, at(9, '13:00'));
      const { token } = await signIn(email);
      // A customer token on a staff route…
      await as(token).get(`/companies/${world.companyA.id}/customers`).expect(401);
      // …and a staff token on a customer route.
      const staff = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
      await as(staff).get('/customer/me').expect(401);
      await as().get('/customer/me').expect(401);
    });

    it('rotates the refresh token and treats reuse as theft', async () => {
      const email = newEmail('rotate');
      await bookAs(email, at(9, '14:00'));
      const { cookie } = await signIn(email);
      const refreshed = await request(http)
        .post(api(`/customer/auth/${SLUG}/refresh`))
        .set('Cookie', cookie)
        .expect(200);
      const next = refreshed.headers['set-cookie'] as unknown as string[];
      const newToken = refreshed.body.data.accessToken as string;
      await as(newToken).get('/customer/me').expect(200);

      // The old cookie again: the whole family is revoked.
      const reused = await request(http).post(api(`/customer/auth/${SLUG}/refresh`)).set('Cookie', cookie).expect(401);
      expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      await request(http).post(api(`/customer/auth/${SLUG}/refresh`)).set('Cookie', next).expect(401);
      await as(newToken).get('/customer/me').expect(401);
    });

    it('two refreshes racing on one cookie: one rotates, the other is caught as reuse', async () => {
      const email = newEmail('race');
      await bookAs(email, at(19, '12:00'));
      const { token, cookie } = await signIn(email);
      const refresh = () =>
        request(http).post(api(`/customer/auth/${SLUG}/refresh`)).set('Cookie', cookie);

      const results = await Promise.all([refresh(), refresh(), refresh()]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(2);
      expect(results.map((r) => r.body.error?.code)).toContain('REFRESH_TOKEN_REUSED');

      const winner = results.find((r) => r.status === 200)!;
      // The family is gone, and so is the old access token.
      await as(winner.body.data.accessToken as string).get('/customer/me').expect(401);
      await as(token).get('/customer/me').expect(401);
    });

    it('stops the old access token as soon as the session rotates', async () => {
      const email = newEmail('rotate-deny');
      await bookAs(email, at(19, '14:00'));
      const { token, cookie } = await signIn(email);
      await as(token).get('/customer/me').expect(200);
      const refreshed = await request(http)
        .post(api(`/customer/auth/${SLUG}/refresh`))
        .set('Cookie', cookie)
        .expect(200);
      await as(token).get('/customer/me').expect(401);
      await as(refreshed.body.data.accessToken as string).get('/customer/me').expect(200);
    });

    it('ends the session on sign-out', async () => {
      const email = newEmail('logout');
      await bookAs(email, at(9, '15:00'));
      const { token } = await signIn(email);
      await as(token).post(`/customer/auth/${SLUG}/logout`).expect(204);
      await as(token).get('/customer/me').expect(401);
    });

    it('ends access as soon as the business blocks the customer', async () => {
      const email = newEmail('blocked');
      await bookAs(email, at(9, '11:00'));
      const { token } = await signIn(email);
      await as(token).get('/customer/me').expect(200);

      await harness.prisma.companyCustomer.updateMany({
        where: { companyId: world.companyA.id, email },
        data: { status: 'BLOCKED' },
      });
      await as(token).get('/customer/me').expect(401);
    });
  });

  // ===========================================================================
  describe('profile', () => {
    it('shows the customer their own details — not the business’s notes', async () => {
      const email = newEmail('notes');
      await bookAs(email, at(9, '16:00'));
      await harness.prisma.companyCustomer.updateMany({
        where: { companyId: world.companyA.id, email },
        data: { notes: 'Difficult client', tags: ['vip'] },
      });
      const { token } = await signIn(email);
      const res = await as(token).get('/customer/me').expect(200);
      expect(JSON.stringify(res.body.data)).not.toMatch(/Difficult|vip|loyalty|totalSpent/);
    });

    it('updates permitted fields and validates them', async () => {
      const email = newEmail('profile');
      await bookAs(email, at(9, '12:00'));
      const { token } = await signIn(email);

      const updated = await as(token).patch('/customer/me', { firstName: 'Sarnai', phone: '+976 9911 0099' }).expect(200);
      expect(updated.body.data).toMatchObject({ firstName: 'Sarnai', phone: '+97699110099' });

      await as(token).patch('/customer/me', { firstName: '' }).expect(400);
      await as(token).patch('/customer/me', { phone: 'not a phone' }).expect(400);
      // Email is the sign-in address; it is not editable here.
      await as(token).patch('/customer/me', { email: 'x@example.com' }).expect(400);
      await as(token).patch('/customer/me', {}).expect(400);

      // Another customer's number.
      const seeded = await harness.prisma.companyCustomer.findUniqueOrThrow({ where: { id: world.companyA.customerId } });
      const dup = await as(token).patch('/customer/me', { phone: seeded.phone }).expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');
    });
  });

  // ===========================================================================
  describe('appointments', () => {
    it('lists only the customer’s own appointments, paginated', async () => {
      const email = newEmail('list');
      await bookAs(email, at(10, '10:00'));
      await bookAs(email, at(10, '12:00'));
      const other = await bookAs(newEmail('other'), at(10, '14:00'));
      const { token } = await signIn(email);

      const page1 = await as(token).get('/customer/appointments?scope=upcoming&limit=1').expect(200);
      expect(page1.body.data).toMatchObject({ total: 2, limit: 1, offset: 0 });
      expect(page1.body.data.items).toHaveLength(1);
      const page2 = await as(token).get('/customer/appointments?scope=upcoming&limit=1&offset=1').expect(200);
      expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);

      const all = [...page1.body.data.items, ...page2.body.data.items].map((a: { id: string }) => a.id);
      expect(all).not.toContain(other.id);

      await as(token).get('/customer/appointments?limit=0').expect(400);
      await as(token).get('/customer/appointments?scope=everything').expect(400);
    });

    it('shows details with actions and nothing internal', async () => {
      const email = newEmail('detail');
      const appt = await bookAs(email, at(11, '10:00'));
      await harness.prisma.appointment.update({ where: { id: appt.id }, data: { internalNote: 'Owes us money' } });
      const { token } = await signIn(email);

      const res = await as(token).get(`/customer/appointments/${appt.id}`).expect(200);
      expect(res.body.data).toMatchObject({
        id: appt.id,
        service: 'Haircut',
        employee: 'Ari',
        branch: { name: 'Company A main branch' },
        price: { totalMinor: '4500000', currencyCode: 'MNT' },
        payment: { status: 'UNPAID', outstandingMinor: '4500000' },
        actions: { cancel: { allowed: true }, reschedule: { allowed: true } },
      });
      const body = JSON.stringify(res.body.data);
      expect(body).not.toMatch(/Owes us money|Stylist|\+97611112222|employeeId|internalNote/);
    });

    it('refuses another customer’s appointment as not found', async () => {
      const mine = newEmail('mine');
      await bookAs(mine, at(11, '12:00'));
      const theirs = await bookAs(newEmail('theirs'), at(11, '14:00'));
      const { token } = await signIn(mine);

      await as(token).get(`/customer/appointments/${theirs.id}`).expect(404);
      await as(token).post(`/customer/appointments/${theirs.id}/cancel`).expect(404);
      await as(token)
        .post(`/customer/appointments/${theirs.id}/reschedule`, { startsAt: at(12, '10:00') })
        .expect(404);
      expect(
        (await harness.prisma.appointment.findUniqueOrThrow({ where: { id: theirs.id } })).status,
      ).not.toBe('CANCELLED');
    });
  });

  // ===========================================================================
  describe('cancellation and rescheduling rules', () => {
    async function setRules(data: Record<string, unknown>) {
      await harness.prisma.companySettings.update({ where: { companyId: world.companyA.id }, data });
    }
    afterEach(async () => {
      await setRules({ allowCustomerCancel: true, allowCustomerReschedule: true, cancellationWindowHours: 24 });
    });

    it('cancels when allowed, through the Appointment Engine', async () => {
      const email = newEmail('cancel');
      const appt = await bookAs(email, at(12, '11:00'));
      const { token } = await signIn(email);

      const res = await as(token).post(`/customer/appointments/${appt.id}/cancel`, { reason: 'Sick' }).expect(200);
      expect(res.body.data.status).toBe('CANCELLED');
      const row = await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
      expect(row).toMatchObject({ cancelledByType: 'CUSTOMER', cancellationReason: 'Customer: Sick' });

      const cancelled = await as(token).get('/customer/appointments?scope=cancelled').expect(200);
      expect(cancelled.body.data.items.map((a: { id: string }) => a.id)).toContain(appt.id);
      // And it cannot be cancelled twice.
      await as(token).post(`/customer/appointments/${appt.id}/cancel`).expect(409);
    });

    it('refuses after the cancellation deadline', async () => {
      const email = newEmail('late');
      const appt = await bookAs(email, at(12, '13:00'));
      const { token } = await signIn(email);
      await setRules({ cancellationWindowHours: 720 });

      const detail = await as(token).get(`/customer/appointments/${appt.id}`).expect(200);
      expect(detail.body.data.actions.cancel).toMatchObject({ allowed: false, reason: 'PAST_DEADLINE' });

      const res = await as(token).post(`/customer/appointments/${appt.id}/cancel`).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CUSTOMER_ACTION_NOT_ALLOWED',
        details: { action: 'cancel', reason: 'PAST_DEADLINE' },
      });
      await as(token)
        .post(`/customer/appointments/${appt.id}/reschedule`, { startsAt: at(13, '10:00') })
        .expect(409);
    });

    it('refuses when the business does not allow it online', async () => {
      const email = newEmail('policy');
      const appt = await bookAs(email, at(12, '15:00'));
      const { token } = await signIn(email);
      await setRules({ allowCustomerCancel: false, allowCustomerReschedule: false });

      const cancel = await as(token).post(`/customer/appointments/${appt.id}/cancel`).expect(409);
      expect(cancel.body.error.details.reason).toBe('NOT_ALLOWED_BY_BUSINESS');
      const move = await as(token)
        .post(`/customer/appointments/${appt.id}/reschedule`, { startsAt: at(13, '11:00') })
        .expect(409);
      expect(move.body.error.details.reason).toBe('NOT_ALLOWED_BY_BUSINESS');
    });

    it('refuses while an online payment is in flight', async () => {
      const email = newEmail('inflight');
      const appt = await bookAs(email, at(12, '16:00'));
      await harness.prisma.paymentTransaction.create({
        data: {
          companyId: world.companyA.id,
          kind: 'APPOINTMENT',
          status: 'PENDING',
          appointmentId: appt.id,
          initiatedByType: 'CUSTOMER',
          amountMinor: 1000n,
          currencyCode: 'MNT',
          provider: 'mock',
          idempotencyKey: `portal-${unique++}`,
        },
      });
      const { token } = await signIn(email);
      const res = await as(token).post(`/customer/appointments/${appt.id}/cancel`).expect(409);
      expect(res.body.error.details.reason).toBe('PAYMENT_IN_PROGRESS');
    });

    it('offers public times and reschedules through the engine', async () => {
      const email = newEmail('move');
      const appt = await bookAs(email, at(14, '10:00'));
      const { token } = await signIn(email);

      const day = at(15, '10:00').slice(0, 10);
      const options = await as(token)
        .get(`/customer/appointments/${appt.id}/reschedule-options?date=${day}`)
        .expect(200);
      expect(options.body.data.slots.length).toBeGreaterThan(0);
      expect(Object.keys(options.body.data.slots[0])).toEqual(['startAt', 'endAt']);

      const moved = await as(token)
        .post(`/customer/appointments/${appt.id}/reschedule`, { startsAt: options.body.data.slots[0].startAt })
        .expect(200);
      expect(moved.body.data.id).not.toBe(appt.id);
      expect(moved.body.data.status).toBe('CONFIRMED');

      // The old booking is a mechanism, not a cancellation the customer made.
      const cancelled = await as(token).get('/customer/appointments?scope=cancelled').expect(200);
      expect(cancelled.body.data.items.map((a: { id: string }) => a.id)).not.toContain(appt.id);
    });

    it('refuses a time public booking does not offer', async () => {
      const email = newEmail('closed');
      const appt = await bookAs(email, at(14, '12:00'));
      const { token } = await signIn(email);
      const res = await as(token)
        .post(`/customer/appointments/${appt.id}/reschedule`, { startsAt: at(15, '03:00') })
        .expect(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('leaves moving a paid booking to the business', async () => {
      const email = newEmail('paid');
      const appt = await bookAs(email, at(14, '14:00'));
      await harness.prisma.appointment.update({
        where: { id: appt.id },
        data: { paidMinor: 4_500_000n, paymentStatus: 'PAID' },
      });
      const { token } = await signIn(email);
      const res = await as(token)
        .post(`/customer/appointments/${appt.id}/reschedule`, { startsAt: at(15, '14:00') })
        .expect(409);
      expect(res.body.error.details.reason).toBe('ALREADY_PAID');
    });
  });

  // ===========================================================================
  describe('payments', () => {
    it('shows the customer’s own payments, without provider details', async () => {
      const email = newEmail('pay');
      const appt = await bookAs(email, at(16, '10:00'));
      const theirs = await bookAs(newEmail('pay-other'), at(16, '12:00'));
      const payment = (appointmentId: string, customerId: string, n: string) =>
        harness.prisma.payment.create({
          data: {
            companyId: world.companyA.id,
            appointmentId,
            customerId,
            paymentNumber: `PORTAL-${n}-${unique++}`,
            method: 'ONLINE',
            status: 'SUCCEEDED',
            amountMinor: 1_000_000n,
            feeMinor: 20_000n,
            currencyCode: 'MNT',
            provider: 'qpay',
            providerChargeId: 'qpay-secret-ref',
            providerIntentId: 'qpay-invoice',
          },
        });
      await payment(appt.id, appt.customerId, 'MINE');
      await payment(theirs.id, theirs.customerId, 'THEIRS');
      const { token } = await signIn(email);

      const res = await as(token).get('/customer/payments').expect(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0]).toMatchObject({ method: 'ONLINE', amountMinor: '1000000', appointmentId: appt.id });
      expect(res.body.data.summary.paidMinor).toBe('1000000');
      expect(JSON.stringify(res.body.data)).not.toMatch(/qpay|fee|provider/i);

      await as(token).get('/customer/payments?limit=500').expect(400);
    });
  });

  // ===========================================================================
  describe('gift cards', () => {
    async function giftCard(data: { issuedToCustomerId?: string | null; purchasedByCustomerId?: string | null }) {
      const card = await harness.prisma.giftCard.create({
        data: {
          companyId: world.companyA.id,
          codeHash: `hash-${Date.now()}-${unique++}`,
          codeLast4: String(1000 + unique).slice(-4),
          status: 'ACTIVE',
          initialBalanceMinor: 5_000_000n,
          currentBalanceMinor: 3_000_000n,
          currencyCode: 'MNT',
          recipientName: 'A friend',
          issuedAt: new Date(),
          ...data,
        },
      });
      await harness.prisma.giftCardTransaction.createMany({
        data: [
          { companyId: world.companyA.id, giftCardId: card.id, type: 'ISSUE', amountMinor: 5_000_000n, balanceAfterMinor: 5_000_000n, currencyCode: 'MNT', performedByType: 'SYSTEM' },
          { companyId: world.companyA.id, giftCardId: card.id, type: 'REDEEM', amountMinor: -2_000_000n, balanceAfterMinor: 3_000_000n, currencyCode: 'MNT', performedByType: 'SYSTEM' },
        ],
      });
      return card;
    }

    it('shows balances to the holder only', async () => {
      const email = newEmail('gift');
      await bookAs(email, at(17, '10:00'));
      const me = await customerByEmail(email);
      const friendEmail = newEmail('friend');
      await bookAs(friendEmail, at(17, '12:00'));
      const friend = await customerByEmail(friendEmail);

      const held = await giftCard({ issuedToCustomerId: me.id });
      const givenAway = await giftCard({ purchasedByCustomerId: me.id, issuedToCustomerId: friend.id });
      const strangers = await giftCard({ issuedToCustomerId: friend.id });
      const { token } = await signIn(email);

      const res = await as(token).get('/customer/gift-cards').expect(200);
      const byId = Object.fromEntries(res.body.data.items.map((c: { id: string }) => [c.id, c]));
      expect(byId[held.id]).toMatchObject({ relation: 'HOLDER', balanceMinor: '3000000' });
      expect(byId[givenAway.id]).toMatchObject({ relation: 'PURCHASER', balanceMinor: null, recipientName: 'A friend' });
      expect(byId[strangers.id]).toBeUndefined();
      expect(JSON.stringify(res.body.data)).not.toMatch(/hash-/);

      const history = await as(token).get(`/customer/gift-cards/${held.id}/transactions?limit=1`).expect(200);
      expect(history.body.data).toMatchObject({ total: 2, limit: 1 });
      expect(history.body.data.giftCard.balanceMinor).toBe('3000000');

      await as(token).get(`/customer/gift-cards/${givenAway.id}/transactions`).expect(404);
      await as(token).get(`/customer/gift-cards/${strangers.id}/transactions`).expect(404);
    });
  });

  // ===========================================================================
  describe('cross-company isolation', () => {
    it('a customer of two businesses sees each one only through its own sign-in', async () => {
      const email = newEmail('both');
      const inA = await bookAs(email, at(18, '10:00'));
      // The same person is also a customer of company B.
      const bCustomer = await harness.prisma.companyCustomer.create({
        data: { companyId: world.companyB.id, firstName: 'Saraa', email, phone: phoneFor(email) },
      });

      const a = await signIn(email, 'company-a');
      const b = await signIn(email, 'company-b');

      // One identity, two company records.
      const aCustomer = await customerByEmail(email);
      const bLinked = await harness.prisma.companyCustomer.findUniqueOrThrow({ where: { id: bCustomer.id } });
      expect(bLinked.customerIdentityId).toBe(aCustomer.customerIdentityId);

      const bList = await as(b.token).get('/customer/appointments?scope=upcoming').expect(200);
      expect(bList.body.data.total).toBe(0);
      await as(b.token).get(`/customer/appointments/${inA.id}`).expect(404);
      const bMe = await as(b.token).get('/customer/me').expect(200);
      expect(bMe.body.data.company.slug).toBe('company-b');

      // Company A's refresh cookie is not company B's.
      await request(http).post(api('/customer/auth/company-b/refresh')).set('Cookie', a.cookie).expect(401);
      await as(a.token).get(`/customer/appointments/${inA.id}`).expect(200);
    });

    it('cannot use a staff route even for its own company', async () => {
      const email = newEmail('staff-route');
      await bookAs(email, at(18, '12:00'));
      const { token } = await signIn(email);
      await as(token).get(`/companies/${world.companyA.id}/appointments`).expect(401);
      await as(token).get(`/companies/${world.companyA.id}/payments`).expect(401);
    });
  });
});
