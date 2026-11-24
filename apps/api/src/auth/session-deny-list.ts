import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import { TtlCache } from '../common/cache';
import { RedisService } from '../redis/redis.service';

/**
 * Sessions revoked before their access token would have expired.
 *
 * Access tokens are stateless and short-lived (15 minutes), so logout, a
 * password change, or refresh-token reuse would otherwise take up to that long
 * to bite. The deny-list closes the window: the session id is added on
 * revocation and every authenticated request checks it.
 *
 * ---------------------------------------------------------------------------
 * SHARED ACROSS REPLICAS
 * ---------------------------------------------------------------------------
 *
 * A revocation is written to Redis as well as to this process, so every API
 * replica sees it on the next request. Entries expire with the longest access
 * token they could still block.
 *
 * The in-process copy stays: it answers the revoking replica without a round
 * trip, and it is what remains if Redis is briefly unreachable. Production
 * refuses to start without Redis (REDIS_REQUIRED), so the in-process-only mode
 * is development and short outages, and an outage is logged.
 */
@Injectable()
export class SessionDenyList {
  private readonly logger = new Logger(SessionDenyList.name);
  private readonly revoked: TtlCache<true>;
  private readonly ttlSeconds: number;

  constructor(
    config: AppConfig,
    private readonly redis: RedisService,
  ) {
    // Entries only need to outlive the longest access token.
    this.ttlSeconds = config.auth.jwtAccessTtlSeconds + 60;
    this.revoked = new TtlCache<true>(this.ttlSeconds * 1000, 100_000);
  }

  revoke(sessionId: string): void {
    this.revoked.set(sessionId, true);
    if (!this.redis.isReady) {
      this.logger.warn('Redis unavailable: session revocation recorded on this replica only');
      return;
    }
    // Not awaited: callers revoke inside flows that must not fail because the
    // cache did. The database row is already revoked, so refresh is refused
    // everywhere regardless; this only shortens the access-token window.
    this.redis.set(this.key(sessionId), '1', this.ttlSeconds).catch((error: unknown) => {
      this.logger.warn(`Could not share a session revocation: ${describe(error)}`);
    });
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    if (this.revoked.get(sessionId) === true) return true;
    if (!this.redis.isReady) return false;
    try {
      const shared = await this.redis.exists(this.key(sessionId));
      if (shared) this.revoked.set(sessionId, true);
      return shared;
    } catch (error) {
      this.logger.warn(`Could not read shared session revocations: ${describe(error)}`);
      return false;
    }
  }

  get size(): number {
    return this.revoked.size;
  }

  private key(sessionId: string): string {
    return this.redis.globalKey('session-revoked', sessionId);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
