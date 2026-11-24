import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../../redis/redis.service';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Hit counter + block marker, atomically:
 *
 *   KEYS[1] hits    fixed window of `ttl` ms, created on the first hit
 *   KEYS[2] block   set for `blockDuration` ms when the limit is exceeded
 *
 * While blocked, hits are not counted (as in the in-memory storage), so the
 * window starts fresh when the block lifts.
 */
const INCREMENT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  local ttl = redis.call('PTTL', KEYS[1])
  return {hits, ttl, blockTtl}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, ttl, tonumber(ARGV[3])}
end
return {hits, ttl, 0}
`;

/**
 * Rate-limit counters in Redis, so every API replica counts against the same
 * limit. With the in-memory storage, N replicas allow N times the configured
 * rate — and a login limit of 10/min becomes 10×N.
 *
 * Falls back to the in-memory storage when Redis is not connected (local
 * development, or a brief outage in production, which refuses to start
 * without Redis). Falling back keeps a per-replica limit rather than none.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly local = new ThrottlerStorageService();
  private warned = false;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.redis.isReady) return this.fallback(key, ttl, limit, blockDuration, throttlerName);
    try {
      const hitsKey = this.redis.globalKey('throttle', throttlerName, key);
      const result = (await this.redis.raw.eval(
        INCREMENT,
        2,
        hitsKey,
        `${hitsKey}:blocked`,
        String(ttl),
        String(limit),
        String(blockDuration > 0 ? blockDuration : ttl),
      )) as [number, number, number];
      const [totalHits, ttlMs, blockMs] = result;
      this.warned = false;
      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
        isBlocked: blockMs > 0,
        timeToBlockExpire: Math.max(0, Math.ceil(blockMs / 1000)),
      };
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `Rate limiting fell back to this replica: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.fallback(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  private fallback(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    return this.local.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  onApplicationShutdown(): void {
    this.local.onApplicationShutdown();
  }
}
