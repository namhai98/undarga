/**
 * Domain errors. Thrown by services, mapped to HTTP by DomainExceptionFilter.
 *
 * The mapping is centralised on purpose: whether "you are not a member of this
 * company" is a 403 or a 404 is a security decision, and it should be made
 * once, here, rather than re-decided in every controller.
 */

import type { ApiErrorCode } from '@undarga/shared';

/**
 * The error vocabulary, re-exported from the shared wire contract.
 *
 * Declared in `@undarga/shared` rather than here because the web app branches
 * on these codes — `TENANT_UNRESOLVED` opens the company picker,
 * `SESSION_REVOKED` forces a sign-out. Single-sourcing them makes drift a
 * compile error on whichever side falls behind, instead of a silent
 * behavioural bug.
 */
export type ErrorCode = ApiErrorCode;

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  /** HTTP status the filter will emit. */
  abstract readonly status: number;
  /**
   * Safe to return to the caller? When false the filter emits a generic
   * message and logs the real one, so internal detail never leaks.
   */
  readonly exposeMessage: boolean = true;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly status = 401;
  constructor(message = 'Authentication required.') {
    super(message);
  }
}

export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS' as const;
  readonly status = 401;
  constructor() {
    // Deliberately identical whether the account exists, the password is wrong,
    // or the account is disabled. Anything more specific is an enumeration
    // oracle against the login endpoint.
    super('Email or password is incorrect.');
  }
}

export class TokenAudienceMismatchError extends DomainError {
  readonly code = 'TOKEN_AUDIENCE_MISMATCH' as const;
  readonly status = 401;
  constructor(expected: string, received: string) {
    super('Authentication required.', { expected, received });
  }
}

export class SessionRevokedError extends DomainError {
  readonly code = 'SESSION_REVOKED' as const;
  readonly status = 401;
  constructor() {
    super('Session is no longer valid. Sign in again.');
  }
}

