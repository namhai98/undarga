import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { TenancyContextModule } from '../tenancy/tenancy-context.module';
import { RedisService } from './redis.service';

/**
 * Redis infrastructure.
 *
 * Global because caching, locks and rate limiting will be needed from many
 * modules, and threading an import through each of them buys nothing.
 * Depends on TenancyContextModule for `tenantKey()` — cache keys must carry the
 * company, the same rule the database layer enforces.
 */
@Global()
@Module({
  imports: [ConfigModule, TenancyContextModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
