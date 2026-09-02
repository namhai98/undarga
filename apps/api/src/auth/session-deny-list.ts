import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config';
import { TtlCache } from '../common/cache';

/**
 * Sessions revoked before their access token would have expired.
 *
 * Access tokens are stateless and short-lived (15 minutes), so logout, a role
 * change, or a membership revocation would otherwise take up to that long to
 * bite. The deny-list closes the window: the session id is added on revocation
 * and every request checks it.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITATION — THIS IS IN-PROCESS
 * ---------------------------------------------------------------------------
 *
 * With more than one API replica, a revocation registered on replica A is not
 * seen by replica B, and that replica keeps honouring the token until it
 * expires. Correct for single-instance and for development; NOT correct for a
 * multi-replica deployment.
 *
 * The fix is a Redis-backed implementation of this same interface, which is why
 * the class is this small and has no other responsibilities. It is listed as a
 * blocking item in the report — shipping multi-replica without it means
 * revocation is best-effort.
 */
@Injectable()
export class SessionDenyList {
  private readonly revoked: TtlCache<true>;

  constructor(config: AppConfig) {
    // Entries only need to outlive the longest access token.
    this.revoked = new TtlCache<true>((config.jwtAccessTtlSeconds + 60) * 1000, 100_000);
  }

  revoke(sessionId: string): void {
    this.revoked.set(sessionId, true);
  }

  isRevoked(sessionId: string): boolean {
    return this.revoked.get(sessionId) === true;
  }

  get size(): number {
    return this.revoked.size;
  }
}
