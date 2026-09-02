import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import { TtlCache } from '../common/cache';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * Resolves a platform operator's permissions.
 *
 * Read per request rather than carried in the token. Platform permissions are
 * the only grants in the system that cross the tenant boundary, so a 15-minute
 * staleness window between revoking one and it taking effect is not acceptable
 * — an operator who has just been offboarded should lose access now, not at
 * their next refresh.
 *
 * The cache keeps that from becoming a query per request; its TTL is the
 * deliberate upper bound on revocation lag, and `invalidate` drops it to zero
 * for the common case where the revocation happens on this replica.
 */
@Injectable()
export class PlatformIdentityService {
  private readonly logger = new Logger(PlatformIdentityService.name);
  private readonly cache: TtlCache<ReadonlySet<string>>;

  constructor(
    private readonly prisma: PlatformPrismaService,
    config: AppConfig,
  ) {
    // Shorter than the tenant cache: these grants are worth re-checking often.
    this.cache = new TtlCache(Math.min(config.tenantCacheTtlSeconds, 30) * 1000, 1_000);
  }

  async loadPermissions(platformUserId: string): Promise<ReadonlySet<string>> {
    return this.cache.getOrLoad(platformUserId, async () => {
      const user = await this.prisma.platformUser.findFirst({
        where: { id: platformUserId, status: 'ACTIVE', deletedAt: null },
        select: {
          roles: {
            select: {
              role: { select: { permissions: { select: { permissionKey: true } } } },
            },
          },
        },
      });

      if (!user) {
        // Disabled or deleted between token issue and now. An empty set means
        // every platform check fails closed.
        this.logger.warn(`Platform user ${platformUserId} is no longer active; no permissions`);
        return new Set<string>();
      }

      const keys = user.roles.flatMap((assignment) =>
        assignment.role.permissions.map((p) => p.permissionKey),
      );
      return new Set(keys);
    });
  }

  invalidate(platformUserId: string): void {
    this.cache.delete(platformUserId);
  }
}
