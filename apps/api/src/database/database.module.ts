import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { TenancyContextModule } from '../tenancy/tenancy-context.module';
import { PlatformPrismaService } from './platform-prisma.service';
import { TenantPrismaService } from './tenant-prisma.service';

/**
 * Both database connections.
 *
 * Global so repositories anywhere can inject TenantPrismaService without
 * importing this module. PlatformPrismaService is exported too — it has to be,
 * for the four allowlisted consumers — and is fenced by the ESLint rule rather
 * than by module boundaries, because Nest has no way to export a provider to
 * only some importers.
 */
@Global()
@Module({
  imports: [ConfigModule, TenancyContextModule],
  providers: [TenantPrismaService, PlatformPrismaService],
  exports: [TenantPrismaService, PlatformPrismaService],
})
export class DatabaseModule {}