export class RefreshTokenReusedError extends DomainError {
  readonly code = 'REFRESH_TOKEN_REUSED' as const;
  readonly status = 401;
  constructor() {
    // Presenting an already-rotated token means either a race or a stolen
    // token. Both revoke the whole family; the caller is told nothing useful.
    super('Session is no longer valid. Sign in again.');
  }
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * Raised when code asks for the tenant and there is none. This is the failure
 * that Test 11 exercises: a missing tenant context must break the request, not
 * quietly widen the query. It is a 500 because it means a route was wired
 * without the tenant guard — a bug, not user error.
 */
export class MissingTenantContextError extends DomainError {
  readonly code = 'TENANT_CONTEXT_MISSING' as const;
  readonly status = 500;
  override readonly exposeMessage = false;
  constructor(operation?: string) {
    super(
      `Tenant context was requested${operation ? ` for "${operation}"` : ''} but none is set. ` +
        'The route is missing TenantGuard, or the call happened outside runWithContext().',
    );
  }
}

export class TenantUnresolvedError extends DomainError {
  readonly code = 'TENANT_UNRESOLVED' as const;
  readonly status = 400;
  constructor() {
    super(
      'No company could be determined for this request. Provide a company in the ' +
        'route, set an active company on your session, or send the X-Company-Id header.',
    );
  }
}

/**
 * Two *explicit* sources disagreed — e.g. the URL says company A and the
 * X-Company-Id header says company B. Picking one silently is how confused
 * deputies are born, so this is always a hard failure.
 */
export class AmbiguousTenantError extends DomainError {
  readonly code = 'TENANT_AMBIGUOUS' as const;
  readonly status = 400;
  constructor(sources: string[]) {
    super('Conflicting company identifiers in this request.', { sources });
  }
}

/**
 * The company does not exist, OR it exists and the caller is not a member.
 *
 * These two cases MUST be indistinguishable. A 403 for "exists but not yours"
 * turns any company id into an existence oracle, and with UUIDv7 primary keys
 * that also leaks creation time. See docs/DATABASE.md 13.1.
 */
export class TenantNotFoundError extends DomainError {
  readonly code = 'TENANT_NOT_FOUND' as const;
  readonly status = 404;
  constructor(details?: Record<string, unknown>) {
    super('Company not found.', details);
  }
}

export class TenantSuspendedError extends DomainError {
  readonly code = 'TENANT_SUSPENDED' as const;
  readonly status = 403;
  constructor(status: string) {
    super('This company is suspended. Contact billing to restore access.', { status });
  }
}

export class TenantReadOnlyError extends DomainError {
  readonly code = 'TENANT_READ_ONLY' as const;
  readonly status = 402;
  constructor() {
    // 402 rather than 403: this is a billing state, not a permission problem,
    // and the client should surface an upgrade path rather than "access denied".
    super(
      'This company is in a read-only grace period. Settle the outstanding invoice to resume changes.',
    );
  }
}

export class MembershipInactiveError extends DomainError {
  readonly code = 'MEMBERSHIP_INACTIVE' as const;
  readonly status = 403;
  constructor(status: string) {
    super('Your membership of this company is not active.', { membershipStatus: status });
  }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export class PermissionDeniedError extends DomainError {
  readonly code = 'PERMISSION_DENIED' as const;
  readonly status = 403;
  constructor(required: string[]) {
    super('You do not have permission to perform this action.', { required });
  }
}

export class PlatformAccessRequiredError extends DomainError {
  readonly code = 'PLATFORM_ACCESS_REQUIRED' as const;
  readonly status = 404;
  constructor() {
    // 404, not 403: the existence of platform endpoints is not advertised to
    // company users.
    super('Not found.');
  }
}

/**
 * A platform admin reached a company-scoped route without naming a company.
 * Platform access is never implicit — there is no "admins see everything"
 * fallback that could quietly widen a query.
 */
export class PlatformAccessNotTargetedError extends DomainError {
  readonly code = 'PLATFORM_ACCESS_NOT_TARGETED' as const;
  readonly status = 400;
  constructor() {
    super(
      'Platform administrators must target a company explicitly on company-scoped ' +
        'routes (path parameter or X-Company-Id header). Platform access is never implicit.',
    );
  }
}

export class BranchOutOfScopeError extends DomainError {
  readonly code = 'BRANCH_OUT_OF_SCOPE' as const;
  readonly status = 404;
  constructor() {
    super('Not found.');
  }
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * The Prisma extension caught a query against a company-owned table with no
 * company_id in its filter. Row-level security would very likely have returned
 * nothing anyway, but silently returning nothing hides the bug — so this fails
 * loudly instead.
 */
export class UnscopedTenantQueryError extends DomainError {
  readonly code = 'UNSCOPED_TENANT_QUERY' as const;
  readonly status = 500;
  override readonly exposeMessage = false;
  constructor(model: string, operation: string) {
    super(
      `Refused an unscoped ${operation} on company-owned model "${model}": no companyId ` +
        'in the filter. Use a TenantScopedRepository, or pass companyId explicitly.',
    );
  }
}

export class CrossTenantReferenceError extends DomainError {
  readonly code = 'CROSS_TENANT_REFERENCE' as const;
  readonly status = 404;
  constructor(model: string, id: string) {
    // Surfaces as a plain 404: from the caller's side, another company's row
    // simply does not exist.
    super('Not found.', { model, id });
  }
}

export class ResourceNotFoundError extends DomainError {
  readonly code = 'RESOURCE_NOT_FOUND' as const;
  readonly status = 404;
  constructor(resource: string, id?: string) {
    super('Not found.', { resource, id });
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export class JobTenantMissingError extends DomainError {
  readonly code = 'JOB_TENANT_MISSING' as const;
  readonly status = 500;
  override readonly exposeMessage = false;
  constructor(jobName: string) {
    super(
      `Job "${jobName}" was enqueued without companyId. Tenant-scoped jobs must carry ` +
        'their own tenant in the payload — the originating HTTP request is long gone.',
    );
  }
}

export class JobTenantMismatchError extends DomainError {
  readonly code = 'JOB_TENANT_MISMATCH' as const;
  readonly status = 500;
  override readonly exposeMessage = false;
  constructor(jobName: string, expected: string, actual: string) {
    super(
      `Job "${jobName}" referenced an entity belonging to company ${actual} while running ` +
        `in the context of company ${expected}. Refusing to proceed.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

export class ValidationFailedError extends DomainError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 400;
  constructor(issues: unknown) {
    super('Request validation failed.', { issues: issues as Record<string, unknown> });
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT' as const;
  readonly status = 409;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

// ---------------------------------------------------------------------------
// Identity administration
// ---------------------------------------------------------------------------

/**
 * Refused because the actor tried to hand out more than they hold.
 *
 * Separate from PermissionDeniedError, which means "you may not do this".
 * This one means "you may do this, but not with these contents" — the actor
 * legitimately holds `member:invite` or `member:write`; what they cannot do is
 * use it to manufacture an owner. Distinct codes because the UI response
 * differs: one hides the control, the other explains which permissions to drop.
 */
export class PrivilegeEscalationError extends DomainError {
  readonly code = 'PRIVILEGE_ESCALATION_BLOCKED' as const;
  readonly status = 403;
  constructor(permissions: string[]) {
    super('You cannot grant permissions you do not hold yourself.', { permissions });
  }
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * Unknown, revoked and already-accepted all land here, deliberately.
 *
 * Whoever holds a token that does not work must not be able to tell WHY. If
 * "revoked" were distinguishable from "never existed", a stolen link would
 * confirm that an invitation for that address had once been issued — which
 * confirms the address, the company, and that someone thought they belonged
 * there. One answer for every dead token.
 */
export class InvitationNotFoundError extends DomainError {
  readonly code = 'INVITATION_NOT_FOUND' as const;
  readonly status = 404;
  constructor() {
    super('That invitation link is not valid.');
  }
}

/**
 * The one distinction worth drawing.
 *
 * Expiry is the only failure a legitimate recipient can act on — "ask for a
 * fresh link" is useful advice, and unlike revocation it leaks nothing an
 * attacker could not learn by waiting.
 */
export class InvitationExpiredError extends DomainError {
  readonly code = 'INVITATION_EXPIRED' as const;
  readonly status = 410;
  constructor() {
    super('That invitation has expired. Ask for a new link.');
  }
}

/** An account already exists for this address; sign in before accepting. */
export class InvitationSignInRequiredError extends DomainError {
  readonly code = 'INVITATION_SIGN_IN_REQUIRED' as const;
  readonly status = 401;
  constructor() {
    super('An account already exists for this address. Sign in, then accept the invitation.');
  }
}

/**
 * The link already exists.
 *
 * Separate from ConflictError because the client's response differs: assigning
 * a branch that is already assigned is a no-op the UI can simply reflect,
 * whereas a generic conflict usually needs a human to resolve.
 */
export class AlreadyAssignedError extends DomainError {
  readonly code = 'ALREADY_ASSIGNED' as const;
  readonly status = 409;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

// ---------------------------------------------------------------------------
// One-time account links
// ---------------------------------------------------------------------------

/**
 * Unknown, already used, or presented for the wrong purpose.
 *
 * All three collapse into one answer. The wrong-purpose case is the one worth
 * spelling out: if a verification token could be told apart from a reset token,
 * somebody holding the weaker link would learn that the stronger one exists for
 * that account.
 */
export class AccountTokenInvalidError extends DomainError {
  readonly code = 'ACCOUNT_TOKEN_INVALID' as const;
  readonly status = 400;
  constructor() {
    super('That link is not valid. It may have been used already.');
  }
}

/** Distinguished from invalid because it is the one the user can act on. */
export class AccountTokenExpiredError extends DomainError {
  readonly code = 'ACCOUNT_TOKEN_EXPIRED' as const;
  readonly status = 410;
  constructor() {
    super('That link has expired. Request a new one.');
  }
}

/** Signed in, but as somebody else. */
export class InvitationEmailMismatchError extends DomainError {
  readonly code = 'INVITATION_EMAIL_MISMATCH' as const;
  readonly status = 403;
  constructor() {
    super('This invitation was sent to a different address than the one you are signed in as.');
  }
}
