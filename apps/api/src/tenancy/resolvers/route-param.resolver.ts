import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config';
import type { TenantCandidate, TenantResolutionInput, TenantResolver } from './tenant-resolver.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * `/api/v1/companies/:companyId/...` and `/api/v1/c/:companySlug/...`.
 *
 * This resolver is the one most likely to be attacked: the whole point of the
 * "nested resource attack" test is that a Company A user sends Company B's id
 * here. It answers the question anyway — because refusing to *read* the
 * parameter is not the defence. The defence is that the value goes to
 * MembershipService, which will not find a membership and will return 404.
 */
@Injectable()
export class RouteParamTenantResolver implements TenantResolver {
  readonly name = 'route-param';
  readonly priority = 10;

  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return this.config.tenantResolvers.routeParam;
  }

  resolve(input: TenantResolutionInput): TenantCandidate | null {
    const id = input.params['companyId'];
    if (id && UUID_RE.test(id)) {
      return { source: 'ROUTE_PARAM', explicit: true, companyId: id.toLowerCase() };
    }

    const slug = input.params['companySlug'];
    if (slug && SLUG_RE.test(slug.toLowerCase())) {
      return { source: 'ROUTE_PARAM', explicit: true, companySlug: slug.toLowerCase() };
    }

    // A malformed parameter resolves to nothing rather than throwing. If the
    // route requires a tenant, the chain reports TENANT_UNRESOLVED; if it does
    // not, the request proceeds without one. Either way no company is guessed.
    return null;
  }
}
