import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config';
import { PlatformPrismaService } from '../database/platform-prisma.service';
import { RedisService } from '../redis/redis.service';

export type DependencyState = 'up' | 'down' | 'not_configured';

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, { status: DependencyState; latencyMs?: number }>;
}

/**
 * Readiness checks.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* IN THE RESPONSE
 * ---------------------------------------------------------------------------
 *
 * No hostnames, no ports, no database names, no driver error strings. A
 * readiness probe is unauthenticated and often reachable from further away than
 * anyone intends, and "connection refused to postgres://…@10.0.3.14:5432/undarga"
 * is a free network map. Callers get `up`, `down`, or `not_configured`, plus a
 * latency number that is useful for dashboards and tells an attacker nothing.
 *
 * The underlying error IS logged server-side, where operators can see it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATABASE CHECK USES THE PLATFORM CONNECTION
 * ---------------------------------------------------------------------------
 *
 * `SELECT 1` needs no tenant, and the tenant connection would demand one —
 * every query on it runs inside a transaction with `app.current_company_id`
 * set. Using the tenant pool here would mean either inventing a company or
 * adding an unscoped escape hatch, both worse than a single trivial query on a
 * connection this service already has.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {}

  async check(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);

    // Redis being down only blocks readiness when it is declared required.
    // Locally that lets the API serve while Redis is off; in production
    // REDIS_REQUIRED is forced true by env validation.
    const ready = database.status === 'up' && (redis.status !== 'down' || !this.config.redis.required);

    return { ready, checks: { database, redis } };
  }

  private async checkDatabase(): Promise<{ status: DependencyState; latencyMs?: number }> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (error) {
      this.logger.error(
        `Readiness: database unreachable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'down' };
    }
  }

  private async checkRedis(): Promise<{ status: DependencyState; latencyMs?: number }> {
    const started = Date.now();
    const ok = await this.redis.ping();

    if (ok) return { status: 'up', latencyMs: Date.now() - started };

    if (!this.config.redis.required) {
      this.logger.debug('Readiness: Redis down but not required in this environment');
      return { status: 'not_configured' };
    }

    this.logger.error('Readiness: Redis unreachable');
    return { status: 'down' };
  }
}
