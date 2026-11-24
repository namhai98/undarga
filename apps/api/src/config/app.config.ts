import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { corsOrigins, parseTrustProxy, type Env } from './env.schema';

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
      /** JSON lines in production unless LOG_FORMAT says otherwise. */
      logFormat: this.get('LOG_FORMAT') ?? (nodeEnv === 'production' ? 'json' : 'text'),
      /** Off in production unless explicitly enabled. */
      swaggerEnabled: this.get('SWAGGER_ENABLED') ?? nodeEnv !== 'production',
      /** Express `trust proxy`; see TRUST_PROXY in env.schema.ts. */
      trustProxy: parseTrustProxy(this.get('TRUST_PROXY')) ?? false,
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
    const origins = raw === '' ? [] : corsOrigins(raw);
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
  // file storage (docs/FILE-STORAGE.md)
  // ---------------------------------------------------------------------------
  get storage() {
    const bucket = this.get('S3_BUCKET');
    const endpoint = this.get('S3_ENDPOINT')?.replace(/\/+$/, '');
    const driver = this.get('STORAGE_DRIVER') ?? (bucket ? 's3' : 'local');
    return {
      driver,
      localRoot: this.get('STORAGE_LOCAL_ROOT') ?? 'var/uploads',
      s3:
        bucket && this.get('S3_ACCESS_KEY') && this.get('S3_SECRET_KEY')
          ? {
              bucket,
              endpoint: endpoint ?? null,
              region: this.get('S3_REGION') ?? 'us-east-1',
              accessKey: this.get('S3_ACCESS_KEY')!,
              secretKey: this.get('S3_SECRET_KEY')!,
              forcePathStyle: this.get('S3_FORCE_PATH_STYLE') ?? Boolean(endpoint),
            }
          : null,
      publicBaseUrl: this.get('STORAGE_PUBLIC_BASE_URL')?.replace(/\/+$/, '') ?? null,
      apiPublicUrl: (this.get('API_PUBLIC_URL') ?? `http://localhost:${this.get('PORT')}`).replace(/\/+$/, ''),
      apiPrefix: this.get('API_PREFIX'),
      maxImageBytes: this.get('FILE_MAX_IMAGE_BYTES'),
      maxImagePixels: this.get('FILE_MAX_IMAGE_PIXELS'),
      signedUrlTtlSeconds: this.get('FILE_SIGNED_URL_TTL_SECONDS'),
      cleanupEnabled: this.get('FILE_CLEANUP_ENABLED'),
      cleanupIntervalMs: this.get('FILE_CLEANUP_INTERVAL_MS'),
      orphanGraceMinutes: this.get('FILE_ORPHAN_GRACE_MINUTES'),
      /** Signs local-driver download URLs. Derived, so no extra secret to manage. */
      urlSigningSecret: this.get('JWT_ACCESS_SECRET'),
    };
  }

  // ---------------------------------------------------------------------------
  // notification providers — docs/NOTIFICATION-PROVIDERS.md
  // ---------------------------------------------------------------------------
  get calendar() {
    const webAppUrl = (this.get('WEB_APP_URL') ?? '').replace(/\/+$/, '');
    const pair = (id: string | undefined, secret: string | undefined) =>
      id && secret ? { clientId: id, clientSecret: secret } : null;
    return {
      google: pair(this.get('GOOGLE_CALENDAR_CLIENT_ID'), this.get('GOOGLE_CALENDAR_CLIENT_SECRET')),
      microsoft: pair(
        this.get('MICROSOFT_CALENDAR_CLIENT_ID'),
        this.get('MICROSOFT_CALENDAR_CLIENT_SECRET'),
      ),
      microsoftTenant: this.get('MICROSOFT_CALENDAR_TENANT') ?? 'common',
      redirectUrl:
        this.get('CALENDAR_OAUTH_REDIRECT_URL') ?? (webAppUrl ? `${webAppUrl}/calendar/callback` : null),
      syncEnabled: this.get('CALENDAR_SYNC_ENABLED'),
      syncIntervalMs: this.get('CALENDAR_SYNC_INTERVAL_MS'),
      busyRefreshMinutes: this.get('CALENDAR_BUSY_REFRESH_MINUTES'),
    };
  }

  get notificationProviders() {
    const fallback = this.app.isProduction ? 'none' : 'log';
    return {
      email: {
        provider: this.get('EMAIL_PROVIDER') ?? fallback,
        fromAddress: this.get('EMAIL_FROM_ADDRESS') ?? null,
        fromName: this.get('EMAIL_FROM_NAME') ?? null,
        sendgridApiKey: this.get('SENDGRID_API_KEY') ?? null,
        sendgridWebhookPublicKey: this.get('SENDGRID_WEBHOOK_PUBLIC_KEY') ?? null,
      },
      sms: {
        provider: this.get('SMS_PROVIDER') ?? fallback,
        twilioAccountSid: this.get('TWILIO_ACCOUNT_SID') ?? null,
        twilioAuthToken: this.get('TWILIO_AUTH_TOKEN') ?? null,
        twilioFromNumber: this.get('TWILIO_FROM_NUMBER') ?? null,
        twilioMessagingServiceSid: this.get('TWILIO_MESSAGING_SERVICE_SID') ?? null,
      },
      push: { provider: this.get('PUSH_PROVIDER') ?? 'none' },
      /** Without a trailing slash; empty when receipts are not configured. */
      webhookBaseUrl: (this.get('NOTIFICATION_WEBHOOK_BASE_URL') ?? '').replace(/\/+$/, ''),
      secretsKey: this.get('SECRETS_ENCRYPTION_KEY') ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // online payments — docs/PAYMENTS.md
  // ---------------------------------------------------------------------------
  get payments() {
    const provider = this.get('PAYMENT_PROVIDER');
    return {
      provider,
      configured: provider !== 'none',
      signingSecret: this.get('PAYMENT_SIGNING_SECRET') ?? null,
      /** Without a trailing slash. */
      webhookBaseUrl: (this.get('PAYMENT_WEBHOOK_BASE_URL') ?? '').replace(/\/+$/, ''),
      qpay: {
        baseUrl: this.get('QPAY_BASE_URL').replace(/\/+$/, ''),
        clientId: this.get('QPAY_CLIENT_ID') ?? null,
        clientSecret: this.get('QPAY_CLIENT_SECRET') ?? null,
        invoiceCode: this.get('QPAY_INVOICE_CODE') ?? null,
      },
    };
  }
}
