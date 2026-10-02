import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed, validated configuration, grouped by concern.
 *
 * Nothing in the codebase reads `process.env` directly. That is what lets
 * `validateEnv` be the single place a misconfiguration is caught — at boot,
 * with a message naming the variable, rather than as `undefined` reaching a
 * connection string at 3am.
 *
 * Grouped rather than flat so that "what does auth need?" is answerable by
 * looking at one object, and so a new area (email, payments) arrives as a new
 * group rather than another dozen loose getters.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  // ---------------------------------------------------------------------------
  // app
  // ---------------------------------------------------------------------------
  get app() {
    const nodeEnv = this.get('NODE_ENV');
    return {
      nodeEnv,
      isProduction: nodeEnv === 'production',
      isTest: nodeEnv === 'test',
      isDevelopment: nodeEnv === 'development',
      port: this.get('PORT'),
      apiPrefix: this.get('API_PREFIX'),
      logLevel: this.get('LOG_LEVEL'),
      swaggerEnabled: this.get('SWAGGER_ENABLED'),
      throttleEnabled: this.get('THROTTLE_ENABLED'),
      /**
       * Where apps/web lives. Configured, never taken from the request Host
       * header — see the note in env.schema.ts. Empty means "return the bare
       * token, build no link".
       */
      webAppUrl: this.get('WEB_APP_URL'),
    };
  }

  // ---------------------------------------------------------------------------
  // cors
  // ---------------------------------------------------------------------------
  get cors() {
    const raw = this.get('CORS_ORIGINS').trim();
    const origins = raw === '' ? [] : raw.split(',').map((o) => o.trim()).filter(Boolean);
    return {
      origins,
      /**
       * No wildcard, ever. An empty list means same-origin only, which is the
       * correct default for an API that will later serve per-tenant custom
       * domains: those origins get added explicitly once domain verification
       * exists, not blanket-allowed now.
       */
      enabled: origins.length > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // database
  // ---------------------------------------------------------------------------
  get database() {
    return {
      /** app_tenant. RLS enforced. */
      url: this.get('DATABASE_URL'),
      /** app_platform. BYPASSRLS. Four allowlisted consumers only. */
      platformUrl: this.get('PLATFORM_DATABASE_URL'),
      poolingMode: this.get('DB_POOLING_MODE'),
    };
  }

  // ---------------------------------------------------------------------------
  // redis
  // ---------------------------------------------------------------------------
  get notifications() {
    return {
      workerEnabled: this.get('NOTIFICATION_WORKER_ENABLED'),
      workerIntervalMs: this.get('NOTIFICATION_WORKER_INTERVAL_MS'),
    };
  }

  get subscriptions() {
    return {
      sweepEnabled: this.get('SUBSCRIPTION_SWEEP_ENABLED'),
      sweepIntervalMs: this.get('SUBSCRIPTION_SWEEP_INTERVAL_MS'),
    };
  }

  get redis() {
    return {
      url: this.get('REDIS_URL'),
      keyPrefix: this.get('REDIS_KEY_PREFIX'),
      required: this.get('REDIS_REQUIRED'),
    };
  }

  // ---------------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------------
  get auth() {
    return {
      jwtAccessSecret: this.get('JWT_ACCESS_SECRET'),
      jwtAccessTtlSeconds: this.get('JWT_ACCESS_TTL_SECONDS'),
      refreshTokenTtlDays: this.get('REFRESH_TOKEN_TTL_DAYS'),
      /** Refresh tokens are opaque + HMAC'd, not JWTs. This is the HMAC key. */
      tokenHashPepper: this.get('TOKEN_HASH_PEPPER'),
      /** Lifetime of an invitation link. */
      invitationTtlDays: this.get('INVITATION_TTL_DAYS'),
      passwordMinLength: this.get('PASSWORD_MIN_LENGTH'),
      emailVerificationTtlHours: this.get('EMAIL_VERIFICATION_TTL_HOURS'),
      passwordResetTtlMinutes: this.get('PASSWORD_RESET_TTL_MINUTES'),
      argon2: {
        memoryCost: this.get('ARGON2_MEMORY_KIB'),
        timeCost: this.get('ARGON2_TIME_COST'),
        parallelism: this.get('ARGON2_PARALLELISM'),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // tenancy
  // ---------------------------------------------------------------------------
  get tenancy() {
    return {
      resolvers: {
        routeParam: this.get('TENANT_RESOLVER_ROUTE_PARAM'),
        activeCompany: this.get('TENANT_RESOLVER_ACTIVE_COMPANY'),
        header: this.get('TENANT_RESOLVER_HEADER'),
        customDomain: this.get('TENANT_RESOLVER_CUSTOM_DOMAIN'),
        subdomain: this.get('TENANT_RESOLVER_SUBDOMAIN'),
      },
      subdomainRoot: this.get('TENANT_SUBDOMAIN_ROOT'),
      cacheTtlSeconds: this.get('TENANT_CACHE_TTL_SECONDS'),
    };
  }

  // ---------------------------------------------------------------------------
  // audit
  // ---------------------------------------------------------------------------
  get audit() {
    return { hashChain: this.get('AUDIT_HASH_CHAIN') };
  }

  // ---------------------------------------------------------------------------
  // availability
  // ---------------------------------------------------------------------------
  get availability() {
    const cacheTtlSeconds = this.get('AVAILABILITY_CACHE_TTL_SECONDS');
    return {
      /** 0 disables the advisory response cache. Kept off until benchmarked. */
      cacheTtlSeconds,
      cacheEnabled: cacheTtlSeconds > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // email — placeholder. Nothing sends mail yet.
  // ---------------------------------------------------------------------------
  get email() {
    const host = this.get('SMTP_HOST');
    return {
      configured: Boolean(host),
      host,
      port: this.get('SMTP_PORT'),
      user: this.get('SMTP_USER'),
      password: this.get('SMTP_PASSWORD'),
      from: this.get('SMTP_FROM'),
    };
  }

  // ---------------------------------------------------------------------------
  // storage — placeholder. Nothing uploads yet.
  // ---------------------------------------------------------------------------
  get storage() {
    const bucket = this.get('S3_BUCKET');
    return {
      configured: Boolean(bucket),
      endpoint: this.get('S3_ENDPOINT'),
      region: this.get('S3_REGION'),
      bucket,
      accessKey: this.get('S3_ACCESS_KEY'),
      secretKey: this.get('S3_SECRET_KEY'),
    };
  }

  // ---------------------------------------------------------------------------
  // payments — placeholder. Nothing charges yet.
  // ---------------------------------------------------------------------------
  get payments() {
    const provider = this.get('PAYMENT_PROVIDER');
    return {
      configured: provider !== 'none',
      provider,
      apiKey: this.get('PAYMENT_API_KEY'),
    };
  }
}
