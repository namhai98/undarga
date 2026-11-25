import request from 'supertest';
import type { Server } from 'node:http';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, TEST_PASSWORD, type SeededWorld } from './support/seed';

describe('session cookie', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('sets an HttpOnly, path-scoped cookie and keeps the token out of the body', async () => {
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ email: world.userA.email, password: TEST_PASSWORD })
      .expect(200);

    expect(res.body.data.refreshToken).toBeUndefined();
    const cookie = asCookies(res.headers['set-cookie'])[0]!;
    expect(cookie).toMatch(/^undarga_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('refreshes from the cookie alone, with no body', async () => {
    const login = await request(http)
      .post('/api/v1/auth/login')
      .send({ email: world.userA.email, password: TEST_PASSWORD })
      .expect(200);

    const res = await request(http)
      .post('/api/v1/auth/refresh')
      .set('Cookie', asCookies(login.headers['set-cookie']))
      .expect(200);

    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toBeUndefined();
  });

  it('two refreshes racing on one cookie: one rotates, the other is caught as reuse', async () => {
    const login = await request(http)
      .post('/api/v1/auth/login')
      .send({ email: world.userA.email, password: TEST_PASSWORD })
      .expect(200);
    const cookie = asCookies(login.headers['set-cookie']);

    const results = await Promise.all(
      [1, 2, 3].map(() => request(http).post('/api/v1/auth/refresh').set('Cookie', cookie)),
    );
    // Never two live sessions from one token, however the requests interleave.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const refused = results.filter((r) => r.status === 401);
    expect(refused).toHaveLength(2);
    expect(refused.map((r) => r.body.error.code)).toContain('REFRESH_TOKEN_REUSED');

    // Reuse kills the family, including the winner's new session.
    const winner = results.find((r) => r.status === 200)!;
    await request(http)
      .post('/api/v1/auth/refresh')
      .set('Cookie', asCookies(winner.headers['set-cookie']))
      .expect(401);
  });

  it('records sign-ins under the person, in the company they signed in to', async () => {
    const before = new Date();
    await request(http)
      .post('/api/v1/auth/login')
      .send({ email: world.userA.email, password: TEST_PASSWORD })
      .expect(200);
    await request(http)
      .post('/api/v1/auth/login')
      .send({ email: world.userA.email, password: 'definitely-wrong-password' })
      .expect(401);

    const ok = await harness.prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.signed_in', actorId: world.userA.id, occurredAt: { gte: before } },
    });
    expect(ok.actorType).toBe('COMPANY_USER');
    expect(ok.actorLabel).toContain(world.userA.email);
    expect(ok.companyId).toBe(world.companyA.id);

    const failed = await harness.prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'auth.sign_in_failed',
        resourceId: world.userA.id,
        occurredAt: { gte: before },
      },
    });
    expect(failed.actorLabel).toBe('system:anonymous');
    expect(failed.companyId).toBeNull();
    // Nothing about the attempted password, ever.
    expect(JSON.stringify(failed)).not.toContain('definitely-wrong-password');
  });

  it('refuses a refresh with no cookie', async () => {
    await request(http).post('/api/v1/auth/refresh').expect(401);
  });
});

/** supertest types set-cookie as possibly absent; the tests above require it. */
function asCookies(value: string[] | string | undefined): string[] {
  if (!value) throw new Error('expected a Set-Cookie header');
  return Array.isArray(value) ? value : [value];
}
