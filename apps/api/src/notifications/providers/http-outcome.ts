import type { DeliveryResult } from './notification-provider';

/** How long a provider call may take before its outcome is UNKNOWN. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Classify a provider HTTP call that did not succeed.
 *
 *   timeout after sending     UNKNOWN — it may have been sent; no auto-retry
 *   network error             FAILED, retryable — the request never arrived
 *   429 / 5xx                 FAILED, retryable — a temporary outage
 *   other 4xx                 FAILED, permanent — bad address, bad credentials
 *
 * The provider's error text is passed through only as a short reason for the
 * history screen; it is never logged with the recipient or credentials.
 */
export function failedResult(provider: string, status: number, reason: string): DeliveryResult {
  const temporary = status === 429 || status >= 500;
  return {
    status: 'FAILED',
    provider,
    failureReason: `${provider} answered ${status}: ${reason}`.slice(0, 500),
    retryable: temporary,
  };
}

export function thrownResult(provider: string, error: unknown): DeliveryResult {
  const name = (error as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      status: 'UNKNOWN',
      provider,
      failureReason: `${provider} did not answer in time; the message may or may not have been sent.`,
    };
  }
  return {
    status: 'FAILED',
    provider,
    failureReason: `${provider} could not be reached.`,
    retryable: true,
  };
}
