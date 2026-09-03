import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from '../config';

/**
 * The BYPASSRLS connection.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE INJECTING IT
 * ---------------------------------------------------------------------------
 *
 * This client connects as `app_platform`, a Postgres role with BYPASSRLS. Every
 * row-level security policy in the database is inert on it. It is a master key.
 *
 * It exists because three things genuinely cannot be tenant-scoped:
 *
 *   1. TENANT RESOLUTION ITSELF. Turning a hostname or slug into a company id
 *      is the query that *determines* the scope, so it cannot run inside one.
 *      This is a real chicken-and-egg, not laziness. It is contained by
 *      TenantDirectoryService, which reads four columns of `company` and
 *      `company_domain` and returns nothing else.
 *
 *   2. THE PLATFORM MODULE. Operators are supposed to see across companies.
 *      That access is deliberate, permission-gated, and audited.
 *
 *   3. WORKER CLAIM QUERIES. A dispatcher has to scan for pending work across
 *      tenants before it can know whose context to enter. Those queries select
 *      `(company_id, id)` pairs and nothing else; the actual work then runs
 *      inside the tenant.
 *
 * Anything else must use TenantPrismaService. The ESLint rule in .eslintrc.js
 * enforces the allowlist, and adding a file to it is a security decision.
 */
@Injectable()
export class PlatformPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformPrismaService.name);

  constructor(private readonly config: AppConfig) {
    super({
      datasources: { db: { url: config.platformDatabaseUrl } },
      log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Platform (BYPASSRLS) connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
