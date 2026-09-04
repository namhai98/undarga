import { apiClient } from './api-client';

export interface LivenessResult {
  status: string;
  uptimeSeconds: number;
}

export type DependencyState = 'up' | 'down' | 'not_configured';

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, { status: DependencyState; latencyMs?: number }>;
}

/**
 * Health endpoints.
 *
 * The one service that exists at foundation stage — it is what proves the
 * browser can actually reach the API, which is the last link in the chain that
 * nothing else verifies.
 *
 * `anonymous: true` because these routes are `@Public()`; sending a bearer
 * token would be pointless and would make the call fail once tokens expire.
 */
export const healthService = {
  liveness: (signal?: AbortSignal) =>
    apiClient.get<LivenessResult>('/health', { anonymous: true, signal, timeoutMs: 5_000 }),

  readiness: (signal?: AbortSignal) =>
    apiClient.get<ReadinessResult>('/health/ready', {
      anonymous: true,
      signal,
      timeoutMs: 5_000,
    }),
};
