import { AppConfig } from './app.config';
import { parseTrustProxy, validateEnv } from './env.schema';
import type { ConfigService } from '@nestjs/config';

const base = {
  DATABASE_URL: 'postgresql://app@localhost:5432/x',
  PLATFORM_DATABASE_URL: 'postgresql://platform@localhost:5432/x',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  TOKEN_HASH_PEPPER: 'b'.repeat(24),
};

/** A production configuration that passes every check. */
const production = {
  ...base,
  NODE_ENV: 'production',
  REDIS_REQUIRED: 'true',
  CORS_ORIGINS: 'https://app.undarga.mn',
  TRUST_PROXY: '1',
  STORAGE_DRIVER: 'local',
  PLATFORM_MFA_REQUIRED: 'true',
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};

function configFor(env: Record<string, unknown>): AppConfig {
  const parsed = validateEnv(env) as Record<string, unknown>;
  const service = { get: (key: string) => parsed[key] } as unknown as ConfigService;
  return new AppConfig(service as never);
}

describe('environment validation (security)', () => {
  it('accepts a complete production configuration', () => {
    expect(() => validateEnv(production)).not.toThrow();
  });

  it('refuses production without platform MFA, or without the key that seals it', () => {
    expect(() => validateEnv({ ...production, PLATFORM_MFA_REQUIRED: 'false' })).toThrow(
      /PLATFORM_MFA_REQUIRED/,
    );
    const { SECRETS_ENCRYPTION_KEY: _key, ...withoutKey } = production;
    expect(() => validateEnv(withoutKey)).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('refuses switching rate limiting off in production', () => {
    expect(() => validateEnv({ ...production, THROTTLE_ENABLED: 'false' })).toThrow(
      /THROTTLE_ENABLED/,
    );
    expect(() => validateEnv({ ...base, THROTTLE_ENABLED: 'false' })).not.toThrow();
  });

  it('refuses CORS origins that are not exact origins', () => {
    expect(() => validateEnv({ ...base, CORS_ORIGINS: '*' })).toThrow(/not an origin/);
    expect(() => validateEnv({ ...base, CORS_ORIGINS: 'https://*.undarga.mn' })).toThrow(
      /not an origin/,
    );
    expect(() => validateEnv({ ...base, CORS_ORIGINS: 'https://app.undarga.mn/path' })).toThrow(
      /not an origin/,
    );
    expect(() => validateEnv({ ...base, CORS_ORIGINS: 'http://localhost:3001' })).not.toThrow();
  });

  it('refuses plain-http CORS origins in production', () => {
    expect(() => validateEnv({ ...production, CORS_ORIGINS: 'http://app.undarga.mn' })).toThrow(
      /https/,
    );
  });

  it('refuses TRUST_PROXY=true (any client could choose its own address)', () => {
    expect(() => validateEnv({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('turns Swagger off in production unless asked for', () => {
    expect(configFor(production).app.swaggerEnabled).toBe(false);
    expect(configFor({ ...production, SWAGGER_ENABLED: 'true' }).app.swaggerEnabled).toBe(true);
    expect(configFor(base).app.swaggerEnabled).toBe(true);
    expect(configFor({ ...base, SWAGGER_ENABLED: 'false' }).app.swaggerEnabled).toBe(false);
  });
});

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', 1],
    ['2', 2],
    ['loopback', 'loopback'],
    ['10.0.0.0/8, 172.16.0.0/12', '10.0.0.0/8, 172.16.0.0/12'],
    ['true', null],
    ['$(rm -rf /)', null],
  ])('%p → %p', (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });
});
