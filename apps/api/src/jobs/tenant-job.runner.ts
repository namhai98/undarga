import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JobTenantMismatchError, JobTenantMissingError } from '../common/errors';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import type { TenantContext } from '../tenancy/context/context.types';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';

/**
 * Every tenant-scoped job payload must extend this.
 *
 * The company travels WITH the job, because by the time a worker picks it up
 * the HTTP request that created it is long gone — its AsyncLocalStorage context
 * was torn down when the response was sent. A worker that tried to "look up the
 * current tenant" would find none, and the tempting fix (skip the filter,
 * you're a trusted worker) is exactly the bug this whole module prevents.
 */
export interface TenantJobPayload {
  readonly companyId: string;
  /** Correlates the job's log lines and audit rows with the request that queued it. */
  readonly requestId?: string;
  /** Actor who caused the job, for the audit trail. Optional; SYSTEM if absent. */
  readonly causedByActorId?: string;
}

export interface TenantJob<T extends TenantJobPayload = TenantJobPayload> {
  readonly id?: string;
  readonly name: string;
  readonly data: T;
  readonly attemptsMade?: number;
}

/**
 * Runs a job inside its company's context.
 *
 * ---------------------------------------------------------------------------
 * NOT COUPLED TO BULLMQ
 * ---------------------------------------------------------------------------
 *
 * `TenantJob` is a structural interface that BullMQ's `Job` satisfies as-is, so
 * the queue library can be chosen (or replaced) without touching tenant safety.
 * It also means this whole file is unit-testable with a plain object literal
 * and no Redis, which is how the isolation tests for jobs run.
 *
 * ---------------------------------------------------------------------------
 * TWO CHECKS, NOT ONE
 * ---------------------------------------------------------------------------
 *
 *   1. The payload must name a company, and that company must exist and be
 *      live. A job with no `companyId` fails loudly rather than running
 *      unscoped.
 *
 *   2. Every entity the handler touches must be re-verified as belonging to
 *      that company — `assertBelongsToCompany`. This is the check the brief's
 *      Test 10 exercises. It matters because a job payload is data at rest: it
 *      sat in Redis, possibly for hours, and an appointment id in it may by now
 *      belong to a different company than the enqueuer assumed, or may have
 *      been placed there by a poisoned producer.
 *
 * Handlers get a tenant-scoped transaction, so even a handler that ignores the
 * helper cannot read across companies: RLS is active and the repository layer
 * still injects `companyId`.
 */
@Injectable()
export class TenantJobRunner {
  private readonly logger = new Logger(TenantJobRunner.name);

  constructor(
    private readonly context: RequestContextService,
    private readonly directory: TenantDirectoryService,
    private readonly db: TenantPrismaService,
  ) {}

  /**
   * Establish the tenant context for a job and run its handler inside it.
   *
   * @throws JobTenantMissingError when the payload carries no company, or names
   *         one that does not exist. Both are producer bugs and both must stop
   *         the job rather than widen it.
   */
  async run<T extends TenantJobPayload, R>(
    job: TenantJob<T>,
    handler: (payload: T, ctx: TenantJobContext) => Promise<R>,
  ): Promise<R> {
    const companyId = job.data?.companyId;

    if (!companyId || typeof companyId !== 'string') {
      throw new JobTenantMissingError(job.name);
    }

    const company = await this.directory.getCompany(companyId);
    if (!company || company.deletedAt !== null) {
      // A job for a company that has been purged. Fail rather than guess.
      throw new JobTenantMissingError(`${job.name} (company ${companyId} not found)`);
    }

    const tenant: TenantContext = {
      company: {
        id: company.id,
        slug: company.slug,
        status: company.status,
        operationalStatus: company.status === 'ACTIVE' ? 'ACTIVE' : 'READ_ONLY',
        defaultTimezoneName: company.defaultTimezoneName,
        currencyCode: company.currencyCode,
      },
      // A job is not a member of anything. Handlers that need a membership must
      // load one explicitly rather than inheriting a fictional one.
      membership: null,
      // Jobs act with the company's full authority by design — they are the
      // system doing what the system was asked to do — but they are still
      // confined to ONE company, which is the property that matters.
      permissions: new Set<string>(),
      source: 'JOB_PAYLOAD',
      viaPlatformAccess: false,
    };

    const requestId = job.data.requestId ?? randomUUID();

    return this.context.runAsSystem(
      `job:${job.name}`,
      tenant,
      async () => {
        this.logger.debug(
          `Running ${job.name} for company ${company.slug} (attempt ${(job.attemptsMade ?? 0) + 1})`,
        );
        return handler(job.data, {
          companyId: company.id,
          requestId,
          assertBelongsToCompany: (model, entity) =>
            assertBelongsToCompany(job.name, company.id, model, entity),
          withTransaction: <X>(fn: (tx: TenantTx) => Promise<X>) =>
            this.db.runInCompany(company.id, fn),
        });
      },
      requestId,
    );
  }
}

export interface TenantJobContext {
  readonly companyId: string;
  readonly requestId: string;
  /**
   * Re-verify that a loaded entity really belongs to this job's company.
   *
   * Belt and braces on top of RLS. Cheap, and it turns a silent
   * cross-company touch into a loud failure with the job name attached.
   */
  assertBelongsToCompany(model: string, entity: { companyId: string } | null | undefined): void;
  /** A tenant-scoped transaction. RLS is active inside it. */
  withTransaction<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export function assertBelongsToCompany(
  jobName: string,
  expectedCompanyId: string,
  model: string,
  entity: { companyId: string } | null | undefined,
): void {
  if (!entity) {
    // Under RLS a cross-company id simply returns nothing, so "not found" here
    // is the *expected* outcome of an attack and must not be treated as
    // success. Callers decide whether a miss is fatal; this only guarantees
    // that a present entity is the right tenant's.
    return;
  }

  if (entity.companyId !== expectedCompanyId) {
    throw new JobTenantMismatchError(jobName, expectedCompanyId, entity.companyId);
  }

  void model;
}
