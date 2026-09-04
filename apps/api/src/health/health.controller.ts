import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { TenantResolverChain } from '../tenancy/resolvers/tenant-resolver.chain';
import { tenantModelSummary } from '../database/tenant-models';
import { AppConfig } from '../config';
import { HealthService } from './health.service';

/**
 * Health endpoints.
 *
 * Public and tenant-less, because an orchestrator has no credentials and no
 * company. That makes them the most exposed routes in the API, so they are
 * deliberately incurious: liveness says one word, and readiness says up/down
 * per dependency with no host, no port, no driver message.
 */
@ApiTags('health')
@Controller({ path: 'health', version: '1' })
@Public()
@NoTenant()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly resolvers: TenantResolverChain,
    private readonly config: AppConfig,
  ) {}

  /**
   * Liveness: is the process up?
   *
   * Checks nothing else on purpose. If this consulted the database, a brief
   * database outage would make the orchestrator kill and restart every healthy
   * API pod — turning a recoverable dependency blip into an outage.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness probe — is the process running?' })
  @ApiOkResponse({ description: 'The process is alive.' })
  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness: can this instance actually serve traffic?
   *
   * Returns 503 when a hard dependency is down so the load balancer takes the
   * instance out of rotation without restarting it.
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe — are dependencies reachable?' })
  @ApiOkResponse({ description: 'All required dependencies are reachable.' })
  async readiness(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.check();

    if (!result.ready) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }

  /**
   * The tenancy configuration actually in effect.
   *
   * Useful in an incident — "is the custom-domain resolver on in prod?", "are
   * all the tenant models guarded?" — without needing shell access. Exposes no
   * tenant data and no connection details.
   */
  @Get('tenancy')
  @ApiExcludeEndpoint()
  tenancy() {
    return {
      resolvers: this.resolvers.enabledResolvers(),
      poolingMode: this.config.database.poolingMode,
      models: tenantModelSummary(),
      auditHashChain: this.config.audit.hashChain,
    };
  }
}
