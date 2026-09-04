import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

/**
 * An unset optional variable.
 *
 * `.env` files cannot express "absent" — a placeholder is written as `KEY=`,
 * which arrives as the empty string. Without this, `SMTP_HOST=` reads as a
 * configured-but-blank host, and `z.coerce.number()` turns `PORT=` into `0`.
 * Empty is normalised to undefined so "not configured" means what it says.
 */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const optionalPort = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : v),
  z.coerce.number().int().min(1).max(65535).optional(),
);

/**
 * Every environment variable the API reads, in one schema.
 *
 * Fail fast and loudly. A misconfigured tenant boundary is not something to
 * discover at request time, so anything that affects isolation, money or
 * credentials is validated here and the process refuses to boot without it.
 *
 * Optional integrations (SMTP, S3, payments) are genuinely optional: absent is
 * a valid state, but a PARTIALLY configured one is not — see the cross-field
 * checks at the bottom, which reject "half an SMTP config" rather than letting
 * it fail on the first email six weeks later.
 */
export const envSchema = z.object({
  // --- app -----------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1),
  API_PREFIX: z.string().default('api'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Comma-separated. Empty means same-origin only — never a wildcard. */
  CORS_ORIGINS: z.string().default(''),
  SWAGGER_ENABLED: bool(true),
  /**
   * Origin of apps/web, used to build the invitation accept link.
   *
   * MUST be configured rather than derived from the request `Host` header.
   * Host-header injection would otherwise produce an invitation link pointing
   * at an attacker's domain, and the recipient would hand over a valid
   * one-time token by following it. When unset, the API returns the bare token
   * and no link — no half-configured state.
   */
  WEB_APP_URL: optionalString,

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

  // --- redis ---------------------------------------------------------------
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().default('undarga:'),
  /**
   * When false the app boots without Redis and readiness reports it down.
   * Useful locally; must be true in production, which is enforced below.
   */
  REDIS_REQUIRED: bool(false),

  // --- auth ----------------------------------------------------------------
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: int(900, 60),
  REFRESH_TOKEN_TTL_DAYS: int(30, 1),
  /**
   * Refresh tokens are opaque 256-bit values stored as an HMAC, not JWTs, so
   * there is no JWT refresh secret to configure — this pepper is its
   * counterpart. Rotating it invalidates every outstanding refresh token.
   */
  TOKEN_HASH_PEPPER: z.string().min(16, 'TOKEN_HASH_PEPPER must be at least 16 characters'),

  /**
   * How long an invitation link stays valid. Short enough that a link
   * forwarded into a group chat months ago is dead; long enough to survive a
   * holiday.
   */
  INVITATION_TTL_DAYS: int(7, 1),

  ARGON2_MEMORY_KIB: int(19456, 8192),
  ARGON2_TIME_COST: int(2, 1),
  ARGON2_PARALLELISM: int(1, 1),

  // --- tenancy -------------------------------------------------------------
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

  // --- email (placeholder; no mail is sent yet) -----------------------------
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalPort,
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,

  // --- object storage (placeholder; no uploads yet) -------------------------
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,

  // --- payments (placeholder; no charges yet) -------------------------------
  PAYMENT_PROVIDER: z.enum(['none', 'stripe', 'qpay']).default('none'),
  PAYMENT_API_KEY: optionalString,
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
  const problems: string[] = [];

  // --- isolation ------------------------------------------------------------
  if (env.DATABASE_URL === env.PLATFORM_DATABASE_URL) {
    problems.push(
      'DATABASE_URL and PLATFORM_DATABASE_URL are identical. The request path would run as ' +
        'the BYPASSRLS role and row-level security would be inert. Point DATABASE_URL at ' +
        'the app_tenant role.',
    );
  }

  // --- partially configured integrations ------------------------------------
  // Absent is fine. Half-present is a landmine that detonates on first use.
  if (env.SMTP_HOST && !env.SMTP_PORT) {
    problems.push('SMTP_HOST is set but SMTP_PORT is not.');
  }
  if (env.SMTP_USER && !env.SMTP_PASSWORD) {
    problems.push('SMTP_USER is set but SMTP_PASSWORD is not.');
  }
  if (env.S3_BUCKET && !(env.S3_ACCESS_KEY && env.S3_SECRET_KEY)) {
    problems.push('S3_BUCKET is set but S3_ACCESS_KEY / S3_SECRET_KEY are not.');
  }
  if (env.PAYMENT_PROVIDER !== 'none' && !env.PAYMENT_API_KEY) {
    problems.push(`PAYMENT_PROVIDER is "${env.PAYMENT_PROVIDER}" but PAYMENT_API_KEY is not set.`);
  }

  // --- production-only ------------------------------------------------------
  if (env.NODE_ENV === 'production') {
    if (env.DB_POOLING_MODE === 'session') {
      problems.push(
        'DB_POOLING_MODE=session is not permitted in production: SET LOCAL is ' +
          'transaction-scoped, so session pooling leaks tenant context between requests.',
      );
    }
    if (env.JWT_ACCESS_SECRET.includes('change-me')) {
      problems.push('JWT_ACCESS_SECRET still holds its development placeholder value.');
    }
    if (env.TOKEN_HASH_PEPPER.includes('change-me')) {
      problems.push('TOKEN_HASH_PEPPER still holds its development placeholder value.');
    }
    if (!env.REDIS_REQUIRED) {
      problems.push(
        'REDIS_REQUIRED must be true in production: rate limiting, holds and queues all ' +
          'depend on it, and starting without it fails open.',
      );
    }
    if (env.CORS_ORIGINS.trim() === '') {
      problems.push(
        'CORS_ORIGINS is empty in production. Set the exact browser origins that may call ' +
          'this API; there is no wildcard fallback.',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return env;
}
