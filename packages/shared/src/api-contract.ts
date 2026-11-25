/**
 * The wire contract between `apps/api` and `apps/web`.
 *
 * ---------------------------------------------------------------------------
 * WHAT BELONGS HERE
 * ---------------------------------------------------------------------------
 *
 * Only things BOTH sides must agree on to talk to each other: the response
 * envelope, the error code vocabulary, and the header names. Nothing else.
 *
 * The backend remains the source of truth for business rules. Permission
 * evaluation, tenant resolution, pricing — none of that moves here, because a
 * rule that lives in a package both sides import is a rule the frontend can be
 * tempted to enforce, and the frontend is not a security boundary.
 *
 * The test for adding something: "would the API and the web app disagree, at
 * runtime, if this drifted?" Error codes pass that test — the web app switches
 * on them. Role definitions do not.
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Every successful API response. */
export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiMeta {
  /** Echoed in the `X-Request-Id` header. Quote it in a support ticket. */
  requestId?: string;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Every failed API response.
 *
 * Deliberately NOT wrapped in `data` — an exception can be thrown before the
 * envelope interceptor runs, so the filter owns this shape independently.
 */
export interface ApiErrorBody {
  error: {
    /**
     * A known code, or any string.
     *
     * `string & {}` rather than a bare `string`: the union would otherwise
     * collapse to `string` and the editor would stop suggesting the known
     * codes. Widening at all is deliberate — a gateway or a proxy in front of
     * the API can return a body this client never defined, and the type should
     * not pretend otherwise.
     */
    code: ApiErrorCode | (string & {});
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiEnvelope<T> | ApiErrorBody;

export function isApiError(body: unknown): body is ApiErrorBody {
  return typeof body === 'object' && body !== null && 'error' in body;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * The complete error vocabulary.
 *
 * Shared because the web app branches on these: `TENANT_UNRESOLVED` opens the
 * company picker, `SESSION_REVOKED` forces a sign-out, `TENANT_READ_ONLY`
 * shows an upgrade prompt. A string literal typo on either side would be a
 * silent behavioural bug, which is exactly what a shared union prevents.
 *
 * `apps/api` derives its own `ErrorCode` from this, so the two cannot drift.
 */
export const API_ERROR_CODES = [
  // authentication
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'MFA_REQUIRED',
  'MFA_ENROLLMENT_REQUIRED',
  'TOKEN_EXPIRED',
  'TOKEN_AUDIENCE_MISMATCH',
  'SESSION_REVOKED',
  'REFRESH_TOKEN_REUSED',
  // tenancy
  'TENANT_CONTEXT_MISSING',
  'TENANT_UNRESOLVED',
  'TENANT_AMBIGUOUS',
  'TENANT_NOT_FOUND',
  'TENANT_SUSPENDED',
  'TENANT_READ_ONLY',
  'MEMBERSHIP_INACTIVE',
  // authorization
  'PERMISSION_DENIED',
  'PLATFORM_ACCESS_REQUIRED',
  'PLATFORM_ACCESS_NOT_TARGETED',
  'BRANCH_OUT_OF_SCOPE',
  // data access
  'UNSCOPED_TENANT_QUERY',
  'CROSS_TENANT_REFERENCE',
  'RESOURCE_NOT_FOUND',
  // availability
  //
  // The service exists but its configuration forbids booking it at all —
  // DRAFT, INACTIVE or ARCHIVED status. Distinct from a date-specific empty
  // result (branch closed, nobody rostered), which is a 200 with a reason.
  'SERVICE_NOT_BOOKABLE',
  // appointments
  //
  // SLOT_UNAVAILABLE: the time was never on offer (or no longer is) — refresh
  // availability. SLOT_TAKEN: it was on offer and another booking won the race
  // at the database constraint — also refresh, but the user did nothing wrong.
  'SLOT_UNAVAILABLE',
  'SLOT_TAKEN',
  'INVALID_STATUS_TRANSITION',
  // advanced booking
  /** A cancellation or rescheduling rule refuses it. `details.rule` says which. */
  'BOOKING_RULE_VIOLATION',
  /** One or more occurrences of a recurring series cannot be booked. `details.occurrences`. */
  'SERIES_CONFLICT',
  /** Approved time off would overlap existing appointments. `details.appointments`. */
  'TIME_OFF_CONFLICT',
  // public booking — one deliberately vague refusal for an anonymous caller
  'ONLINE_BOOKING_UNAVAILABLE',
  // promotions — `details.reason` says why (INVALID_CODE, ENDED, LIMIT_REACHED…)
  'PROMOTION_NOT_APPLICABLE',
  'GIFT_CARD_NOT_USABLE',
  'PLAN_LIMIT_EXCEEDED',
  'FEATURE_NOT_AVAILABLE',
  // invitations
  //
  // Unknown, revoked and already-accepted deliberately share one code. A
  // stolen token must not be able to distinguish "never existed" from
  // "existed and was withdrawn".
  'INVITATION_NOT_FOUND',
  /** The one distinction worth making: the UI can say "ask for a fresh link". */
  'INVITATION_EXPIRED',
  /** An account already exists for this address — render sign-in, not set-password. */
  'INVITATION_SIGN_IN_REQUIRED',
  /** You are signed in as someone else. */
  'INVITATION_EMAIL_MISMATCH',
  // one-time account links (email verification, password reset)
  //
  // Distinct from TOKEN_EXPIRED above, which is about an access token. These
  // are about a link somebody clicked, and the client's response is different:
  // one triggers a silent refresh, the other asks for a new link.
  'ACCOUNT_TOKEN_INVALID',
  'ACCOUNT_TOKEN_EXPIRED',
  // assignment
  //
  // A distinct code from CONFLICT because the client's response differs: an
  // already-assigned branch is a no-op the UI can simply reflect, while a
  // generic conflict usually needs a human.
  'ALREADY_ASSIGNED',
  // identity administration
  /** `details.permissions` lists the keys the actor lacks. */
  'PRIVILEGE_ESCALATION_BLOCKED',
  'LAST_OWNER',
  'SELF_MODIFICATION_BLOCKED',
  /** `details.assignedCount` — refuse rather than silently unassign people. */
  'ROLE_IN_USE',
  'SYSTEM_ROLE_IMMUTABLE',
  // jobs
  'JOB_TENANT_MISSING',
  'JOB_TENANT_MISMATCH',
  // customer portal
  /** Wrong, expired or used-up sign-in code. One message for all three. */
  'SIGN_IN_CODE_INVALID',
  /**
   * The business's rules do not allow this customer action (cancel or
   * reschedule). `details.reason` says which rule; `details.deadline` when a
   * deadline passed.
   */
  'CUSTOMER_ACTION_NOT_ALLOWED',
  // online payments
  /** No payment provider is configured, or it cannot take this currency. */
  'PAYMENTS_UNAVAILABLE',
  // notifications
  /** Company provider settings need SECRETS_ENCRYPTION_KEY on the server. */
  'NOTIFICATION_PROVIDERS_UNAVAILABLE',
  // calendar integration
  /** The provider has no OAuth credentials on this server, or no encryption key. */
  'CALENDAR_PROVIDER_UNAVAILABLE',
  /** The OAuth state is unknown, expired, used, or belongs to someone else. */
  'CALENDAR_OAUTH_INVALID',
  /** The calendar provider refused or failed the call. */
  'CALENDAR_PROVIDER_ERROR',
  // files and media
  /** Over the configured size limit. */
  'FILE_TOO_LARGE',
  /** Not one of the accepted types (judged by content, not by name or claimed type). */
  'FILE_TYPE_NOT_ALLOWED',
  /** Claims to be an allowed type but is not a valid one, or its dimensions are out of range. */
  'FILE_INVALID',
  /** The storage backend failed. Nothing was saved. */
  'STORAGE_UNAVAILABLE',
  /** The provider refused or failed the call. No provider detail is exposed. */
  'PAYMENT_PROVIDER_ERROR',
  /** A webhook whose signature did not verify. */
  'WEBHOOK_SIGNATURE_INVALID',
  // generic
  'VALIDATION_FAILED',
  'CONFLICT',
  'INTERNAL_ERROR',
  'HTTP_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Codes that mean "your session is over" — the client should sign out. */
export const SESSION_ENDING_ERROR_CODES: readonly ApiErrorCode[] = [
  'SESSION_REVOKED',
  'REFRESH_TOKEN_REUSED',
  'TOKEN_AUDIENCE_MISMATCH',
];

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Header names both sides use. Constants rather than literals because a typo
 * in `X-Company-Id` on the client produces no error — the request simply falls
 * back to the token's active company, which is a very confusing bug to chase.
 */
export const API_HEADERS = {
  /** Bearer access token. */
  AUTHORIZATION: 'Authorization',
  /** Explicitly target a company. Validated against membership; 404 if not a member. */
  COMPANY_ID: 'X-Company-Id',
  COMPANY_SLUG: 'X-Company-Slug',
  /** Correlation id. Echoed back on every response. */
  REQUEST_ID: 'X-Request-Id',
  /** Makes an unsafe request safe to retry. */
  IDEMPOTENCY_KEY: 'Idempotency-Key',
} as const;

// ---------------------------------------------------------------------------
// Shared request shapes
// ---------------------------------------------------------------------------

export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
