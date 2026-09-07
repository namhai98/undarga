// Side-effect import: BigInt has no JSON representation, and every money
// column in this schema is a BigInt. Must run before anything serialises a
// response. See the file for why money crosses the wire as a string.
import './common/json/bigint-serialization';

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { BranchesModule } from './branches/branches.module';
import { CatalogModule } from './catalog/catalog.module';
import { CompanyModule } from './company/company.module';
import { EmployeesModule } from './employees/employees.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionGuard } from './authz/guards/permission.guard';
import { DomainExceptionFilter } from './common/filters';
import {
  RequestLoggingInterceptor,
  ResponseEnvelopeInterceptor,
} from './common/interceptors';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { ConfigModule } from './config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { MailModule } from './mail/mail.module';
import { MembersModule } from './members/members.module';
import { UsersModule } from './users/users.module';
import { PlatformModule } from './platform/platform.module';
import { RedisModule } from './redis/redis.module';
import { TenantGuard } from './tenancy/guards/tenant.guard';
import { TenancyModule } from './tenancy/tenancy.module';

/**
 * ---------------------------------------------------------------------------
 * GUARD ORDER IS PART OF THE SECURITY MODEL
 * ---------------------------------------------------------------------------
 *
 * APP_GUARD providers execute in registration order, and this order is not
 * arbitrary:
 *
 *   1. JwtAuthGuard    — who is asking. Puts the actor in the context.
 *   2. TenantGuard     — which company. Needs the actor from step 1 to check
 *                        membership; produces the tenant context.
 *   3. PermissionGuard — what they may do. Needs the permission set from
 *                        step 2, because permissions are per membership, not
 *                        per user.
 *
 * Reordering these silently breaks isolation — PermissionGuard running first
 * would read an empty permission set and either deny everything or, worse, be
 * "fixed" by making it tolerate a missing tenant.
 *
 * All three DENY BY DEFAULT. An endpoint with no decorators requires
 * authentication, requires a company, and is reachable. Opting out is explicit:
 * `@Public()`, `@NoTenant()`, `@PlatformOnly()`.
 *
 * ---------------------------------------------------------------------------
 * INTERCEPTOR ORDER
 * ---------------------------------------------------------------------------
 *
 * Interceptors wrap outward-in on the way down and inward-out on the way back,
 * so logging is registered first to measure the whole handler including the
 * envelope, and the envelope runs closest to the controller's return value.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    TenancyModule,
    PlatformModule,
    MailModule,
    AuthModule,
    AuditModule,
    MembersModule,
    CompanyModule,
    BranchesModule,
    EmployeesModule,
    CatalogModule,
    UsersModule,
    JobsModule,
    HealthModule,
    /**
     * A default ceiling on every route, with tighter per-route limits declared
     * where they matter (see AccountController).
     *
     * In-memory storage, which means PER REPLICA: behind three instances the
     * effective limit is three times this. That is a real limitation and the
     * fix is a Redis store — deferred because Redis is optional here by
     * decision, and a limiter that silently stops working when Redis is down
     * would be worse than one that is honestly approximate.
     *
     * The generous default exists so that ordinary traffic is never affected;
     * it is a backstop against a runaway client, not the security control. The
     * security control is the per-route limits and the per-account ceilings in
     * AccountService.
     */
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
      /**
       * Evaluated per request, and reading `process.env` directly — the one
       * place in this codebase that does.
       *
       * The rule is that configuration goes through AppConfig so a
       * misconfiguration fails at boot. `THROTTLE_ENABLED` still does: it is
       * declared and validated in env.schema.ts, and production reads it there.
       * What this needs on top is to be togglable AFTER the module graph is
       * built, and AppConfig cannot provide that — `ConfigModule.forRoot()` is
       * evaluated once when this file is first imported, so every test harness
       * in a process shares the value captured before the first one ran.
       *
       * The alternative was overriding the guard in the test module, which
       * silently does nothing for an APP_GUARD, and a security control that
       * appears disabled but is not (or vice versa) is worse than either state.
       */
      skipIf: () => process.env.THROTTLE_ENABLED === 'false',
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },

    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },

    // Throttling runs BEFORE authentication, deliberately. The endpoints most
    // worth limiting — login, forgot-password — are the ones where the caller
    // has no session yet, so a limiter that ran after auth would never see
    // them.
    //
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must cover every route, including public ones: the context carries the
    // request id that appears in error responses and log lines, and a 401
    // should still be correlatable.
    //
    // `{*path}` rather than `*` — Express 5 (NestJS 11) uses path-to-regexp v8,
    // where a bare `*` is no longer a valid wildcard.
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
