import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfig } from '../config';
import { MissingTenantContextError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { assertTenantScoped } from './tenant-scope.guard-extension';
import { tenantModelSummary } from './tenant-models';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createTenantClient(config: AppConfig) {
  const base = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
    log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

  return base.$extends({
    name: 'tenant-scope-assertion',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          assertTenantScoped(model, operation, args);
          return query(args);
        },
      },
    },
  });
}

export type ExtendedTenantClient = ReturnType<typeof createTenantClient>;

/**
 * The transaction client handed to callbacks. Mirrors Prisma's own
 * ITXClientDenyList: you cannot nest a transaction or reconnect from inside one.
 */
export type TenantTx = Omit<
  ExtendedTenantClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * The tenant-scoped database connection.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY QUERY RUNS INSIDE A TRANSACTION
 * ---------------------------------------------------------------------------
 *
 * RLS reads the company from a Postgres runtime setting:
 *
 *     USING (company_id = current_setting('app.current_company_id')::uuid)
 *
 * Something has to set it, and the only safe way is `SET LOCAL` — which exists
 * only inside a transaction. A plain `SET` would persist on the pooled
 * connection and be inherited by whichever request picks that connection up
 * next, which is a cross-tenant data leak with no error and no trace.
 *
 * So: every unit of work, read or write, is wrapped. That is a real cost — an
 * interactive transaction holds a connection for its duration — and it is
 * flagged in docs/DATABASE.md as the first thing to benchmark. It is paid
 * deliberately, because the alternative is RLS that does not actually apply.
 *
 * `set_config(..., true)` is used rather than literal `SET LOCAL` because it
 * accepts a bind parameter. `SET LOCAL` does not, which would mean
 * interpolating a value into SQL.
 */
@Injectable()
export class TenantPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantPrismaService.name);
  private readonly client: ExtendedTenantClient;

  constructor(
    private readonly config: AppConfig,
    private readonly context: RequestContextService,
  ) {
    this.client = createTenantClient(config);
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    await this.assertRlsIsActuallyEnforced();

    const summary = tenantModelSummary();
    this.logger.log(
      `Tenant connection established — ${summary.tenantScoped}/${summary.total} models are ` +
        `company-scoped and guarded`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * Refuse to boot if the "tenant" connection can bypass RLS.
   *
   * Pointing DATABASE_URL at the platform role is an easy mistake — the app
   * works perfectly and every isolation test passes for the wrong reason. This
   * check makes that misconfiguration impossible to ship.
   */
  private async assertRlsIsActuallyEnforced(): Promise<void> {
    const rows = await this.client.$queryRaw<Array<{ rolbypassrls: boolean; rolname: string }>>(
      Prisma.sql`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const role = rows[0];

    if (!role) {
      this.logger.warn('Could not determine the current database role; skipping the RLS check.');
      return;
    }

    if (role.rolbypassrls) {
      throw new Error(
        `DATABASE_URL connects as "${role.rolname}", which has BYPASSRLS. Row-level ` +
          'security would be inert on every request. Point DATABASE_URL at the ' +
          'app_tenant role. Refusing to start.',
      );
    }

    this.logger.log(`Tenant role "${role.rolname}" confirmed subject to row-level security`);
  }

  /**
   * Run a unit of work as the company currently in the request context.
   *
   * This is the method application code should use. It throws if no tenant is
   * set, which is the behaviour Test 11 asserts: a missing tenant context is a
   * failure, never a widened query.
   */
  async run<T>(fn: (tx: TenantTx) => Promise<T>, operation?: string): Promise<T> {
    const tenant = this.context.requireTenant(operation ?? 'database access');
    return this.runInCompany(tenant.company.id, fn);
  }

  /**
   * Run a unit of work in a named company.
   *
   * Reserved for callers that legitimately establish their own tenant: the job
   * runner and the platform module. Feature code should call `run()` so that
   * the company can only ever come from an authorised context.
   */
  async runInCompany<T>(companyId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(companyId)) {
      // Never interpolate an unvalidated value into a session setting, even one
      // that is parameterised — a malformed id here means a bug upstream.
      throw new MissingTenantContextError(`runInCompany: "${companyId}" is not a valid company id`);
    }

    return this.client.$transaction(async (tx) => {
      // `true` = transaction-local, released at COMMIT/ROLLBACK.
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return fn(tx as unknown as TenantTx);
    });
  }

  /**
   * Escape hatch for the handful of tables that are readable without a tenant
   * (currency, timezone, permission, feature, plan). RLS allows SELECT on those
   * to everyone, so no company needs to be set.
   *
   * Named awkwardly on purpose: it should be obvious in review that a caller
   * has stepped outside the tenant boundary.
   */
  async runOnGlobalReferenceData<T>(fn: (client: ExtendedTenantClient) => Promise<T>): Promise<T> {
    return fn(this.client);
  }
}
