import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantJobRunner } from './tenant-job.runner';

/**
 * Tenant-safe background execution.
 *
 * No queue library yet — TenantJobRunner is deliberately transport-agnostic, so
 * wiring BullMQ later means adding a processor that calls `runner.run(job, ...)`
 * and nothing else.
 */
@Module({
  imports: [DatabaseModule, TenancyModule],
  providers: [TenantJobRunner],
  exports: [TenantJobRunner],
})
export class JobsModule {}
