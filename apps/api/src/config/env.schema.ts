import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (fallback: number, min = 0) =>
  z.coerce.number().int().min(min).default(fallback);

/**
 * Fail fast and loudly. A misconfigured tenant boundary is not something to
 * discover at request time, so every knob that affects isolation is validated
 * here and the process refuses to boot without it.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1),
  API_PREFIX: z.string().default('api'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- database ------------------------------------------------------------
  /** app_tenant role. RLS ENFORCED. Every request goes through this. */
  DATABASE_URL: z.string().url(),
  /** app_platform role. BYPASSRLS. Platform module and worker claims only. */
  PLATFORM_DATABASE_URL: z.string().url(),
  /**
   * `SET LOCAL` is transaction-scoped. Behind pgbouncer this is only safe in
   * transaction pooling mode; session mode leaks tenant context between
   * requests, which is the single most likely way isolation breaks in
   * production. See docs/DATABASE.md 4.7.
   */
  DB_POOLING_MODE: z.enum(['transaction', 'session', 'none']).default('transaction'),

  // --- auth ----------------------------------------------------------------
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: int(900, 60),
  REFRESH_TOKEN_TTL_DAYS: int(30, 1),
  TOKEN_HASH_PEPPER: z.string().min(16, 'TOKEN_HASH_PEPPER must be at least 16 characters'),

  ARGON2_MEMORY_KIB: int(19456, 8192),
  ARGON2_TIME_COST: int(2, 1),
  ARGON2_PARALLELISM: int(1, 1),

  // --- tenant resolution ---------------------------------------------------
  TENANT_RESOLVER_ROUTE_PARAM: bool(true),
  TENANT_RESOLVER_ACTIVE_COMPANY: bool(true),
  TENANT_RESOLVER_HEADER: bool(true),
  /** Wired but off: needs the DNS verification flow, which is not built. */
  TENANT_RESOLVER_CUSTOM_DOMAIN: bool(false),
  /** Wired but off: needs wildcard DNS and TLS, which are not provisioned. */
  TENANT_RESOLVER_SUBDOMAIN: bool(false),
  TENANT_SUBDOMAIN_ROOT: z.string().default('booking.local'),
  TENANT_CACHE_TTL_SECONDS: int(60, 0),

  // --- audit ---------------------------------------------------------------
  AUDIT_HASH_CHAIN: bool(true),

  // --- infra ---------------------------------------------------------------
  REDIS_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  if (env.DATABASE_URL === env.PLATFORM_DATABASE_URL) {
    throw new Error(
      'DATABASE_URL and PLATFORM_DATABASE_URL are identical. The request path would ' +
        'run as the BYPASSRLS role and row-level security would be inert. Point ' +
        'DATABASE_URL at the app_tenant role.',
    );
  }

  if (env.NODE_ENV === 'production') {
    if (env.DB_POOLING_MODE === 'session') {
      throw new Error(
        'DB_POOLING_MODE=session is not permitted in production: SET LOCAL is ' +
          'transaction-scoped, so session pooling leaks tenant context between requests.',
      );
    }
    if (env.JWT_ACCESS_SECRET.includes('change-me')) {
      throw new Error('JWT_ACCESS_SECRET still holds its development placeholder value.');
    }
    if (env.TOKEN_HASH_PEPPER.includes('change-me')) {
      throw new Error('TOKEN_HASH_PEPPER still holds its development placeholder value.');
    }
  }

  return env;
}
