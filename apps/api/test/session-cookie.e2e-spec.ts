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

  afterAll(async () => { await harness.close(); });

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

  it('refuses a refresh with no cookie', async () => {
    await request(http).post('/api/v1/auth/refresh').expect(401);
  });
});

/** supertest types set-cookie as possibly absent; the tests above require it. */
function asCookies(value: string[] | string | undefined): string[] {
  if (!value) throw new Error('expected a Set-Cookie header');
  return Array.isArray(value) ? value : [value];
}
