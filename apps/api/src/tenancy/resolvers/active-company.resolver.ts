import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config';
import { isCompanyUser, isCustomerActor } from '../context';
import type { TenantCandidate, TenantResolutionInput, TenantResolver } from './tenant-resolver.types';

/**
 * The primary strategy: the company the authenticated user currently has
 * selected, carried as the `act` claim in their access token.
 *
 * The claim is *not* trusted as authorization. It is re-validated against
 * company_user on every request, so revoking a membership takes effect within
 * the access token's 15-minute lifetime at worst, and immediately for any
 * request after the session deny-list is updated.
 *
 * Deliberately implicit: it never overrides a company the caller named
 * explicitly, and it never conflicts with one — it simply loses.
 */
@Injectable()
export class ActiveCompanyTenantResolver implements TenantResolver {
  readonly name = 'active-company-claim';
  readonly priority = 20;

  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return this.config.tenantResolvers.activeCompany;
  }

  resolve(input: TenantResolutionInput): TenantCandidate | null {
    const actor = input.actor;
    if (!actor) return null;

    // A customer token is bound to exactly one company at issue time.
    if (isCustomerActor(actor)) {
      return { source: 'ACTIVE_COMPANY_CLAIM', explicit: false, companyId: actor.companyId };
    }

    if (!isCompanyUser(actor)) return null;

    // Populated by JwtAuthGuard from the signature-verified token — never from
    // anything the caller can set directly.
    return input.activeCompanyId
      ? { source: 'ACTIVE_COMPANY_CLAIM', explicit: false, companyId: input.activeCompanyId }
      : null;
  }
}
