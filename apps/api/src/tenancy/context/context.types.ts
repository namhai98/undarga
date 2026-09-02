/**
 * The shapes carried through a request (or a job, or a socket) by
 * RequestContextService.
 *
 * Two principles hold everywhere below:
 *
 *   1. An actor is never "a user with an isAdmin flag". Company users and
 *      platform operators are different variants of a discriminated union, so
 *      `if (user.isAdmin) skipCompanyFilter` is not expressible. Widening
 *      access requires matching on `kind`, which is visible in review.
 *
 *   2. A TenantContext only ever exists if MembershipService produced it.
 *      Nothing else constructs one, so holding a TenantContext is itself proof
 *      that access was checked.
 */

export type ActorKind = 'COMPANY_USER' | 'PLATFORM_USER' | 'CUSTOMER' | 'SYSTEM';

export interface CompanyUserActor {
  readonly kind: 'COMPANY_USER';
  readonly userAccountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly sessionId: string;
}

export interface PlatformUserActor {
  readonly kind: 'PLATFORM_USER';
  readonly platformUserId: string;
  readonly email: string;
  readonly displayName: string;
  readonly sessionId: string;
  readonly platformPermissions: ReadonlySet<string>;
  /**
   * Present when the operator is acting through a time-boxed impersonation
   * grant. Recorded on every audit row produced during the request.
   */
  readonly impersonation?: {
    readonly grantId: string;
    readonly companyId: string;
    readonly allowWrites: boolean;
    readonly expiresAt: Date;
  };
}

/** End consumers booking online. Reserved — the customer realm is not built. */
export interface CustomerActor {
  readonly kind: 'CUSTOMER';
  readonly customerIdentityId: string;
  readonly companyCustomerId: string;
  readonly companyId: string;
}

/** Background jobs, schedulers, migrations. Never originates from a request. */
export interface SystemActor {
  readonly kind: 'SYSTEM';
  readonly name: string;
}

export type Actor = CompanyUserActor | PlatformUserActor | CustomerActor | SystemActor;

/** Which strategy produced the company for this request. Audited. */
export type TenantResolutionSource =
  | 'ROUTE_PARAM'
  | 'ACTIVE_COMPANY_CLAIM'
  | 'HEADER'
  | 'CUSTOM_DOMAIN'
  | 'SUBDOMAIN'
  | 'JOB_PAYLOAD'
  | 'SYSTEM';

export type CompanyOperationalStatus = 'ACTIVE' | 'READ_ONLY';

export interface CurrentMembership {
  readonly companyUserId: string;
  readonly userAccountId: string;
  readonly isOwner: boolean;
  readonly roleKeys: readonly string[];
  /**
   * null means every branch. An empty array means no branch, which is a
   * misconfiguration rather than a wildcard — the two must not be conflated.
   */
  readonly branchScope: readonly string[] | null;
}

export interface CurrentCompany {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
  readonly operationalStatus: CompanyOperationalStatus;
  readonly defaultTimezoneName: string;
  readonly currencyCode: string;
}

export interface TenantContext {
  readonly company: CurrentCompany;
  /**
   * Absent when a platform operator entered the tenant explicitly — they hold
   * no membership by design. `viaPlatformAccess` distinguishes the two cases.
   */
  readonly membership: CurrentMembership | null;
  readonly permissions: ReadonlySet<string>;
  readonly source: TenantResolutionSource;
  /**
   * True when a platform operator is inside a company they are not a member of.
   * Every audit row written during such a request is marked, and write paths
   * check it before allowing mutations.
   */
  readonly viaPlatformAccess: boolean;
}

export interface RequestContext {
  readonly requestId: string;
  readonly actor: Actor;
  /**
   * null on unauthenticated, platform-only, and deliberately tenant-less
   * routes (login, "list my companies", health). Reading it through
   * `requireTenant()` throws rather than returning null, so no query can
   * accidentally run unscoped.
   */
  readonly tenant: TenantContext | null;
  readonly startedAt: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export function isCompanyUser(actor: Actor): actor is CompanyUserActor {
  return actor.kind === 'COMPANY_USER';
}

export function isPlatformUser(actor: Actor): actor is PlatformUserActor {
  return actor.kind === 'PLATFORM_USER';
}

export function isCustomerActor(actor: Actor): actor is CustomerActor {
  return actor.kind === 'CUSTOMER';
}

export function isSystemActor(actor: Actor): actor is SystemActor {
  return actor.kind === 'SYSTEM';
}

/** Stable identifier for audit rows, regardless of which realm the actor is in. */
export function actorId(actor: Actor): string | null {
  switch (actor.kind) {
    case 'COMPANY_USER':
      return actor.userAccountId;
    case 'PLATFORM_USER':
      return actor.platformUserId;
    case 'CUSTOMER':
      return actor.companyCustomerId;
    case 'SYSTEM':
      return null;
  }
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'COMPANY_USER':
    case 'PLATFORM_USER':
      return `${actor.displayName} <${actor.email}>`;
    case 'CUSTOMER':
      return `customer:${actor.companyCustomerId}`;
    case 'SYSTEM':
      return `system:${actor.name}`;
  }
}
