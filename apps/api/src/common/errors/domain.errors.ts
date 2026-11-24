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
  constructor(reason: 'SUBSCRIPTION_EXPIRED' | 'COMPANY_INACTIVE' | null = null) {
    // 402 rather than 403: this is a billing state, not a permission problem,
    // and the client should surface an upgrade path rather than "access denied".
    super(
      reason === 'SUBSCRIPTION_EXPIRED'
        ? 'This company’s subscription has expired. Its data is kept and can be read; ' +
            'reactivate or choose a plan to make changes again.'
        : 'This company is in a read-only grace period. Settle the outstanding invoice to resume changes.',
      reason ? { reason } : undefined,
    );
  }
}

/**
 * The company's plan does not allow one more of something. 403 with the
 * numbers, so the screen can say "5 of 5 employees — upgrade to add more"
 * rather than a bare refusal. Nothing was created.
 */
export class PlanLimitExceededError extends DomainError {
  readonly code = 'PLAN_LIMIT_EXCEEDED' as const;
  readonly status = 403;
  constructor(details: {
    limit: string;
    max: number;
    current: number;
    planKey: string | null;
    violations?: Array<{ limit: string; max: number; current: number }>;
  }) {
    super(
      details.violations
        ? 'Current usage is above what that plan allows. Reduce it, or choose a larger plan.'
        : `This plan allows ${details.max} — ${details.current} already in use. Upgrade to add more.`,
      details,
    );
  }
}

