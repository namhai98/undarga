/**
 * One in-memory Redis shared by every API instance in this process, standing
 * in for the Redis that real replicas share: rate-limit counters and session
 * revocations are proven to cross instances without a Redis server.
 * (ioredis-mock implements the commands and Lua scripts these paths use.)
 */
jest.mock('ioredis', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RedisMock = require('ioredis-mock');
  class ConnectedRedis extends RedisMock {
    constructor(...args: unknown[]) {
      super(...args);
      (this as unknown as { status: string }).status = 'ready';
    }
  }
  return { __esModule: true, default: ConnectedRedis, Redis: ConnectedRedis };
});

import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { Server } from 'node:http';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, TEST_PASSWORD, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * SECURITY REGRESSIONS (Task #28)
 * ===========================================================================
 *
 * The controls that are easy to lose in a refactor: token validation, the
 * HTTP security headers, permission and tenant boundaries across the newer
 * modules, mass assignment, sensitive data in responses, the platform login
 * lockout, revocation shared between API replicas, and the Origin check on
 * the cookie-authenticated endpoints.
 *
 * Rate limits are exercised in their own block with throttling switched on.
 */
describe('security hardening', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;

  const A = () => `/api/v1/companies/${world.companyA.id}`;
  const B = () => `/api/v1/companies/${world.companyB.id}`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
  // HTTP security headers
  // ===========================================================================

  describe('HTTP headers', () => {
    it('sends a locked-down policy and no framework banner on API responses', async () => {
      const res = await request(http).get(`${A()}/booking-settings`).set(auth(ownerA));
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('keeps the same headers on errors', async () => {
      const res = await request(http).get(`${A()}/booking-settings`);
      expect(res.status).toBe(401);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // ===========================================================================
  // Unauthenticated access
  // ===========================================================================

  describe('unauthenticated access', () => {
    it.each([
      ['GET', '/booking-settings'],
      ['PATCH', '/booking-settings'],
      ['GET', '/time-off'],
      ['GET', '/resources'],
      ['POST', '/appointments/recurring'],
      ['GET', '/customers'],
      ['GET', '/gift-cards'],
      ['GET', '/promotions'],
      ['GET', '/notification-providers'],
      ['GET', '/calendar-connections'],
      ['POST', '/files'],
    ])('%s %s is 401 without a token', async (method, path) => {
      const res = await request(http)[method.toLowerCase() as 'get'](`${A()}${path}`).send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('the platform console is 401 without a token', async () => {
      expect((await request(http).get('/api/v1/platform/companies')).status).toBe(401);
    });
  });

  // ===========================================================================
  // Invalid and expired tokens
  // ===========================================================================

  describe('invalid tokens', () => {
    const secret = () => process.env.JWT_ACCESS_SECRET!;
    const claims = () => {
      const [, payload] = ownerA.split('.');
      return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    };
    const jwt = new JwtService();
    const resign = (overrides: Record<string, unknown>, options: Record<string, unknown> = {}) => {
      const { iat: _iat, exp: _exp, ...rest } = claims();
      const payload = { ...rest, ...overrides };
      return jwt.sign(payload, {
        secret: secret(),
        ...('exp' in payload ? {} : { expiresIn: 600 }),
        ...options,
      });
    };
    const unsigned = () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims())).toString('base64url');
      return `${header}.${body}.`;
    };

    it.each([
      ['garbage', () => 'not-a-token'],
      ['a signature from another key', () => resign({}, { secret: 'x'.repeat(48) })],
      ['an unsigned token (alg: none)', unsigned],
      ['another algorithm (HS512) with the right key', () => resign({}, { algorithm: 'HS512' })],
      ['an expired token', () => resign({ exp: Math.floor(Date.now() / 1000) - 60 })],
      ['a token from another issuer', () => resign({ iss: 'someone-else' })],
    ])('refuses %s', async (_label, token) => {
      const res = await request(http).get(`${A()}/booking-settings`).set(auth(token()));
      expect(res.status).toBe(401);
    });

    it('accepts the genuine token (control)', async () => {
      expect((await request(http).get(`${A()}/booking-settings`).set(auth(ownerA))).status).toBe(
        200,
      );
    });
  });

  // ===========================================================================
  // Platform Admin is a separate realm
  // ===========================================================================

  describe('platform separation', () => {
    it('a company owner cannot use the platform console', async () => {
      const res = await request(http).get('/api/v1/platform/companies').set(auth(ownerA));
      expect(res.status).toBe(401);
    });

    it('a platform operator cannot use company routes that did not opt in', async () => {
      const operator = await harness.platformToken(world.operator.email);
      const res = await request(http)
        .patch(`${A()}/booking-settings`)
        .set(auth(operator))
        .send({ reschedulingAllowed: false });
      expect([401, 403]).toContain(res.status);
      const settings = await harness.prisma.companySettings.findFirst({
        where: { companyId: world.companyA.id },
      });
      expect(settings?.reschedulingAllowed ?? true).toBe(true);
    });
  });

  // ===========================================================================
  // Insufficient permissions
  // ===========================================================================

  describe('insufficient permissions', () => {
    let employee: string;

    beforeAll(async () => {
      employee = await memberWithRole(SYSTEM_ROLES.EMPLOYEE);
    });

    it.each([
      ['PATCH', '/booking-settings', { reschedulingAllowed: false }],
      ['POST', '/resource-types', { key: 'room', name: 'Room', kind: 'ROOM' }],
      ['POST', '/gift-cards', { initialBalanceMinor: '1000' }],
      ['POST', '/promotions', {}],
      ['PUT', '/notification-providers/email', {}],
    ])('an employee is refused %s %s', async (method, path, body) => {
      const res = await request(http)
        [method.toLowerCase() as 'post'](`${A()}${path}`)
        .set(auth(employee))
        .send(body);
      expect(res.status).toBe(403);
    });

    it('an employee cannot approve time off', async () => {
      const employeeId = (
        await harness.prisma.employee.create({
          data: { companyId: world.companyA.id, displayName: 'Someone', status: 'ACTIVE' },
        })
      ).id;
      const pending = await harness.prisma.employeeTimeOff.create({
        data: {
          companyId: world.companyA.id,
          employeeId,
          type: 'VACATION',
          status: 'PENDING',
          startsAt: new Date(Date.now() + 40 * 86_400_000),
          endsAt: new Date(Date.now() + 41 * 86_400_000),
        },
      });
      const res = await request(http)
        .patch(`${A()}/time-off/${pending.id}`)
        .set(auth(employee))
        .send({ status: 'APPROVED' });
      expect([403, 404]).toContain(res.status);
      expect(
        (await harness.prisma.employeeTimeOff.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
      ).toBe('PENDING');
    });
  });

  // ===========================================================================
  // Cross-company access with guessed ids
  // ===========================================================================

  describe('cross-company access', () => {
    let bResource: string;
    let bResourceType: string;
    let bTimeOff: string;
    let bGiftCard: string;

    beforeAll(async () => {
      const type = await request(http)
        .post(`${B()}/resource-types`)
        .set(auth(ownerB))
        .send({ key: 'b-room', name: 'B room', kind: 'ROOM' });
      bResourceType = type.body.data.id;
      const resource = await request(http).post(`${B()}/resources`).set(auth(ownerB)).send({
        branchId: world.companyB.branchId,
        resourceTypeId: bResourceType,
        name: 'B room 1',
      });
      bResource = resource.body.data.id;
      const bEmployee = await harness.prisma.employee.create({
        data: { companyId: world.companyB.id, displayName: 'B staff', status: 'ACTIVE' },
      });
      const timeOff = await request(http)
        .post(`${B()}/time-off`)
        .set(auth(ownerB))
        .send({
          employeeId: bEmployee.id,
          type: 'SICK',
          startsAt: new Date(Date.now() + 50 * 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 51 * 86_400_000).toISOString(),
        });
      bTimeOff = timeOff.body.data.id;
      const card = await request(http)
        .post(`${B()}/gift-cards`)
        .set(auth(ownerB))
        .send({ initialBalanceMinor: '5000' });
      bGiftCard = card.body.data.id;
      expect([bResource, bResourceType, bTimeOff, bGiftCard].every(Boolean)).toBe(true);
    });

    it.each([
      ['GET', () => `${B()}/booking-settings`],
      ['GET', () => `${B()}/time-off`],
      ['GET', () => `${B()}/resources`],
      ['GET', () => `${B()}/gift-cards`],
      ['GET', () => `${B()}/customers/${world.companyB.customerId}`],
    ])('company A cannot reach company B by URL: %s %s', async (method, url) => {
      const res = await request(http)[method.toLowerCase() as 'get'](url()).set(auth(ownerA));
      expect(res.status).toBe(404);
    });

    it.each([
      ['GET', () => `${A()}/resources/${bResource}`, undefined],
      ['PATCH', () => `${A()}/resources/${bResource}`, { name: 'Taken' }],
      ['PUT', () => `${A()}/resources/${bResource}/availability`, { rules: [] }],
      [
        'POST',
        () => `${A()}/resources/${bResource}/unavailability`,
        {
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
      ],
      ['DELETE', () => `${A()}/resources/${bResource}`, undefined],
      ['PATCH', () => `${A()}/resource-types/${bResourceType}`, { name: 'Taken' }],
      ['PATCH', () => `${A()}/time-off/${bTimeOff}`, { status: 'CANCELLED' }],
      ['DELETE', () => `${A()}/time-off/${bTimeOff}`, undefined],
      ['GET', () => `${A()}/gift-cards/${bGiftCard}`, undefined],
      ['POST', () => `${A()}/gift-cards/${bGiftCard}/disable`, { reason: 'Stolen card' }],
      ['GET', () => `${A()}/appointments/${world.companyB.appointmentId}`, undefined],
      ['GET', () => `${A()}/customers/${world.companyB.customerId}`, undefined],
      ['GET', () => `${A()}/appointment-series/${world.companyB.appointmentId}`, undefined],
    ])('a company B id in company A’s URL is 404: %s %s', async (method, url, body) => {
      const call = request(http)[method.toLowerCase() as 'post'](url()).set(auth(ownerA));
      const res = body ? await call.send(body) : await call;
      expect(res.status).toBe(404);
    });

    it('company B’s rows are unchanged afterwards', async () => {
      const resource = await harness.prisma.resource.findUniqueOrThrow({
        where: { id: bResource },
      });
      expect(resource.name).toBe('B room 1');
      expect(resource.deletedAt).toBeNull();
      const timeOff = await harness.prisma.employeeTimeOff.findUniqueOrThrow({
        where: { id: bTimeOff },
      });
      expect(timeOff.status).toBe('APPROVED');
      const card = await harness.prisma.giftCard.findUniqueOrThrow({ where: { id: bGiftCard } });
      expect(card.status).not.toBe('DISABLED');
    });

    it('company A cannot book company B’s customer into a recurring series', async () => {
      const res = await request(http)
        .post(`${A()}/appointments/recurring`)
        .set(auth(ownerA))
        .send({
          branchId: world.companyA.branchId,
          customerId: world.companyB.customerId,
          serviceId: world.companyB.appointmentId,
          startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          recurrence: { frequency: 'DAILY', count: 2 },
        });
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // Mass assignment
  // ===========================================================================

  describe('mass assignment', () => {
    it('refuses protected fields on update', async () => {
      const res = await request(http)
        .patch(`${A()}/booking-settings`)
        .set(auth(ownerA))
        .send({ reschedulingAllowed: true, companyId: world.companyB.id });
      expect(res.status).toBe(400);
    });

    it('cannot move a record into another company by naming it', async () => {
      const res = await request(http)
        .post(`${A()}/resource-types`)
        .set(auth(ownerA))
        .send({ key: 'smuggled', name: 'Smuggled', kind: 'ROOM', companyId: world.companyB.id });
      expect(res.status).toBe(400);
      expect(await harness.prisma.resourceType.count({ where: { key: 'smuggled' } })).toBe(0);
    });

    it('cannot set server-owned fields on time off (status, approval)', async () => {
      const employee = await harness.prisma.employee.create({
        data: { companyId: world.companyA.id, displayName: 'Mass', status: 'ACTIVE' },
      });
      const res = await request(http)
        .post(`${A()}/time-off`)
        .set(auth(ownerA))
        .send({
          employeeId: employee.id,
          type: 'OTHER',
          startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 61 * 86_400_000).toISOString(),
          approvedByCompanyUserId: world.userB.id,
        });
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // Sensitive data in responses
  // ===========================================================================

  describe('sensitive response data', () => {
    it('sign-in returns tokens and memberships, never hashes or secrets', async () => {
      const res = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: world.userA.email, password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/passwordHash|password_hash|\$argon2|refreshToken|mfaSecret/);
      // The refresh token travels only as an HttpOnly cookie.
      const cookie = String(res.headers['set-cookie'] ?? '');
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('a malformed body is a 400 without internals', async () => {
      const res = await request(http)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": ');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|SyntaxError: /);
    });

    it('an unknown route is a plain 404', async () => {
      const res = await request(http).get('/api/v1/definitely-not-here');
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/node_modules|\.ts:\d+/);
    });
  });

  // ===========================================================================
  // Platform login lockout
  // ===========================================================================

  describe('platform sign-in lockout', () => {
    it('locks an operator after five wrong passwords, even for the right one', async () => {
      const email = world.weakOperator.email;
      for (let i = 0; i < 5; i += 1) {
        const res = await request(http)
          .post('/api/v1/platform/auth/login')
          .send({ email, password: 'wrong-password-123' });
        expect(res.status).toBe(401);
      }
      const locked = await request(http)
        .post('/api/v1/platform/auth/login')
        .send({ email, password: TEST_PASSWORD });
      expect(locked.status).toBe(401);
      // Indistinguishable from a wrong password.
      expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');

      const row = await harness.prisma.platformUser.findUniqueOrThrow({
        where: { id: world.weakOperator.id },
      });
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Unlocks when the lock lapses, and a success resets the counter.
      await harness.prisma.platformUser.update({
        where: { id: row.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      const ok = await request(http)
        .post('/api/v1/platform/auth/login')
        .send({ email, password: TEST_PASSWORD });
      expect(ok.status).toBe(200);
      const after = await harness.prisma.platformUser.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.failedLoginCount).toBe(0);
      expect(after.lockedUntil).toBeNull();
    });
  });

  // ===========================================================================
  // Revocation shared between replicas
  // ===========================================================================

  describe('session revocation across replicas', () => {
    it('a logout on one API instance is honoured by another', async () => {
      const second = await createTestHarness();
      try {
        const login = await request(http)
          .post('/api/v1/auth/login')
          .send({ email: world.userAB.email, password: TEST_PASSWORD });
        const token = login.body.data.accessToken as string;
        const other = second.app.getHttpServer() as Server;
        expect((await request(other).get('/api/v1/me/context').set(auth(token))).status).toBe(200);

        expect((await request(http).post('/api/v1/auth/logout').set(auth(token))).status).toBe(204);

        const res = await request(other).get('/api/v1/me/context').set(auth(token));
        expect(res.status).toBe(401);
      } finally {
        await second.close();
      }
    });
  });

  // ===========================================================================
  // CSRF: Origin on cookie-authenticated endpoints
  // ===========================================================================

  describe('cookie endpoints and Origin', () => {
    const cookieFor = async () => {
      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: world.userA.email, password: TEST_PASSWORD });
      return String(login.headers['set-cookie']).split(';')[0]!;
    };

    it('refuses a refresh driven from a foreign origin', async () => {
      const res = await request(http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', await cookieFor())
        .set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
    });

    it('refuses a customer-portal refresh from a foreign origin', async () => {
      const res = await request(http)
        .post(`/api/v1/customer/auth/${world.companyA.slug}/refresh`)
        .set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
    });

    it('allows the same request without a foreign Origin', async () => {
      const res = await request(http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', await cookieFor());
      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
    });
  });

  // ===========================================================================
  // helpers
  // ===========================================================================

  async function memberWithRole(roleKey: string): Promise<string> {
    const { prisma } = harness;
    const known = await prisma.userAccount.findFirstOrThrow({
      where: { id: world.userA.id },
      select: { passwordHash: true },
    });
    const account = await prisma.userAccount.create({
      data: {
        email: `sec-${roleKey.toLowerCase()}-${Date.now()}@example.com`,
        fullName: `${roleKey} Person`,
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
});

/**
 * Rate limits, with throttling on. A separate harness, so the low limits do
 * not leak into the assertions above.
 */
describe('security hardening — rate limits', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  beforeAll(async () => {
    harness = await createTestHarness({ throttling: true });
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
  });

  afterAll(async () => {
    await harness.close();
    process.env.THROTTLE_ENABLED = 'false';
  });

  it('limits platform sign-in to 5 a minute per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(http)
        .post('/api/v1/platform/auth/login')
        .send({ email: `nobody-${i}@example.com`, password: 'wrong-password-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('limits invitation acceptance', async () => {
    let limited = false;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const res = await request(http)
        .post('/api/v1/invitations/accept')
        .send({ token: `t${i}`.padEnd(43, 'x') });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('counts in Redis, so every replica shares the limit', async () => {
    const second = await createTestHarness({ throttling: true });
    try {
      const other = second.app.getHttpServer() as Server;
      // The first instance already used up this address's platform sign-ins.
      const res = await request(other)
        .post('/api/v1/platform/auth/login')
        .send({ email: world.operator.email, password: 'wrong-password-123' });
      expect(res.status).toBe(429);
    } finally {
      await second.close();
    }
  });
});
