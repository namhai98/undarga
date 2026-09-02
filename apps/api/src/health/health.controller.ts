import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { TenantResolverChain } from '../tenancy/resolvers/tenant-resolver.chain';
import { tenantModelSummary } from '../database/tenant-models';
import { AppConfig } from '../config';

@Controller({ path: 'health', version: '1' })
@Public()
@NoTenant()
export class HealthController {
  constructor(
    private readonly resolvers: TenantResolverChain,
    private readonly config: AppConfig,
  ) {}

  @Get()
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Reports the tenancy configuration that is actually in effect.
   *
   * Useful in an incident: "is the custom-domain resolver on in prod?" and "are
   * all 60 tenant models guarded?" should be answerable without shell access.
   * Deliberately exposes no tenant data.
   */
  @Get('tenancy')
  tenancy() {
    return {
      resolvers: this.resolvers.enabledResolvers(),
      poolingMode: this.config.poolingMode,
      models: tenantModelSummary(),
      auditHashChain: this.config.auditHashChain,
    };
  }
}