/** The company's plan does not include a feature. */
export class FeatureNotAvailableError extends DomainError {
  readonly code = 'FEATURE_NOT_AVAILABLE' as const;
  readonly status = 403;
  constructor(feature: string, planKey: string | null) {
    super('Your plan does not include this feature. Upgrade to use it.', { feature, planKey });
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
// Availability
// ---------------------------------------------------------------------------

/**
 * The service exists and belongs to this company, but its status forbids
 * booking it at all (DRAFT, INACTIVE, ARCHIVED).
 *
 * A hard 409 rather than an empty slot list: an empty list means "nothing free
 * on that date", and a caller retrying tomorrow would be reasonable. A service
 * that is not bookable is a different thing entirely, and the client should say
 * so rather than invite a pointless retry. A branch that is simply closed on
 * the requested date, or has nobody rostered, still returns 200 with an
 * `unavailableReason`.
 */
export class ServiceNotBookableError extends DomainError {
  readonly code = 'SERVICE_NOT_BOOKABLE' as const;
  readonly status = 409;
  constructor(status: string) {
    super('This service cannot be booked.', { serviceStatus: status });
  }
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * The requested start time is not one the availability engine currently offers
 * for that branch, service, employee and resource — outside hours, rostered
 * off, already booked, too soon, or simply not on the slot grid.
 *
 * `details.reason` carries the engine's structural reason when there is one, so
 * the client can say "the branch is closed that day" rather than a generic
 * "pick another time".
 */
export class SlotUnavailableError extends DomainError {
  readonly code = 'SLOT_UNAVAILABLE' as const;
  readonly status = 409;
  constructor(details: { reason: string; startsAt: string; [key: string]: unknown }) {
    super(SLOT_UNAVAILABLE_MESSAGES[details.reason] ?? 'That time is no longer available. Choose another slot.', details);
  }
}

/** Why a time cannot be booked, in words a front desk can repeat to a customer. */
const SLOT_UNAVAILABLE_MESSAGES: Record<string, string> = {
  MINIMUM_NOTICE: 'That time is too soon: bookings need more notice. Choose a later time.',
  BEYOND_BOOKING_WINDOW: 'That date is too far ahead to book yet.',
  DATE_IN_PAST: 'That time has already passed.',
  EMPLOYEE_TIME_OFF: 'The chosen staff member is away at that time.',
  EMPLOYEE_NOT_AVAILABLE: 'The chosen staff member is not available at that time.',
  RESOURCE_UNAVAILABLE: 'The room or equipment this service needs is unavailable at that time.',
  RESOURCE_NOT_AVAILABLE: 'The chosen room or equipment is not available at that time.',
  MAX_CONCURRENT_BOOKINGS: 'That time is fully booked for this service.',
  BRANCH_CLOSED: 'The branch is closed at that time.',
  NO_ELIGIBLE_EMPLOYEE: 'Nobody who performs this service is available at that time.',
};

/** A cancellation or rescheduling rule refuses the change. */
export class BookingRuleViolationError extends DomainError {
  readonly code = 'BOOKING_RULE_VIOLATION' as const;
  readonly status = 422;
  constructor(
    rule: 'CANCELLATION_DEADLINE' | 'RESCHEDULE_DEADLINE' | 'RESCHEDULING_DISABLED',
    details: Record<string, unknown> = {},
  ) {
    super(
      rule === 'RESCHEDULING_DISABLED'
        ? 'This business does not allow appointments to be rescheduled. Cancel and book again instead.'
        : rule === 'CANCELLATION_DEADLINE'
          ? 'The cancellation deadline for this appointment has passed. Confirm it as a late cancellation to go ahead.'
          : 'The rescheduling deadline for this appointment has passed. Confirm it as a late change to go ahead.',
      { rule, ...details },
    );
  }
}

/** Some occurrences of a recurring series cannot be booked; nothing was created. */
export class SeriesConflictError extends DomainError {
  readonly code = 'SERIES_CONFLICT' as const;
  readonly status = 409;
  constructor(occurrences: unknown[]) {
    super('Some dates in this series cannot be booked. Nothing was created.', { occurrences });
  }
}

/** Approved time off would overlap appointments that are already booked. */
export class TimeOffConflictError extends DomainError {
  readonly code = 'TIME_OFF_CONFLICT' as const;
  readonly status = 409;
  constructor(appointments: unknown[]) {
    super(
      'This time off overlaps booked appointments. Move or cancel them first, or confirm to record it anyway.',
      { appointments },
    );
  }
}

/**
 * The database exclusion constraint refused the write: another booking for the
 * same employee or resource committed an overlapping reservation between our
 * availability check and our insert.
 *
 * Distinct from SLOT_UNAVAILABLE because the client did nothing wrong — it read
 * a slot that was genuinely free and lost a race. The right response is to
 * refresh availability and try again.
 */
export class SlotTakenError extends DomainError {
  readonly code = 'SLOT_TAKEN' as const;
  readonly status = 409;
  constructor(conflict: 'employee' | 'resource' | 'unknown') {
    super('Someone just booked that slot. Refresh availability and choose another time.', {
      conflict,
    });
  }
}

/**
 * The public booking page cannot take this booking — today, because the
 * customer record matching the contact details is blocked.
 *
 * Deliberately one vague answer for all of them. The caller is anonymous, and
 * "your account is blocked" is not something to
 * tell whoever happens to type a phone number into a form.
 */
export class OnlineBookingUnavailableError extends DomainError {
  readonly code = 'ONLINE_BOOKING_UNAVAILABLE' as const;
  readonly status = 409;
  constructor() {
    super('This booking cannot be made online. Please contact the business directly.');
  }
}

/**
 * A promotion code was offered with a booking and cannot be honoured — unknown,
 * expired, paused, used up, or not valid for this service, branch, staff member
 * or customer.
 *
 * The booking is refused rather than silently taken at full price: the customer
 * was shown a discounted total, and charging something else is worse than
 * asking them to retry. `details.reason` is the eligibility code
 * (`INVALID_CODE`, `ENDED`, `LIMIT_REACHED`, `WRONG_BRANCH`, …).
 */
export class PromotionNotApplicableError extends DomainError {
  readonly code = 'PROMOTION_NOT_APPLICABLE' as const;
  readonly status = 400;
  constructor(problem: { code: string; message: string }) {
    super(problem.message, { reason: problem.code });
  }
}

/**
 * A gift card that cannot be spent (or credited) as asked.
 *
 * 400 rather than 409: the request, not the server's state, is what has to
 * change — another card, a smaller amount. `details.reason` is a stable code
 * (`DISABLED`, `EXPIRED`, `INSUFFICIENT_BALANCE`, …) for clients; the
 * message is one sentence safe to show at the till.
 */
export class GiftCardNotUsableError extends DomainError {
  readonly code = 'GIFT_CARD_NOT_USABLE' as const;
  readonly status = 400;
  constructor(problem: { code: string; message: string }) {
    super(problem.message, { reason: problem.code });
  }
}

export class InvalidStatusTransitionError extends DomainError {
  readonly code = 'INVALID_STATUS_TRANSITION' as const;
  readonly status = 409;
  constructor(from: string, to: string) {
    super(`An appointment cannot move from ${from} to ${to}.`, { from, to });
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
// Customer portal
// ---------------------------------------------------------------------------

export class SignInCodeInvalidError extends DomainError {
  readonly code = 'SIGN_IN_CODE_INVALID' as const;
  readonly status = 401;
  constructor() {
    // Wrong, expired and exhausted are deliberately indistinguishable.
    super('That code is not valid. Request a new one.');
  }
}

export type CustomerActionRefusal =
  | 'NOT_ALLOWED_BY_BUSINESS'
  | 'PAST_DEADLINE'
  | 'STATUS'
  | 'PAYMENT_IN_PROGRESS'
  | 'ALREADY_PAID';

export class CustomerActionNotAllowedError extends DomainError {
  readonly code = 'CUSTOMER_ACTION_NOT_ALLOWED' as const;
  readonly status = 409;
  constructor(
    action: 'cancel' | 'reschedule',
    reason: CustomerActionRefusal,
    message: string,
    deadline?: Date | null,
  ) {
    super(message, { action, reason, ...(deadline ? { deadline: deadline.toISOString() } : {}) });
  }
}

// ---------------------------------------------------------------------------
// Online payments
// ---------------------------------------------------------------------------

/** No gateway is configured, or the configured one cannot take this payment. */
export class PaymentsUnavailableError extends DomainError {
  readonly code = 'PAYMENTS_UNAVAILABLE' as const;
  readonly status = 503;
  constructor(message = 'Online payments are not available.') {
    super(message);
  }
}

/**
 * The provider refused or failed a call. The message is ours, never the
 * provider's: gateway error bodies can echo account identifiers and are logged
 * (without secrets) instead of being returned.
 */
export class PaymentProviderError extends DomainError {
  readonly code = 'PAYMENT_PROVIDER_ERROR' as const;
  readonly status = 502;
  constructor(message = 'The payment provider could not complete the request. Try again.') {
    super(message);
  }
}

export class WebhookSignatureInvalidError extends DomainError {
  readonly code = 'WEBHOOK_SIGNATURE_INVALID' as const;
  readonly status = 401;
  constructor() {
    super('Webhook signature could not be verified.');
  }
}

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

/** Company provider settings need SECRETS_ENCRYPTION_KEY, which is not set. */
export class NotificationProvidersUnavailableError extends DomainError {
  readonly code = 'NOTIFICATION_PROVIDERS_UNAVAILABLE' as const;
  readonly status = 503;
  constructor(message = 'Company notification providers are not available on this server.') {
    super(message);
  }
}

export class CalendarProviderUnavailableError extends DomainError {
  readonly code = 'CALENDAR_PROVIDER_UNAVAILABLE' as const;
  readonly status = 503;
  constructor(message = 'That calendar provider is not available on this server.') {
    super(message);
  }
}

/** One message for every bad state, so a probe learns nothing about which check failed. */
export class CalendarOAuthInvalidError extends DomainError {
  readonly code = 'CALENDAR_OAUTH_INVALID' as const;
  readonly status = 400;
  constructor() {
    super('This calendar authorisation link is invalid or has expired. Start again.');
  }
}

export class CalendarProviderFailedError extends DomainError {
  readonly code = 'CALENDAR_PROVIDER_ERROR' as const;
  readonly status = 502;
  constructor(message = 'The calendar provider could not complete the request. Try again.') {
    super(message);
  }
}

export class FileTooLargeError extends DomainError {
  readonly code = 'FILE_TOO_LARGE' as const;
  readonly status = 413;
  constructor(maxBytes: number) {
    super(`The file is larger than ${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MB.`, { maxBytes });
  }
}

export class FileTypeNotAllowedError extends DomainError {
  readonly code = 'FILE_TYPE_NOT_ALLOWED' as const;
  readonly status = 415;
  constructor(allowed: readonly string[]) {
    super('That kind of file is not accepted. Use a JPEG, PNG or WebP image.', { allowed: [...allowed] });
  }
}

export class FileInvalidError extends DomainError {
  readonly code = 'FILE_INVALID' as const;
  readonly status = 422;
  constructor(message = 'The file is not a valid image.', details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class StorageUnavailableError extends DomainError {
  readonly code = 'STORAGE_UNAVAILABLE' as const;
  readonly status = 503;
  constructor() {
    super('File storage is unavailable. Nothing was saved; try again.');
  }
}

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
