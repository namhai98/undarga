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
   * Edge rate limiting.
   *
   * On by default and expected to stay on in production. It exists to be
   * switchable in tests: the limits are deliberately low and every request in a
   * suite comes from one address, so leaving it on would make each test's
   * outcome depend on how many ran before it — a flaky suite that hides real
   * failures behind 429s. One e2e block turns it back on to prove the guard is
   * wired.
   */
  THROTTLE_ENABLED: bool(true),
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

  // --- notifications -------------------------------------------------------
  /**
   * The in-process worker that turns outbox events into notifications, sends
   * what is due and schedules reminders. Off in tests regardless (they drive
   * each stage directly). Several API instances may all run it: every stage
   * claims its work with a conditional UPDATE or a unique key.
   */
  NOTIFICATION_WORKER_ENABLED: bool(true),
  /** How often the worker polls. Reminders are accurate to about this much. */
  NOTIFICATION_WORKER_INTERVAL_MS: int(15_000, 1_000),

  // --- subscriptions -------------------------------------------------------
  /** The expiry / renewal sweep. Off in tests regardless. */
  SUBSCRIPTION_SWEEP_ENABLED: bool(true),
  SUBSCRIPTION_SWEEP_INTERVAL_MS: int(3_600_000, 60_000),

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

  /**
   * Minimum password length.
   *
   * Twelve, with no composition rules. Length is the property that actually
   * resists guessing; forced symbol classes mostly produce `Password1!` and
   * push people towards reuse. NIST 800-63B says the same. Configurable
   * because a customer's own policy may demand more — never less, which the
   * floor below enforces.
   */
  PASSWORD_MIN_LENGTH: int(12, 12),

  /** Email verification links. Short: they are re-issuable on demand. */
  EMAIL_VERIFICATION_TTL_HOURS: int(24, 1),
  /**
   * Password reset links. Deliberately much shorter than verification — this
   * one takes over an account, and the window in which a leaked inbox is
   * dangerous should be measured in minutes.
   */
  PASSWORD_RESET_TTL_MINUTES: int(30, 5),

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

  // --- availability ------------------------------------------------------------
  /**
   * TTL for the advisory availability response cache, in seconds. `0` disables
   * it entirely, which is the default: the engine loads a bounded set of rows
   * and computes in memory, so caching is a benchmark-driven optimisation, not
   * a correctness requirement. When enabled it must stay SHORT — a slot list
   * goes stale the instant an appointment is created — and the endpoint is
   * advisory regardless (docs/DATABASE.md §13.1): the Appointment Engine
   * re-checks under a constraint.
   */
  AVAILABILITY_CACHE_TTL_SECONDS: int(0, 0),

  // --- email (placeholder; no mail is sent yet) -----------------------------
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalPort,
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,

  // --- file storage (docs/FILE-STORAGE.md) ----------------------------------
  /** `local` (development) or `s3` (any S3-compatible store). Default: s3 when S3_BUCKET is set. */
  STORAGE_DRIVER: z.enum(['local', 's3']).optional(),
  /** Local driver only. Relative to the API's working directory. */
  STORAGE_LOCAL_ROOT: optionalString,
  /** Omit for AWS; set for MinIO, Cloudflare R2, DigitalOcean Spaces… */
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  /** Path-style URLs (endpoint/bucket/key). Default: true when S3_ENDPOINT is set. */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Optional CDN / public-bucket origin serving the `public/` prefix. When set,
   * public images redirect there instead of streaming through the API.
   */
  STORAGE_PUBLIC_BASE_URL: optionalString,
  /** This API's public origin, for the URLs it hands out. Default http://localhost:PORT. */
  API_PUBLIC_URL: optionalString,
  /** Largest accepted image upload, bytes. */
  FILE_MAX_IMAGE_BYTES: int(5 * 1024 * 1024, 1024),
  /** Largest accepted image, in pixels (decompression-bomb guard). */
  FILE_MAX_IMAGE_PIXELS: int(40_000_000, 10_000),
  /** Lifetime of a signed URL for a private file. */
  FILE_SIGNED_URL_TTL_SECONDS: int(300, 30),
  FILE_CLEANUP_ENABLED: bool(true),
  FILE_CLEANUP_INTERVAL_MS: int(10 * 60_000, 1_000),
  /** An unattached or half-uploaded file older than this is removed. */
  FILE_ORPHAN_GRACE_MINUTES: int(60, 1),

  // --- notification providers (docs/NOTIFICATION-PROVIDERS.md) -------------
  /**
   * Who delivers each channel for companies without their own account.
   * `none`: nothing is sent on the channel and no notification row is created
   *   for it (unless a company connects its own account).
   * `log`: development only — written to the log, recorded as provider `log`.
   * `mock`: automated tests only. Unset: `log` outside production, else `none`.
   */
  EMAIL_PROVIDER: z.enum(['none', 'log', 'mock', 'sendgrid']).optional(),
  EMAIL_FROM_ADDRESS: optionalString,
  EMAIL_FROM_NAME: optionalString,
  SENDGRID_API_KEY: optionalString,
  /** The Event Webhook's verification key (base64 DER or PEM), for signed receipts. */
  SENDGRID_WEBHOOK_PUBLIC_KEY: optionalString,
  SMS_PROVIDER: z.enum(['none', 'log', 'mock', 'twilio']).optional(),
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  /** A Twilio number in E.164, or use TWILIO_MESSAGING_SERVICE_SID. */
  TWILIO_FROM_NUMBER: optionalString,
  TWILIO_MESSAGING_SERVICE_SID: optionalString,
  /** No device registration exists yet, so push has no real provider. */
  PUSH_PROVIDER: z.enum(['none', 'mock']).optional(),
  /**
   * This API's public origin, for delivery receipts (SendGrid Event Webhook,
   * Twilio status callbacks). Without it messages are tracked to ACCEPTED only.
   */
  NOTIFICATION_WEBHOOK_BASE_URL: optionalString,
  /**
   * 32 random bytes, base64: encrypts companies' own provider credentials at
   * rest (AES-256-GCM). Without it companies cannot store their own accounts.
   * Rotating it makes stored credentials unreadable — re-enter them.
   */
  SECRETS_ENCRYPTION_KEY: optionalString,

  // --- calendar integration (docs/CALENDAR-INTEGRATION.md) -----------------
  /** Google OAuth client (Web application). Both or neither. */
  GOOGLE_CALENDAR_CLIENT_ID: optionalString,
  GOOGLE_CALENDAR_CLIENT_SECRET: optionalString,
  /** Microsoft Entra app registration. Both or neither. */
  MICROSOFT_CALENDAR_CLIENT_ID: optionalString,
  MICROSOFT_CALENDAR_CLIENT_SECRET: optionalString,
  /** `common` (any account), `organizations`, `consumers`, or a tenant id. */
  MICROSOFT_CALENDAR_TENANT: optionalString,
  /**
   * Where the provider sends the browser back: the web app's
   * /calendar/callback page. Must be registered with each provider exactly.
   * Default: WEB_APP_URL + /calendar/callback.
   */
  CALENDAR_OAUTH_REDIRECT_URL: optionalString,
  CALENDAR_SYNC_ENABLED: bool(true),
  CALENDAR_SYNC_INTERVAL_MS: int(30_000, 1_000),
  /** How often busy periods are re-read from each calendar. */
  CALENDAR_BUSY_REFRESH_MINUTES: int(10, 1),

  // --- online payments (docs/PAYMENTS.md) -----------------------------------
  /**
   * The gateway that takes online payments. `none` disables them; `mock` is a
   * local simulator and is refused in production.
   */
  PAYMENT_PROVIDER: z.enum(['none', 'mock', 'qpay']).default('none'),
  /**
   * Signs what this server hands out and must recognise later: webhook callback
   * URLs, the mock provider's webhooks and public booking payment links. At
   * least 32 characters; rotate it and outstanding payment links stop working.
   */
  PAYMENT_SIGNING_SECRET: optionalString,
  /**
   * This API's public origin, e.g. https://api.example.mn — where a provider
   * delivers webhooks. Configured, never derived from a request.
   */
  PAYMENT_WEBHOOK_BASE_URL: optionalString,
  /** QPay merchant API v2. Sandbox: https://merchant-sandbox.qpay.mn */
  QPAY_BASE_URL: z.string().url().default('https://merchant.qpay.mn'),
  QPAY_CLIENT_ID: optionalString,
  QPAY_CLIENT_SECRET: optionalString,
  /** The merchant's invoice template code, issued by QPay. */
  QPAY_INVOICE_CODE: optionalString,
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
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
    problems.push('STORAGE_DRIVER is "s3" but S3_BUCKET is not set.');
  }
  if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER !== 's3' && !env.S3_BUCKET && env.STORAGE_DRIVER !== 'local') {
    problems.push(
      'No file storage configured for production: set S3_BUCKET (and credentials), or STORAGE_DRIVER=local deliberately.',
    );
  }
  if (env.S3_BUCKET && !(env.S3_ACCESS_KEY && env.S3_SECRET_KEY)) {
    problems.push('S3_BUCKET is set but S3_ACCESS_KEY / S3_SECRET_KEY are not.');
  }
  if (env.PAYMENT_PROVIDER !== 'none') {
    if (!env.PAYMENT_SIGNING_SECRET || env.PAYMENT_SIGNING_SECRET.length < 32) {
      problems.push(
        `PAYMENT_PROVIDER is "${env.PAYMENT_PROVIDER}" but PAYMENT_SIGNING_SECRET is missing or ` +
          'shorter than 32 characters.',
      );
    }
    if (!env.PAYMENT_WEBHOOK_BASE_URL) {
      problems.push(
        `PAYMENT_PROVIDER is "${env.PAYMENT_PROVIDER}" but PAYMENT_WEBHOOK_BASE_URL is not set.`,
      );
    }
  }
  if (env.EMAIL_PROVIDER === 'sendgrid') {
    for (const key of ['SENDGRID_API_KEY', 'EMAIL_FROM_ADDRESS'] as const) {
      if (!env[key]) problems.push(`EMAIL_PROVIDER is "sendgrid" but ${key} is not set.`);
    }
  }
  if (env.SMS_PROVIDER === 'twilio') {
    for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const) {
      if (!env[key]) problems.push(`SMS_PROVIDER is "twilio" but ${key} is not set.`);
    }
    if (!env.TWILIO_FROM_NUMBER && !env.TWILIO_MESSAGING_SERVICE_SID) {
      problems.push(
        'SMS_PROVIDER is "twilio" but neither TWILIO_FROM_NUMBER nor TWILIO_MESSAGING_SERVICE_SID is set.',
      );
    }
  }
  if (
    env.SECRETS_ENCRYPTION_KEY &&
    Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64').length !== 32
  ) {
    problems.push('SECRETS_ENCRYPTION_KEY must be 32 random bytes, base64-encoded.');
  }
  for (const [id, secret] of [
    ['GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET'],
    ['MICROSOFT_CALENDAR_CLIENT_ID', 'MICROSOFT_CALENDAR_CLIENT_SECRET'],
  ] as const) {
    if (Boolean(env[id]) !== Boolean(env[secret])) {
      problems.push(`${id} and ${secret} must be set together.`);
    }
  }
  if (
    (env.GOOGLE_CALENDAR_CLIENT_ID || env.MICROSOFT_CALENDAR_CLIENT_ID) &&
    !env.CALENDAR_OAUTH_REDIRECT_URL &&
    !env.WEB_APP_URL
  ) {
    problems.push('Calendar OAuth needs CALENDAR_OAUTH_REDIRECT_URL or WEB_APP_URL.');
  }

  if (env.PAYMENT_PROVIDER === 'qpay') {
    for (const key of ['QPAY_CLIENT_ID', 'QPAY_CLIENT_SECRET', 'QPAY_INVOICE_CODE'] as const) {
      if (!env[key]) problems.push(`PAYMENT_PROVIDER is "qpay" but ${key} is not set.`);
    }
  }

  // --- production-only ------------------------------------------------------
  if (env.NODE_ENV === 'production') {
    for (const key of ['EMAIL_PROVIDER', 'SMS_PROVIDER', 'PUSH_PROVIDER'] as const) {
      const value = env[key];
      if (value === 'log' || value === 'mock') {
        problems.push(
          `${key}=${value} records messages that are never delivered; refused in production.`,
        );
      }
    }
    if (
      env.NOTIFICATION_WEBHOOK_BASE_URL &&
      !env.NOTIFICATION_WEBHOOK_BASE_URL.startsWith('https://')
    ) {
      problems.push('NOTIFICATION_WEBHOOK_BASE_URL must be https:// in production.');
    }
    if (env.PAYMENT_PROVIDER === 'mock') {
      problems.push('PAYMENT_PROVIDER=mock simulates payments and is refused in production.');
    }
    if (env.PAYMENT_WEBHOOK_BASE_URL && !env.PAYMENT_WEBHOOK_BASE_URL.startsWith('https://')) {
      problems.push('PAYMENT_WEBHOOK_BASE_URL must be https:// in production.');
    }
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
