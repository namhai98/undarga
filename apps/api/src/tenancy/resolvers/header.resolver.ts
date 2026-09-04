import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config';
import type {
  TenantCandidate,
  TenantResolutionInput,
  TenantResolver,
} from './tenant-resolver.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * `X-Company-Id` / `X-Company-Slug`.
 *
 * Exists for API clients and for platform operators, who have no active
 * company of their own and must name their target explicitly on every
 * company-scoped call.
 *
 * Explicit, therefore it conflicts loudly with a route parameter that names a
 * different company rather than one silently winning.
 */
@Injectable()
export class HeaderTenantResolver implements TenantResolver {
  readonly name = 'header';
  readonly priority = 30;

  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return this.config.tenancy.resolvers.header;
  }

  resolve(input: TenantResolutionInput): TenantCandidate | null {
    const id = input.headers['x-company-id'];
    if (id && UUID_RE.test(id)) {
      return { source: 'HEADER', explicit: true, companyId: id.toLowerCase() };
    }

    const slug = input.headers['x-company-slug'];
    if (slug && SLUG_RE.test(slug.toLowerCase())) {
      return { source: 'HEADER', explicit: true, companySlug: slug.toLowerCase() };
    }

    return null;
  }
}
