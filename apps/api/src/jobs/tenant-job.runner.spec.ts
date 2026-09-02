import { JobTenantMismatchError, JobTenantMissingError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import type { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import type { TenantPrismaService } from '../database/tenant-prisma.service';
import {
  TenantJobRunner,
  assertBelongsToCompany,
  type TenantJob,
  type TenantJobPayload,
} from './tenant-job.runner';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';

function directoryStub(known: Record<string, { deletedAt?: Date | null }> = {}) {
  return {
    getCompany: async (id: string) => {
      const found = known[id];
      if (!found) return null;
      return {
        id,
        slug: `slug-${id.slice(-1)}`,
        status: 'ACTIVE',
        defaultTimezoneName: 'Asia/Ulaanbaatar',
        currencyCode: 'MNT',
        deletedAt: found.deletedAt ?? null,
      };
    },
  } as unknown as TenantDirectoryService;
}

function dbStub() {
  const scopes: string[] = [];
  return {
    scopes,
    service: {
      runInCompany: async <T>(companyId: string, fn: (tx: unknown) => Promise<T>) => {
        scopes.push(companyId);
        return fn({});
      },
    } as unknown as TenantPrismaService,
  };
}

interface ReminderPayload extends TenantJobPayload {
  appointmentId: string;
}

describe('TenantJobRunner', () => {
  let context: RequestContextService;

  beforeEach(() => {
    context = new RequestContextService();
  });

  describe('payload validation', () => {
    // A worker has no HTTP request to inherit from — the context was torn down
    // when the response was sent. If the payload does not carry the company,
    // there is nowhere else to get it, and the tempting fix ("trusted worker,
    // skip the filter") is the bug this module exists to prevent.
    it('refuses a job with no companyId', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub(), service);
      const job = { name: 'send-reminder', data: {} } as unknown as TenantJob;

      await expect(runner.run(job, async () => 'done')).rejects.toThrow(JobTenantMissingError);
    });

    it('refuses a job whose company no longer exists', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub({}), service);
      const job: TenantJob = { name: 'send-reminder', data: { companyId: COMPANY_A } };

      await expect(runner.run(job, async () => 'done')).rejects.toThrow(JobTenantMissingError);
    });

    it('refuses a job for a purged company', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(
        context,
        directoryStub({ [COMPANY_A]: { deletedAt: new Date() } }),
        service,
      );
      const job: TenantJob = { name: 'send-reminder', data: { companyId: COMPANY_A } };

      await expect(runner.run(job, async () => 'done')).rejects.toThrow(JobTenantMissingError);
    });

    it('names the job in the error so the producer is findable', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub(), service);
      const job = { name: 'send-reminder', data: {} } as unknown as TenantJob;

      const error = await runner.run(job, async () => 'x').catch((e) => e);
      expect((error as Error).message).toContain('send-reminder');
    });
  });

  describe('context establishment', () => {
    it('makes the company available to the handler through the ambient context', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(
        context,
        directoryStub({ [COMPANY_A]: {} }),
        service,
      );
      const job: TenantJob<ReminderPayload> = {
        name: 'send-reminder',
        data: { companyId: COMPANY_A, appointmentId: 'appt-1' },
      };

      const seen = await runner.run(job, async () => context.requireCompanyId());
      expect(seen).toBe(COMPANY_A);
    });

    it('runs as a SYSTEM actor with no membership', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub({ [COMPANY_A]: {} }), service);
      const job: TenantJob = { name: 'nightly-rollup', data: { companyId: COMPANY_A } };

      await runner.run(job, async () => {
        const actor = context.requireActor();
        expect(actor.kind).toBe('SYSTEM');
        // A job is not a member of anything; handlers needing one must load it.
        expect(context.membership()).toBeNull();
        expect(context.requireTenant().source).toBe('JOB_PAYLOAD');
      });
    });

    it('does not leak the context after the job finishes', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub({ [COMPANY_A]: {} }), service);
      await runner.run({ name: 'j', data: { companyId: COMPANY_A } }, async () => 'ok');
      expect(context.tenantOrNull()).toBeNull();
    });

    it('carries the originating request id for correlation', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub({ [COMPANY_A]: {} }), service);

      const seen = await runner.run(
        { name: 'j', data: { companyId: COMPANY_A, requestId: 'req-original' } },
        async (_payload, ctx) => ctx.requestId,
      );

      expect(seen).toBe('req-original');
    });

    it('scopes the handler transaction to the job company', async () => {
      const { service, scopes } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub({ [COMPANY_A]: {} }), service);

      await runner.run({ name: 'j', data: { companyId: COMPANY_A } }, async (_p, ctx) =>
        ctx.withTransaction(async () => 'done'),
      );

      expect(scopes).toEqual([COMPANY_A]);
    });

    it('keeps two concurrent jobs for different companies separate', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(
        context,
        directoryStub({ [COMPANY_A]: {}, [COMPANY_B]: {} }),
        service,
      );

      const observe = (companyId: string, delay: number) =>
        runner.run({ name: 'j', data: { companyId } }, async () => {
          await new Promise((r) => setTimeout(r, delay));
          return context.requireCompanyId();
        });

      const [a, b] = await Promise.all([observe(COMPANY_A, 15), observe(COMPANY_B, 3)]);
      expect(a).toBe(COMPANY_A);
      expect(b).toBe(COMPANY_B);
    });
  });

  describe('assertBelongsToCompany', () => {
    // The second check. A job payload is data at rest: it sat in Redis for
    // hours, and the id in it may now belong to someone else, or may have been
    // put there by a poisoned producer.
    it('accepts an entity from the job company', () => {
      expect(() =>
        assertBelongsToCompany('send-reminder', COMPANY_A, 'Appointment', {
          companyId: COMPANY_A,
        }),
      ).not.toThrow();
    });

    it('refuses an entity from another company', () => {
      expect(() =>
        assertBelongsToCompany('send-reminder', COMPANY_A, 'Appointment', {
          companyId: COMPANY_B,
        }),
      ).toThrow(JobTenantMismatchError);
    });

    it('reports both companies in the error', () => {
      try {
        assertBelongsToCompany('send-reminder', COMPANY_A, 'Appointment', { companyId: COMPANY_B });
        fail('expected a throw');
      } catch (error) {
        expect((error as Error).message).toContain(COMPANY_A);
        expect((error as Error).message).toContain(COMPANY_B);
      }
    });

    it('tolerates a missing entity', () => {
      // Under RLS a cross-company id simply returns nothing, so "not found" is
      // the expected outcome of an attack. Whether that is fatal is the
      // caller's decision; this helper only guarantees a present entity is the
      // right tenant's.
      expect(() => assertBelongsToCompany('j', COMPANY_A, 'Appointment', null)).not.toThrow();
    });

    it('is reachable from the handler context', async () => {
      const { service } = dbStub();
      const runner = new TenantJobRunner(context, directoryStub({ [COMPANY_A]: {} }), service);

      await expect(
        runner.run({ name: 'send-reminder', data: { companyId: COMPANY_A } }, async (_p, ctx) => {
          ctx.assertBelongsToCompany('Appointment', { companyId: COMPANY_B });
          return 'unreachable';
        }),
      ).rejects.toThrow(JobTenantMismatchError);
    });
  });
});
