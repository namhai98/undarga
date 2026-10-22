import type { AppointmentStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { CalendarSchedulerService } from '../src/calendar/calendar-scheduler.service';
import { MAX_SYNC_ATTEMPTS } from '../src/calendar/calendar-sync.service';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * CALENDAR INTEGRATION
 * ===========================================================================
 *
 * The real Google adapter, against a fake Google: `fetch` is replaced for the
 * whole suite and every Google URL is answered in memory (OAuth token
 * endpoint, revoke, calendar list, events). Nothing reaches a network.
 * Microsoft is deliberately unconfigured in test-env.ts.
 *
 * Sync is one-way: appointments → calendar, and busy periods read back. The
 * background timer is off in tests; each test turns the handle itself.
 */

interface FakeEvent {
  id: string;
  summary: string;
  description: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  status?: string;
  extendedProperties?: { private?: Record<string, string> };
}

class FakeGoogle {
  calls: Array<{ method: string; url: URL; auth: string | null; body: string }> = [];
  calendars = new Map<string, Map<string, FakeEvent>>();
  busyItems: unknown[] = [];
  accessTokens = new Set<string>();
  refreshRevoked = false;
  failures: Array<{ when: (method: string, url: URL) => boolean; status: number; body?: unknown }> = [];
  private n = 0;

  reset() {
    this.calls = [];
    this.calendars.clear();
    this.busyItems = [];
    this.accessTokens.clear();
    this.refreshRevoked = false;
    this.failures = [];
  }

  /** Every event in a calendar. */
  events(calendarId = 'primary') {
    return [...(this.calendars.get(calendarId)?.values() ?? [])];
  }

  failNext(when: (method: string, url: URL) => boolean, status: number, body?: unknown) {
    this.failures.push({ when, status, body });
  }

  handle(input: string, init: RequestInit = {}): Response {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : '';
    this.calls.push({ method, url, auth: headers.Authorization ?? null, body });

    const failure = this.failures.findIndex((f) => f.when(method, url));
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1);
      return json(f!.body ?? { error: { message: `simulated ${f!.status}` } }, f!.status);
    }

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
        return json(this.issue(true));
      }
      if (this.refreshRevoked) return json({ error: 'invalid_grant' }, 400);
      return json(this.issue(false));
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') return json({});
    if (url.host !== 'www.googleapis.com') throw new Error(`Unexpected request to ${url.host}`);

    const token = (headers.Authorization ?? '').replace('Bearer ', '');
    if (!this.accessTokens.has(token)) return json({ error: { message: 'Invalid Credentials' } }, 401);

    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return json({
        items: [
          { id: 'ari@example.com', summary: 'Ari', primary: true, timeZone: 'Asia/Ulaanbaatar' },
          { id: 'work@group.calendar.google.com', summary: 'Work', timeZone: 'Asia/Ulaanbaatar' },
        ],
      });
    }
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return json({ error: { message: 'not found' } }, 404);
    const calendarId = decodeURIComponent(match[1]!);
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;
    const events = this.calendars.get(calendarId) ?? new Map<string, FakeEvent>();
    this.calendars.set(calendarId, events);

    if (method === 'GET' && !eventId) return json({ timeZone: 'Asia/Ulaanbaatar', items: this.busyItems });
    if (method === 'POST') {
      const event = JSON.parse(body) as FakeEvent;
      if (events.has(event.id)) return json({ error: { message: 'The requested identifier already exists.' } }, 409);
      events.set(event.id, event);
      return json(event);
    }
    if (!eventId || !events.has(eventId)) return json({ error: { message: 'Not Found' } }, method === 'DELETE' ? 410 : 404);
    if (method === 'PATCH') {
      events.set(eventId, { ...events.get(eventId)!, ...(JSON.parse(body) as FakeEvent) });
      return json(events.get(eventId));
    }
    if (method === 'DELETE') {
      events.delete(eventId);
      return new Response(null, { status: 204 });
    }
    return json({ error: { message: 'unsupported' } }, 400);
  }

  private issue(withRefresh: boolean) {
    const accessToken = `at-${++this.n}-not-a-real-token`;
    this.accessTokens.add(accessToken);
    return {
      access_token: accessToken,
      ...(withRefresh ? { refresh_token: 'rt-secret-refresh-token' } : {}),
      expires_in: 3600,
      scope:
        'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      id_token: `h.${Buffer.from(JSON.stringify({ email: 'ari.calendar@example.com' })).toString('base64url')}.s`,
    };
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('calendar integration', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;
  let scheduler: CalendarSchedulerService;
  const google = new FakeGoogle();

  let haircut: string;
  let ari: string;
  let bea: string;
  let ariToken: string;
  let slot = 0;
  let unique = 0;

  const api = (path: string, companyId = world.companyA.id) => `/api/v1/companies/${companyId}/${path}`;
  const as = (token: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => request(http).post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => request(http).patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => request(http).delete(path).set('Authorization', `Bearer ${token}`),
  });
  const run = () => scheduler.runOnce({ companyId: world.companyA.id });

  /** A unique 10:00-ish local slot, 30+ days out. */
  function nextStart(): string {
    const n = slot++;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30 + Math.floor(n / 8));
    return `${d.toISOString().slice(0, 10)}T${String(9 + (n % 8)).padStart(2, '0')}:00:00+08:00`;
  }

  async function book(employeeId = ari, startsAt = nextStart()) {
    const res = await as(ownerA).post(api('appointments'), {
      branchId: world.companyA.branchId,
      serviceId: haircut,
      employeeId,
      customerId: world.companyA.customerId,
      startsAt,
    });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; status: string; appointmentNumber: string };
  }

  async function member(roleKey: string) {
    const known = await harness.prisma.userAccount.findFirstOrThrow({ where: { id: world.userA.id } });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `cal-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await harness.prisma.companyRole.findFirstOrThrow({ where: { companyId: world.companyA.id, key: roleKey } });
    await harness.prisma.companyUserRole.create({
      data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id },
    });
    return { account, token: await harness.staffTokenForCompany(account.email, world.companyA.id) };
  }

  /** Start → (the browser goes to Google) → callback. Returns the connection status. */
  async function connect(employeeId = ari, token = ownerA) {
    const started = await as(token).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId }).expect(200);
    const state = new URL(started.body.data.authorizationUrl as string).searchParams.get('state')!;
    const done = await as(token).post(api('calendar-connections/oauth/callback'), { state, code: 'good-code' }).expect(200);
    return done.body.data as { connection: { id: string; status: string; [k: string]: unknown } };
  }

  const links = (appointmentId: string) => harness.prisma.calendarEventLink.findMany({ where: { appointmentId } });
  const job = (appointmentId: string) =>
    harness.prisma.calendarSyncJob.findUnique({
      where: { companyId_appointmentId: { companyId: world.companyA.id, appointmentId } },
    });
  const eventCalls = () => google.calls.filter((c) => c.url.pathname.includes('/events'));

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
    scheduler = harness.app.get(CalendarSchedulerService);

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
    haircut = (
      await prisma.service.create({
        data: { companyId, name: 'Haircut', status: 'ACTIVE', durationMin: 60, priceMinor: 4500n, currencyCode: 'MNT', requiresEmployee: true },
      })
    ).id;
    await prisma.serviceBranch.create({ data: { companyId, serviceId: haircut, branchId } });
    for (const name of ['Ari', 'Bea']) {
      const employee = await prisma.employee.create({ data: { companyId, displayName: name, status: 'ACTIVE', isBookable: true } });
      await prisma.employeeBranch.create({ data: { companyId, employeeId: employee.id, branchId } });
      await prisma.employeeService.create({ data: { companyId, employeeId: employee.id, serviceId: haircut } });
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
      if (name === 'Ari') ari = employee.id;
      else bea = employee.id;
    }
    // Ari logs in as an EMPLOYEE (schedule:write:own only).
    const login = await member(SYSTEM_ROLES.EMPLOYEE);
    await prisma.employee.update({ where: { id: ari }, data: { userAccountId: login.account.id } });
    ariToken = login.token;

    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(google.handle(String(input instanceof Request ? input.url : input), init)),
      );
  });

  beforeEach(async () => {
    google.reset();
    await harness.prisma.calendarConnection.deleteMany({});
    await harness.prisma.calendarOAuthState.deleteMany({});
    await harness.prisma.calendarSyncJob.deleteMany({});
    // Each test starts with no live bookings, so a new connection's backfill
    // is about this test's appointments only (and slots are free again).
    const live = { companyId: world.companyA.id, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'] as AppointmentStatus[] } };
    await harness.prisma.appointmentItem.updateMany({ where: live, data: { status: 'CANCELLED' } });
    await harness.prisma.appointment.updateMany({ where: live, data: { status: 'CANCELLED' } });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await harness.close();
  });

  // ===========================================================================
  describe('providers and connection', () => {
    it('lists the providers this server can use — Microsoft is not configured, and not faked', async () => {
      const res = await as(ownerA).get(api('calendar-connections')).expect(200);
      expect(res.body.data).toMatchObject({ syncDirection: 'one-way', encryptionAvailable: true });
      expect(res.body.data.providers).toEqual([
        expect.objectContaining({ provider: 'google', configured: true }),
        expect.objectContaining({ provider: 'microsoft', configured: false }),
      ]);
      const names = res.body.data.employees.map((e: { displayName: string }) => e.displayName);
      expect(names).toEqual(expect.arrayContaining(['Ari', 'Bea']));

      const ms = await as(ownerA).post(api('calendar-connections/oauth/start'), { provider: 'microsoft', employeeId: ari });
      expect(ms.status).toBe(503);
      expect(ms.body.error.code).toBe('CALENDAR_PROVIDER_UNAVAILABLE');
    });

    it('starts OAuth with PKCE, the configured redirect URL and minimal scopes, storing only a hash of the state', async () => {
      const res = await as(ownerA).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId: ari }).expect(200);
      const url = new URL(res.body.data.authorizationUrl as string);
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.undarga.test/calendar/callback');
      expect(url.searchParams.get('client_id')).toBe('test-client.apps.googleusercontent.test');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).not.toMatch(/auth\/calendar(\s|$)/);
      const state = url.searchParams.get('state')!;
      const row = await harness.prisma.calendarOAuthState.findFirstOrThrow({ where: { employeeId: ari } });
      expect(row.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(state);
    });

    it('connects, sending the PKCE verifier, and keeps the tokens encrypted and out of every response', async () => {
      const started = await as(ownerA).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId: ari }).expect(200);
      const url = new URL(started.body.data.authorizationUrl as string);
      const done = await as(ownerA)
        .post(api('calendar-connections/oauth/callback'), { state: url.searchParams.get('state'), code: 'good-code' })
        .expect(200);

      const tokenCall = google.calls.find((c) => c.url.pathname === '/token')!;
      const form = new URLSearchParams(tokenCall.body);
      expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
        url.searchParams.get('code_challenge'),
      );
      expect(form.get('redirect_uri')).toBe('https://app.undarga.test/calendar/callback');

      expect(done.body.data.connection).toMatchObject({
        provider: 'google',
        status: 'ACTIVE',
        accountEmail: 'ari.calendar@example.com',
        calendarId: 'primary',
        calendarName: 'Ari',
        calendarTimeZone: 'Asia/Ulaanbaatar',
      });
      const overview = await as(ownerA).get(api('calendar-connections')).expect(200);
      for (const text of [done.text, overview.text]) {
        expect(text).not.toMatch(/at-\d+-not-a-real-token|rt-secret-refresh-token/);
      }
      const stored = await harness.prisma.calendarConnection.findFirstOrThrow({ where: { employeeId: ari } });
      expect(stored.credentials).not.toMatch(/not-a-real-token|rt-secret/);
      expect(stored.credentials.startsWith('v1.')).toBe(true);
      const audit = await harness.prisma.auditLog.findMany({ where: { resourceType: 'CalendarConnection' } });
      expect(JSON.stringify(audit)).not.toMatch(/not-a-real-token|rt-secret/);
    });

    it('refuses an unknown, reused, expired or someone else’s OAuth state', async () => {
      const bad = (token: string, body: object, companyId = world.companyA.id) =>
        as(token).post(api('calendar-connections/oauth/callback', companyId), body);

      expect((await bad(ownerA, { state: 'x'.repeat(43), code: 'good-code' }).expect(400)).body.error.code).toBe(
        'CALENDAR_OAUTH_INVALID',
      );

      const start = async () =>
        new URL(
          (await as(ownerA).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId: bea }).expect(200))
            .body.data.authorizationUrl as string,
        ).searchParams.get('state')!;

      // Reused.
      const once = await start();
      await bad(ownerA, { state: once, code: 'good-code' }).expect(200);
      await bad(ownerA, { state: once, code: 'good-code' }).expect(400);

      // Expired.
      const late = await start();
      await harness.prisma.calendarOAuthState.updateMany({
        where: { stateHash: createHash('sha256').update(late).digest('hex') },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await bad(ownerA, { state: late, code: 'good-code' }).expect(400);

      // Another user of the same company, and another company.
      const mine = await start();
      const admin = await member(SYSTEM_ROLES.ADMIN);
      await bad(admin.token, { state: mine, code: 'good-code' }).expect(400);
      await bad(ownerB, { state: mine, code: 'good-code' }, world.companyB.id).expect(400);
      // The real owner still can: the failed attempts did not consume it.
      await bad(ownerA, { state: mine, code: 'good-code' }).expect(200);
    });

    it('reports a code Google refuses without storing anything', async () => {
      const started = await as(ownerA).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId: ari }).expect(200);
      const state = new URL(started.body.data.authorizationUrl as string).searchParams.get('state');
      const res = await as(ownerA).post(api('calendar-connections/oauth/callback'), { state, code: 'bad-code' }).expect(502);
      expect(res.body.error.code).toBe('CALENDAR_PROVIDER_ERROR');
      expect(await harness.prisma.calendarConnection.count()).toBe(0);
    });
  });

  // ===========================================================================
  describe('appointment synchronisation', () => {
    it('creates the event in the background, with service, time and branch only', async () => {
      await connect();
      const appointment = await book();
      // Nothing on the request path: only the job.
      expect(eventCalls().filter((c) => c.method === 'POST')).toHaveLength(0);
      expect(await job(appointment.id)).toMatchObject({ status: 'PENDING' });

      await run();
      const [event] = google.events();
      expect(event).toBeDefined();
      const branch = await harness.prisma.branch.findUniqueOrThrow({ where: { id: world.companyA.branchId } });
      expect(event!.summary).toBe(`Haircut · ${branch.name}`);
      expect(event!.description).toContain(appointment.appointmentNumber);
      expect(event!.start.timeZone).toBe('Asia/Ulaanbaatar');
      const stored = await harness.prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(new Date(event!.start.dateTime).getTime()).toBe(stored.startsAt.getTime());
      expect(new Date(event!.end.dateTime).getTime()).toBe(stored.endsAt.getTime());
      const customer = await harness.prisma.companyCustomer.findUniqueOrThrow({ where: { id: world.companyA.customerId } });
      const text = JSON.stringify(event);
      for (const secret of [customer.firstName, customer.email!, customer.phone!]) expect(text).not.toContain(secret);

      expect(await links(appointment.id)).toHaveLength(1);
      expect(await job(appointment.id)).toMatchObject({ status: 'DONE' });
      // Nothing changed: no further calls.
      google.calls = [];
      await harness.prisma.calendarSyncJob.updateMany({ data: { status: 'PENDING', nextAttemptAt: new Date() } });
      await run();
      expect(eventCalls().filter((c) => c.method !== 'GET')).toHaveLength(0);
    });

    it('keeps one job per appointment however often it changes, and syncs once', async () => {
      await connect();
      const appointment = await book();
      // A status change while the first job is still queued.
      await as(ownerA).post(api(`appointments/${appointment.id}/start`));
      const jobs = await harness.prisma.calendarSyncJob.findMany({ where: { appointmentId: appointment.id } });
      expect(jobs).toHaveLength(1);
      await Promise.all([run(), run()]);
      expect(google.events()).toHaveLength(1);
      expect(eventCalls().filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('moves the event on reschedule and removes it on cancellation', async () => {
      await connect();
      const appointment = await book();
      await run();
      expect(google.events()).toHaveLength(1);

      const moved = await as(ownerA)
        .post(api(`appointments/${appointment.id}/reschedule`), { startsAt: nextStart(), employeeId: ari })
        .expect((r) => expect([200, 201]).toContain(r.status));
      const replacementId = (moved.body.data.id ?? moved.body.data.appointment?.id) as string;
      await run();
      const events = google.events();
      expect(events).toHaveLength(1);
      expect(events[0]!.extendedProperties?.private?.undargaAppointmentId).toBe(replacementId);
      expect(await links(appointment.id)).toHaveLength(0);

      await as(ownerA).post(api(`appointments/${replacementId}/cancel`), { reason: 'Customer asked' }).expect(200);
      await run();
      expect(google.events()).toHaveLength(0);
      expect(await links(replacementId)).toHaveLength(0);
    });

    it('keeps completed appointments only when the connection asks for it', async () => {
      const { connection } = await connect();
      const appointment = await book();
      await run();
      await harness.prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'COMPLETED' } });
      await harness.prisma.appointmentItem.updateMany({ where: { appointmentId: appointment.id }, data: { status: 'COMPLETED' } });

      await harness.prisma.calendarSyncJob.updateMany({ data: { status: 'PENDING', nextAttemptAt: new Date() } });
      await run();
      expect(google.events()[0]!.description).toContain('Completed');

      await as(ownerA).patch(api(`calendar-connections/${connection.id}`), { syncCompleted: false }).expect(200);
      await run();
      expect(google.events()).toHaveLength(0);
    });

    it('adopts an event a lost answer already created, instead of duplicating it', async () => {
      await connect();
      const appointment = await book();
      // The first create reached Google but its answer was lost.
      google.failNext((m, u) => m === 'POST' && u.pathname.endsWith('/events'), 503);
      await run();
      expect(await job(appointment.id)).toMatchObject({ status: 'PENDING', attempts: 1 });
      const [first] = await Promise.all([job(appointment.id)]);
      expect(first!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

      // Pretend it was created anyway, then retry now.
      const id = `ud${createHash('sha256').update(`${(await harness.prisma.calendarConnection.findFirstOrThrow()).id}:${appointment.id}:primary`).digest('hex').slice(0, 40)}`;
      google.calendars.set('primary', new Map([[id, { id, summary: 'x', description: 'x', start: { dateTime: '', timeZone: '' }, end: { dateTime: '', timeZone: '' } }]]));
      await harness.prisma.calendarSyncJob.updateMany({ data: { nextAttemptAt: new Date() } });
      await run();
      expect(google.events()).toHaveLength(1);
      expect(google.events()[0]!.summary).toMatch(/^Haircut/);
      expect(await job(appointment.id)).toMatchObject({ status: 'DONE' });
    });

    it('retries outages and throttling with backoff, then gives up with the error recorded', async () => {
      await connect();
      const appointment = await book();
      google.failNext((m) => m === 'POST', 429, { error: { message: 'Rate Limit Exceeded' } });
      await run();
      let row = await job(appointment.id);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(row!.lastError).toContain('429');
      const connection = await harness.prisma.calendarConnection.findFirstOrThrow();
      expect(connection.lastError).toContain('429');

      // Last attempt fails: FAILED, not retried forever.
      await harness.prisma.calendarSyncJob.updateMany({ data: { attempts: MAX_SYNC_ATTEMPTS - 1, nextAttemptAt: new Date() } });
      google.failNext((m) => m === 'POST', 503);
      await run();
      row = await job(appointment.id);
      expect(row).toMatchObject({ status: 'FAILED', attempts: MAX_SYNC_ATTEMPTS });

      // A manual sync picks it up again.
      const res = await as(ownerA).post(api(`calendar-connections/${connection.id}/sync`)).expect(200);
      expect(res.body.data.queued).toBeGreaterThanOrEqual(1);
      expect(google.events()).toHaveLength(1);
      expect((await job(appointment.id))!.status).toBe('DONE');
    });

    it('refreshes an expired access token and keeps syncing', async () => {
      await connect();
      await harness.prisma.calendarConnection.updateMany({ data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
      const before = (await harness.prisma.calendarConnection.findFirstOrThrow()).credentials;
      await book();
      await run();
      const refresh = google.calls.find((c) => c.url.pathname === '/token' && new URLSearchParams(c.body).get('grant_type') === 'refresh_token');
      expect(refresh).toBeDefined();
      expect(new URLSearchParams(refresh!.body).get('refresh_token')).toBe('rt-secret-refresh-token');
      expect(google.events()).toHaveLength(1);
      const after = await harness.prisma.calendarConnection.findFirstOrThrow();
      expect(after.credentials).not.toBe(before);
      expect(after.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('marks a revoked grant for reauthorisation, stops syncing, and recovers on reconnect', async () => {
      const { connection } = await connect();
      google.accessTokens.clear(); // every access token now 401s
      google.refreshRevoked = true; // and the refresh token is dead
      const appointment = await book();
      await run();
      const stored = await harness.prisma.calendarConnection.findFirstOrThrow();
      expect(stored).toMatchObject({ status: 'NEEDS_REAUTH' });
      expect(stored.lastError).toMatch(/Reconnect/);
      expect(await job(appointment.id)).toMatchObject({ status: 'DONE' }); // not retried against a dead grant
      await as(ownerA).post(api(`calendar-connections/${connection.id}/sync`)).expect(409);

      google.refreshRevoked = false;
      const again = await connect();
      expect(again.connection).toMatchObject({ id: connection.id, status: 'ACTIVE' });
      await run();
      expect(google.events()).toHaveLength(1);
    });

    it('moves events when another calendar is chosen, and refuses a calendar the account does not have', async () => {
      const { connection } = await connect();
      await book();
      await run();
      expect(google.events('primary')).toHaveLength(1);

      const list = await as(ownerA).get(api(`calendar-connections/${connection.id}/calendars`)).expect(200);
      expect(list.body.data.map((c: { name: string }) => c.name)).toEqual(['Ari', 'Work']);
      await as(ownerA).patch(api(`calendar-connections/${connection.id}`), { calendarId: 'someone-elses@calendar' }).expect(404);
      await as(ownerA)
        .patch(api(`calendar-connections/${connection.id}`), { calendarId: 'work@group.calendar.google.com' })
        .expect(200);
      await run();
      expect(google.events('primary')).toHaveLength(0);
      expect(google.events('work@group.calendar.google.com')).toHaveLength(1);
    });

    it('disconnects: removes upcoming events, revokes the grant, and deletes the tokens', async () => {
      const { connection } = await connect();
      await book();
      await run();
      expect(google.events()).toHaveLength(1);

      const res = await as(ownerA).delete(api(`calendar-connections/${connection.id}`)).expect(200);
      expect(res.body.data).toMatchObject({ disconnected: true, upcomingEventsRemoved: 1 });
      expect(google.events()).toHaveLength(0);
      expect(google.calls.some((c) => c.url.pathname === '/revoke')).toBe(true);
      expect(await harness.prisma.calendarConnection.count()).toBe(0);
      expect(await harness.prisma.calendarEventLink.count()).toBe(0);
      expect(await harness.prisma.calendarBusyBlock.count()).toBe(0);
    });
  });

  // ===========================================================================
  describe('busy periods and availability', () => {
    const dayOf = (iso: string) => iso.slice(0, 10);
    const slots = async (date: string, employeeId = ari) =>
      (
        await as(ownerA)
          .get(api(`availability?branchId=${world.companyA.branchId}&serviceId=${haircut}&date=${date}&employeeId=${employeeId}`))
          .expect(200)
      ).body.data.slots.map((s: { startAt: string }) => ({ startAt: new Date(s.startAt).toISOString() })) as Array<{ startAt: string }>;

    it('blocks an external busy period (details unseen), honours the calendar zone, and revalidates on booking', async () => {
      const { connection } = await connect();
      const start = nextStart(); // e.g. 2026-11-22T10:00:00+08:00
      const date = dayOf(start);
      const busyStart = new Date(start);
      const next = new Date(busyStart.getTime() + 24 * 3600_000);
      google.busyItems = [
        // A private meeting at the slot's time. Its title is never asked for.
        { id: 'm1', start: { dateTime: busyStart.toISOString() }, end: { dateTime: new Date(busyStart.getTime() + 3600_000).toISOString() } },
        // Free time: ignored.
        { id: 'm2', transparency: 'transparent', start: { dateTime: new Date(busyStart.getTime() + 2 * 3600_000).toISOString() }, end: { dateTime: new Date(busyStart.getTime() + 3 * 3600_000).toISOString() } },
        // All of the next day, in the calendar's zone (Asia/Ulaanbaatar).
        { id: 'm3', start: { date: dayOf(next.toISOString()) }, end: { date: dayOf(new Date(next.getTime() + 24 * 3600_000).toISOString()) } },
      ];
      const before = (await slots(date)).map((s) => s.startAt);
      expect(before).toContain(busyStart.toISOString());

      await run();
      const blocks = await harness.prisma.calendarBusyBlock.findMany({ where: { connectionId: connection.id }, orderBy: { startsAt: 'asc' } });
      expect(blocks).toHaveLength(2);
      expect(blocks[1]!.startsAt.toISOString()).toBe(new Date(`${dayOf(next.toISOString())}T00:00:00+08:00`).toISOString());
      expect(Object.keys(blocks[0]!).sort()).toEqual(['companyId', 'connectionId', 'createdAt', 'employeeId', 'endsAt', 'id', 'startsAt']);

      const after = (await slots(date)).map((s) => s.startAt);
      expect(after).not.toContain(busyStart.toISOString());
      expect(await slots(dayOf(next.toISOString()))).toEqual([]);
      // Bea has no calendar: unaffected.
      expect((await slots(date, bea)).map((s) => s.startAt)).toContain(busyStart.toISOString());

      // The booking flow revalidates the same way.
      const res = await as(ownerA).post(api('appointments'), {
        branchId: world.companyA.branchId,
        serviceId: haircut,
        employeeId: ari,
        customerId: world.companyA.customerId,
        startsAt: start,
      });
      expect(res.status).toBe(409);

      // Switched off: the blocks go, the slot is back.
      await as(ownerA).patch(api(`calendar-connections/${connection.id}`), { useForAvailability: false }).expect(200);
      expect(await harness.prisma.calendarBusyBlock.count()).toBe(0);
      expect((await slots(date)).map((s) => s.startAt)).toContain(busyStart.toISOString());
    });

    it('stops trusting busy periods from a calendar that needs reconnecting', async () => {
      await connect();
      const start = nextStart();
      google.busyItems = [
        { id: 'm1', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(new Date(start).getTime() + 3600_000).toISOString() } },
      ];
      await run();
      expect((await slots(dayOf(start))).map((s) => s.startAt)).not.toContain(new Date(start).toISOString());
      await harness.prisma.calendarConnection.updateMany({ data: { status: 'NEEDS_REAUTH' } });
      expect((await slots(dayOf(start))).map((s) => s.startAt)).toContain(new Date(start).toISOString());
    });

    it('does not count its own events as busy', async () => {
      await connect();
      const appointment = await book();
      await run();
      google.busyItems = google.events().map((e) => ({ ...e }));
      await harness.prisma.calendarConnection.updateMany({ data: { busySyncedAt: null } });
      await run();
      expect(await harness.prisma.calendarBusyBlock.count()).toBe(0);
      expect(appointment.id).toBeDefined();
    });
  });

  // ===========================================================================
  describe('access control', () => {
    it('lets an employee manage only their own calendar', async () => {
      const own = await as(ariToken).get(api('calendar-connections')).expect(200);
      expect(own.body.data.employees.map((e: { employeeId: string }) => e.employeeId)).toEqual([ari]);
      expect(own.body.data.employees[0].isSelf).toBe(true);
      await as(ariToken).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId: bea }).expect(403);
      const { connection } = await connect(ari, ariToken);
      await as(ariToken).get(api(`calendar-connections/${connection.id}/sync`)).expect(200);

      const beaConnection = await connect(bea, ownerA);
      await as(ariToken).get(api(`calendar-connections/${beaConnection.connection.id}/sync`)).expect(403);
      await as(ariToken).delete(api(`calendar-connections/${beaConnection.connection.id}`)).expect(403);
    });

    it('lets read-only and receptionist members see no one’s calendar and change nothing', async () => {
      const { connection } = await connect();
      for (const role of [SYSTEM_ROLES.READ_ONLY, SYSTEM_ROLES.RECEPTIONIST]) {
        const { token } = await member(role);
        const listed = await as(token).get(api('calendar-connections')).expect(200);
        expect(listed.body.data.employees).toEqual([]);
        await as(token).post(api('calendar-connections/oauth/start'), { provider: 'google', employeeId: ari }).expect(403);
        await as(token).delete(api(`calendar-connections/${connection.id}`)).expect(403);
        await as(token).post(api(`calendar-connections/${connection.id}/sync`)).expect(403);
      }
      await request(http).get(api('calendar-connections')).expect(401);
    });

    it('keeps each company’s calendars to itself', async () => {
      const { connection } = await connect();
      await as(ownerB).get(api('calendar-connections')).expect(404);
      const own = await as(ownerB).get(api('calendar-connections', world.companyB.id)).expect(200);
      expect(JSON.stringify(own.body.data)).not.toContain(connection.id);
      for (const path of [`calendar-connections/${connection.id}/sync`, `calendar-connections/${connection.id}/calendars`]) {
        await as(ownerB).get(api(path, world.companyB.id)).expect(404);
      }
      await as(ownerB).delete(api(`calendar-connections/${connection.id}`, world.companyB.id)).expect(404);
      await as(ownerB)
        .post(api('calendar-connections/oauth/start', world.companyB.id), { provider: 'google', employeeId: ari })
        .expect(404);
      expect(await harness.prisma.calendarConnection.count()).toBe(1);
    });
  });
});
