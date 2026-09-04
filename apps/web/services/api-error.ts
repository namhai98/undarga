import {
  isApiError,
  SESSION_ENDING_ERROR_CODES,
  type ApiErrorBody,
  type ApiErrorCode,
} from '@undarga/shared';

/**
 * A failed API call, as an Error subclass.
 *
 * The `code` comes from `@undarga/shared`, so `error.code === 'TENANT_UNRESOLVED'`
 * is checked against a union the backend also compiles against — a typo on
 * either side is a build failure rather than a branch that silently never runs.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode | (string & {});
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(init: {
    code: ApiErrorCode | (string & {});
    message: string;
    status: number;
    details?: Record<string, unknown>;
    requestId?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
  }

  /** The session is over; the client should clear tokens and sign out. */
  get isSessionEnding(): boolean {
    return (
      this.status === 401 && SESSION_ENDING_ERROR_CODES.includes(this.code as ApiErrorCode)
    );
  }

  /** No company could be determined — the UI should show the company picker. */
  get needsCompanySelection(): boolean {
    return this.code === 'TENANT_UNRESOLVED';
  }

  /**
   * The company is in a billing grace period and is read-only.
   * Surfaces as 402 rather than 403, so the UI can offer an upgrade instead of
   * a dead end.
   */
  get isBillingBlocked(): boolean {
    return this.status === 402;
  }

  static fromResponse(status: number, body: unknown): ApiError {
    if (isApiError(body)) {
      const { error } = body as ApiErrorBody;
      return new ApiError({
        code: error.code,
        message: error.message,
        status,
        details: error.details,
        requestId: error.requestId,
      });
    }

    // A non-JSON body, or a proxy/gateway error that never reached the API.
    return new ApiError({
      code: 'HTTP_ERROR',
      message: `Request failed with status ${status}.`,
      status,
    });
  }
}

/** The request was aborted — by a caller's signal, or by the timeout. */
export class ApiAbortError extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled') {
    super(reason === 'timeout' ? 'The request timed out.' : 'The request was cancelled.');
    this.name = 'ApiAbortError';
  }
}

/** The request never got a response: offline, DNS failure, connection refused. */
export class ApiNetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server.');
    this.name = 'ApiNetworkError';
    this.cause = cause;
  }
}
