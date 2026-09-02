import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { TenantDirectoryService } from './directory/tenant-directory.service';
import { TenantGuard } from './guards/tenant.guard';
import { MembershipService } from './membership/membership.service';
import { ActiveCompanyTenantResolver } from './resolvers/active-company.resolver';
import { CustomDomainTenantResolver } from './resolvers/custom-domain.resolver';
import { HeaderTenantResolver } from './resolvers/header.resolver';
import { RouteParamTenantResolver } from './resolvers/route-param.resolver';
import { SubdomainTenantResolver } from './resolvers/subdomain.resolver';
import { TenantResolverChain } from './resolvers/tenant-resolver.chain';
import { TENANT_RESOLVER } from './resolvers/tenant-resolver.types';
import { TenancyContextModule } from './tenancy-context.module';

/**
 * Tenant resolution and membership validation.
 *
 * Adding a resolution strategy means adding a class and one line to the
 * multi-provider array below — no controller, guard or service changes. That is
 * the whole point of the TenantResolver abstraction: custom domains and
 * subdomains are already in the array, switched off by config, so enabling them
 * later is not a refactor.
 */
@Global()
@Module({
  imports: [ConfigModule, DatabaseModule, TenancyContextModule],
  providers: [
    TenantDirectoryService,
    MembershipService,
    TenantResolverChain,
    TenantGuard,

    RouteParamTenantResolver,
    ActiveCompanyTenantResolver,
    HeaderTenantResolver,
    CustomDomainTenantResolver,
    SubdomainTenantResolver,

    {
      provide: TENANT_RESOLVER,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [
        RouteParamTenantResolver,
        ActiveCompanyTenantResolver,
        HeaderTenantResolver,
        CustomDomainTenantResolver,
        SubdomainTenantResolver,
      ],
    },
  ],
  exports: [
    TenantDirectoryService,
    MembershipService,
    TenantResolverChain,
    TenantGuard,
    TenancyContextModule,
  ],
})
export class TenancyModule {}
