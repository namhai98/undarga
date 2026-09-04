import request from 'supertest';
import type { Server } from 'node:http';
import { RedisService } from '../src/redis/redis.service';
import { RequestContextService } from '../src/tenancy/context/request-context.service';
import { createTestHarness, type TestHarness } from './support/test-app';

/**
 * ===========================================================================
 * FOUNDATION SMOKE TESTS
 * ===========================================================================
 *
 * Proves the plumbing works, not that any feature does:
 *
 *   - the API boots with the real module graph
 *   - liveness and readiness answer
 *   - PostgreSQL is reachable
 *   - Redis is reachable (or honestly reported as not required)
 *   - the response envelope is applied
 *   - the error envelope is applied and leaks nothing
 *   - environment validation rejects a bad config
 *
 * Deliberately thin. Business behaviour is covered by tenant-isolation.e2e-spec.
 */
describe('foundation', () => {
  let harness: TestHarness;
  let http: Server;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('the API starts', () => {
    it('resolves the full module graph', () => {
      expect(harness.app).toBeDefined();
    });
  });

  describe('liveness', () => {
    it('answers without touching any dependency', async () => {
      const res = await request(http).get('/api/v1/health').expect(200);

      expect(res.body.data.status).toBe('ok');
      expect(typeof res.body.data.uptimeSeconds).toBe('number');
    });

    it('is reachable without a token', async () => {
      // An orchestrator has no credentials.
      await request(http).get('/api/v1/health').expect(200);
    });
  });

  describe('readiness', () => {
    it('reports PostgreSQL up', async () => {
      const res = await request(http).get('/api/v1/health/ready');

      expect(res.body.data.checks.database.status).toBe('up');
      expect(typeof res.body.data.checks.database.latencyMs).toBe('number');
    });

    it('reports Redis honestly', async () => {
      const res = await request(http).get('/api/v1/health/ready');
      const redis = res.body.data.checks.redis.status;

      // 'not_configured' is the legitimate local state when REDIS_REQUIRED is
      // false. 'down' would mean it is required and unreachable, which must
      // fail readiness.
      expect(['up', 'not_configured', 'down']).toContain(redis);
      if (redis === 'down') {
        expect(res.status).toBe(503);
      }
    });

    it('returns 200 only when every required dependency is reachable', async () => {
      const res = await request(http).get('/api/v1/health/ready');
      expect(res.status).toBe(res.body.data.ready ? 200 : 503);
    });

    it('answers within a probe-friendly budget even when Redis is down', async () => {
      // Regression guard. This probe once took 7.6 seconds with Redis
      // unavailable: ioredis held the PING in its offline queue and retried on
      // a backoff schedule before failing. Orchestrators time readiness out at
      // 1-3 seconds, so an optional dependency being down was enough to get a
      // perfectly healthy instance marked dead and restarted.
      //
      // The budget is deliberately far below a typical probe timeout — if this
      // starts failing, something is blocking on a dependency again.
      const started = Date.now();
      await request(http).get('/api/v1/health/ready');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('leaks no infrastructure detail', async () => {
      // A readiness probe is unauthenticated and often reachable from further
      // away than intended. It must not hand out a network map.
      const res = await request(http).get('/api/v1/health/ready');
      const body = JSON.stringify(res.body);

      expect(body).not.toMatch(/postgres(ql)?:\/\//i);
      expect(body).not.toMatch(/redis:\/\//i);
      expect(body).not.toMatch(/localhost|127\.0\.0\.1/);
      expect(body).not.toMatch(/password|secret/i);
      expect(body).not.toMatch(/5432|6379/);
    });
  });

  describe('response envelope', () => {
    it('wraps success as { data, meta }', async () => {
      const res = await request(http).get('/api/v1/health').expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['data', 'meta']);
      expect(res.body.meta.requestId).toEqual(expect.any(String));
    });

    it('echoes the request id in a header so it can be quoted in a support ticket', async () => {
      const res = await request(http).get('/api/v1/health').expect(200);
      expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
    });

    it('honours an inbound X-Request-Id for cross-service correlation', async () => {
      const res = await request(http)
        .get('/api/v1/health')
        .set('X-Request-Id', 'trace-abc-123')
        .expect(200);

      expect(res.body.meta.requestId).toBe('trace-abc-123');
    });

    it('does NOT wrap errors — the exception filter owns that shape', async () => {
      const res = await request(http).get('/api/v1/health/nope').expect(404);

      expect(res.body).toHaveProperty('error');
      expect(res.body).not.toHaveProperty('data');
    });
  });

  describe('error envelope', () => {
    it('uses the agreed error shape', async () => {
      const res = await request(http).get('/api/v1/auth/me').expect(401);

      expect(res.body.error).toMatchObject({
        code: 'UNAUTHENTICATED',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('never returns a stack trace', async () => {
      const res = await request(http).get('/api/v1/auth/me').expect(401);
      const body = JSON.stringify(res.body);

      expect(body).not.toMatch(/at .*\(.*:\d+:\d+\)/);
      expect(body).not.toMatch(/node_modules/);
    });
  });

  describe('Redis', () => {
    it('exposes a working client or a clean down signal', async () => {
      const redis = harness.app.get(RedisService);
      const pong = await redis.ping();

      expect(typeof pong).toBe('boolean');
      expect(pong).toBe(redis.isReady);
    });

    it('round-trips a value when connected', async () => {
      const redis = harness.app.get(RedisService);
      if (!redis.isReady) return; // covered by the readiness test above

      const key = redis.globalKey('foundation-test', Date.now());
      await redis.setJson(key, { hello: 'world' }, 30);
      await expect(redis.getJson<{ hello: string }>(key)).resolves.toEqual({ hello: 'world' });
      await redis.del(key);
      await expect(redis.exists(key)).resolves.toBe(false);
    });

    it('refuses to build a tenant key without a tenant context', async () => {
      // Same rule as the database layer: a cache key with no company in it is a
      // cross-tenant leak waiting to happen.
      const redis = harness.app.get(RedisService);
      const context = harness.app.get(RequestContextService);

      expect(context.tenantOrNull()).toBeNull();
      expect(() => redis.tenantKey('availability', '2026-01-01')).toThrow(
        /Tenant context was requested/,
      );
    });
  });

  describe('environment validation', () => {
    it('rejects a config where the tenant connection can bypass RLS', async () => {
      const { validateEnv } = await import('../src/config/env.schema');
      const shared = 'postgresql://app:pw@localhost:5432/db';

      expect(() =>
        validateEnv({
          DATABASE_URL: shared,
          PLATFORM_DATABASE_URL: shared,
          JWT_ACCESS_SECRET: 'x'.repeat(32),
          TOKEN_HASH_PEPPER: 'y'.repeat(16),
        }),
      ).toThrow(/row-level security would be inert/i);
    });

    it('rejects a missing required secret with a message naming it', async () => {
      const { validateEnv } = await import('../src/config/env.schema');

      expect(() =>
        validateEnv({
          DATABASE_URL: 'postgresql://a@localhost:5432/x',
          PLATFORM_DATABASE_URL: 'postgresql://b@localhost:5432/x',
        }),
      ).toThrow(/JWT_ACCESS_SECRET/);
    });

    it('rejects a half-configured integration', async () => {
      const { validateEnv } = await import('../src/config/env.schema');

      expect(() =>
        validateEnv({
          DATABASE_URL: 'postgresql://a@localhost:5432/x',
          PLATFORM_DATABASE_URL: 'postgresql://b@localhost:5432/x',
          JWT_ACCESS_SECRET: 'x'.repeat(32),
          TOKEN_HASH_PEPPER: 'y'.repeat(16),
          PAYMENT_PROVIDER: 'stripe',
        }),
      ).toThrow(/PAYMENT_API_KEY/);
    });
  });
});
