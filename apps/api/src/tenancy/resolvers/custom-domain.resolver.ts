import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config';
import { TenantDirectoryService } from '../directory/tenant-directory.service';
import type {
  TenantCandidate,
  TenantResolutionInput,
  TenantResolver,
} from './tenant-resolver.types';

/**
 * `book.acme.mn` -> the company that verified that hostname.
 *
 * WIRED BUT DISABLED (TENANT_RESOLVER_CUSTOM_DOMAIN=false).
 *
 * The code path is complete and tested so that enabling custom domains later
 * is a config change plus the DNS/TLS work, not a refactor of tenant
 * resolution. It stays off because the pieces it depends on do not exist yet:
 *
 *   - DNS TXT verification. Without it, anyone who can point a CNAME at us
 *     could claim a hostname and, worse, receive another tenant's branding.
 *     Hence the `status = ACTIVE` filter in the directory lookup: an
 *     unverified company_domain row resolves to nothing.
 *   - On-demand certificate issuance.
 *
 * A hostname resolving here still grants nothing on its own. It only tells the
 * membership check which company the visitor is looking at.
 */
@Injectable()
export class CustomDomainTenantResolver implements TenantResolver {
  readonly name = 'custom-domain';
  readonly priority = 40;

  private readonly logger = new Logger(CustomDomainTenantResolver.name);

  constructor(
    private readonly config: AppConfig,
    private readonly directory: TenantDirectoryService,
  ) {}

  isEnabled(): boolean {
    return this.config.tenantResolvers.customDomain;
  }

  async resolve(input: TenantResolutionInput): Promise<TenantCandidate | null> {
    const hostname = normaliseHost(input.host);
    if (!hostname) return null;

    // Ignore the platform's own apex: it is not a tenant domain.
    if (hostname === this.config.subdomainRoot) return null;

    const companyId = await this.directory.findCompanyIdByVerifiedHostname(hostname);
    if (!companyId) return null;

    this.logger.debug(`custom domain ${hostname} -> company ${companyId}`);
    return { source: 'CUSTOM_DOMAIN', explicit: true, companyId, hostname };
  }
}

export function normaliseHost(host?: string): string | null {
  if (!host) return null;
  // Strip port, lowercase, drop a trailing dot from a fully-qualified name.
  const bare = host.split(':')[0]?.trim().toLowerCase().replace(/\.$/, '');
  return bare && bare.length > 0 ? bare : null;
}
