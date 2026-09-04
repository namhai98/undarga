import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import { AppConfig } from '../config';
import { RequestContextService } from '../tenancy/context/request-context.service';

export type RedisStatus = 'connected' | 'connecting' | 'disconnected';

/**
 * The Redis connection and a small set of primitives on top of it.
 *
 * ---------------------------------------------------------------------------
 * SCOPE: INFRASTRUCTURE ONLY
 * ---------------------------------------------------------------------------
 *
 * Redis will eventually carry the availability cache, distributed locks for
 * booking holds, rate limiting, the session deny-list and BullMQ queues. None
 * of that is implemented here — this is the connection, a health signal, and
 * the key-naming rule those features will share.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DEGRADES INSTEAD OF REFUSING TO BOOT
 * ---------------------------------------------------------------------------
 *
 * In development, `REDIS_REQUIRED=false` lets the API start without Redis and
 * report it down on the readiness probe. That is deliberate: a developer
 * working on tenancy or the schema should not be blocked by a cache they are
 * not using.
 *
 * In production `REDIS_REQUIRED=true` is enforced by env validation, because
 * the things Redis will carry — rate limits, holds — fail OPEN without it, and
 * failing open on a rate limiter is worse than not starting.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly required: boolean;
  private lastError?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly context: RequestContextService,
  ) {
    this.required = config.redis.required;

    const options: RedisOptions = {
      keyPrefix: config.redis.keyPrefix,
      /**
       * Fail fast instead of queueing.
       *
       * With the offline queue on, a command issued while Redis is down is held
       * and retried, so the caller blocks for the length of the retry schedule
       * — measured at ~7.6 s here — before finding out. For a cache that is
       * exactly backwards: a cache miss should cost microseconds, and a caller
       * that waits seven seconds for one has been harmed by the cache.
       *
       * BullMQ manages its own connection and its own durability, so nothing
       * that genuinely needs delivery guarantees depends on this setting.
       */
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      // Keep trying in the background, but never faster than every 200ms and
      // never slower than every 5s.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    };

    this.client = new Redis(config.redis.url, options);

    this.client.on('error', (error: Error) => {
      // ioredis retries forever; logging every attempt would flood the log, so
      // only the message is kept for the readiness probe to report.
      if (this.lastError !== error.message) {
        this.lastError = error.message;
        this.logger.warn(`Redis error: ${error.message}`);
      }
    });

    this.client.on('ready', () => {
      this.lastError = undefined;
      this.logger.log('Redis connection ready');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      // Straight to the client: `this.ping()` returns false rather than
      // throwing, and boot needs to know WHY it failed.
      await this.client.ping();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (this.required) {
        throw new Error(
          `REDIS_REQUIRED is true but Redis at ${redactUrl(this.config.redis.url)} is ` +
            `unreachable: ${message}. Refusing to start.`,
        );
      }

      this.logger.warn(
        `Redis unavailable (${message}). Starting anyway because REDIS_REQUIRED=false; ` +
          'readiness will report it down.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // `quit` drains in-flight commands; `disconnect` would drop them.
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  /** Escape hatch for callers needing commands the helpers below do not cover. */
  get raw(): Redis {
    return this.client;
  }

  get status(): RedisStatus {
    switch (this.client.status) {
      case 'ready':
        return 'connected';
      case 'connect':
      case 'connecting':
      case 'reconnecting':
        return 'connecting';
      default:
        return 'disconnected';
    }
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  /**
   * Round-trip check for the readiness probe. Never throws, never blocks.
   *
   * Bounded twice over, because a readiness probe that takes seconds is worse
   * than useless — an orchestrator times it out (commonly at 1–3 s) and marks a
   * perfectly healthy instance dead over an optional dependency:
   *
   *   1. If the socket is not up, answer immediately. There is nothing to learn
   *      from issuing a command that cannot be sent.
   *   2. Otherwise race the PING against a short timeout, so a half-open
   *      connection — the case that hangs rather than refusing — cannot stall
   *      the probe either.
   */
  async ping(timeoutMs = 1_000): Promise<boolean> {
    if (this.client.status !== 'ready') return false;

    try {
      const result = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs).unref?.(),
        ),
      ]);
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Key naming
  // ---------------------------------------------------------------------------

  /**
   * Build a key for the company in the current request context.
   *
   * Every cached value derived from tenant data MUST go through this. The rule
   * is the same one the database layer enforces: a key without a company in it
   * is a cross-tenant leak waiting to happen, and a shared cache is the classic
   * place it happens (docs/DATABASE.md §15.10). `requireCompanyId` throws when
   * there is no tenant, so an unscoped key cannot be built by omission.
   */
  tenantKey(namespace: string, ...parts: Array<string | number>): string {
    const companyId = this.context.requireCompanyId(`redis key "${namespace}"`);
    return ['t', companyId, namespace, ...parts].join(':');
  }

  /** For genuinely platform-wide values. Named so it stands out in review. */
  globalKey(namespace: string, ...parts: Array<string | number>): string {
    return ['g', namespace, ...parts].join(':');
  }

  // ---------------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------------

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt entry is a cache miss, not a request failure.
      this.logger.warn(`Discarding unparseable cache entry at ${key}`);
      await this.del(key);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const value = await this.client.incr(key);
    // Set the TTL only on creation, so a rolling counter does not extend its
    // own window on every hit — the classic rate-limiter bug.
    if (value === 1 && ttlSeconds && ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
    return value;
  }
}

function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
}
