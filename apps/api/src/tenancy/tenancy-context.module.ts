import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './context/request-context.service';

/**
 * The AsyncLocalStorage holder, on its own so it can be imported by
 * DatabaseModule without a cycle (TenancyModule depends on DatabaseModule for
 * the membership lookup, so it cannot also be its dependency).
 *
 * Global and singleton: one store per process, entered per request.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class TenancyContextModule {}
