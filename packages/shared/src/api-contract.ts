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
