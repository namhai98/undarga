import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config';
import { normaliseHost } from './custom-domain.resolver';
import type { TenantCandidate, TenantResolutionInput, TenantResolver } from './tenant-resolver.types';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * `acme.booking.app` -> company slug `acme`.
 *
 * WIRED BUT DISABLED (TENANT_RESOLVER_SUBDOMAIN=false) pending wildcard DNS and
 * a wildcard certificate.
 *
 * Reserved labels are refused rather than treated as slugs. Without this,
 * registering a company with the slug `api` would silently capture every
 * request to api.booking.app.
 */
const RESERVED_LABELS = new Set([
  'www', 'api', 'app', 'admin', 'platform', 'static', 'assets', 'cdn',
  'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2', 'status', 'docs', 'help',
  'support', 'blog', 'dev', 'staging', 'test', 'localhost',
]);

@Injectable()
export class SubdomainTenantResolver implements TenantResolver {
  readonly name = 'subdomain';
  readonly priority = 50;

  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return this.config.tenantResolvers.subdomain;
  }

  resolve(input: TenantResolutionInput): TenantCandidate | null {
    const hostname = normaliseHost(input.host);
    if (!hostname) return null;

    const root = this.config.subdomainRoot.toLowerCase();
    if (hostname === root || !hostname.endsWith(`.${root}`)) return null;

    const label = hostname.slice(0, -(root.length + 1));
    // Only a single label: `a.b.booking.app` is not a tenant.
    if (!label || label.includes('.')) return null;
    if (RESERVED_LABELS.has(label)) return null;
    if (!SLUG_RE.test(label)) return null;

    return { source: 'SUBDOMAIN', explicit: true, companySlug: label, hostname };
  }
}
