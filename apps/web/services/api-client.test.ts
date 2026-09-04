import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAbortError, ApiError, ApiNetworkError } from './api-error';
import { tokenStore } from './token-store';

/**
 * API client behaviour.
 *
 * The client is a module singleton bound to `clientEnv.apiUrl` at import time,
 * so `fetch` is stubbed rather than the module re-instantiated.
 */
const BASE = 'http://localhost:3000/api/v1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = <T,>(data: T) => ({ data, meta: { requestId: 'req-1' } });

describe('apiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  async function client() {
    return (await import('./api-client')).apiClient;
  }

  describe('envelope', () => {
    it('unwraps { data } so callers receive the payload', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, envelope({ status: 'ok' })));

      const api = await client();
      await expect(api.get<{ status: string }>('/health')).resolves.toEqual({ status: 'ok' });
    });

    it('returns undefined for 204', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      const api = await client();
      await expect(api.post('/auth/logout')).resolves.toBeUndefined();
    });
  });

  describe('authentication', () => {
    it('omits Authorization when there is no session', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, envelope({})));

      await (await client()).get('/health');

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('attaches the bearer token when signed in', async () => {
      tokenStore.set({ accessToken: 'tok-123', refreshToken: 'r', expiresIn: 900 });
      fetchMock.mockResolvedValue(jsonResponse(200, envelope({})));

      await (await client()).get('/auth/me');

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok-123');
    });

    it('omits the token when the caller asks for an anonymous request', async () => {
      tokenStore.set({ accessToken: 'tok-123', refreshToken: 'r', expiresIn: 900 });
      fetchMock.mockResolvedValue(jsonResponse(200, envelope({})));

      await (await client()).get('/health', { anonymous: true });

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('cannot have Authorization overridden by a caller header', async () => {
      tokenStore.set({ accessToken: 'real', refreshToken: 'r', expiresIn: 900 });
      fetchMock.mockResolvedValue(jsonResponse(200, envelope({})));

      await (await client()).get('/auth/me', { headers: { Authorization: 'Bearer forged' } });

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer real');
    });
  });

  describe('token refresh', () => {
    it('refreshes once on 401 and replays the original request', async () => {
      tokenStore.set({ accessToken: 'old', refreshToken: 'r-old', expiresIn: 900 });

      fetchMock
        .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }))
        .mockResolvedValueOnce(
          jsonResponse(200, envelope({ accessToken: 'new', refreshToken: 'r-new', expiresIn: 900 })),
        )
        .mockResolvedValueOnce(jsonResponse(200, envelope({ id: 'me' })));

      const api = await client();
      await expect(api.get<{ id: string }>('/auth/me')).resolves.toEqual({ id: 'me' });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/auth/refresh`);
      // The replay carries the NEW token, not the one that just failed.
      const replayHeaders = fetchMock.mock.calls[2]![1].headers as Record<string, string>;
      expect(replayHeaders.Authorization).toBe('Bearer new');
    });

    it('single-flights concurrent refreshes', async () => {
      // The property this protects: refresh tokens ROTATE. Two parallel
      // refreshes mean the second presents an already-rotated token, which the
      // API treats as theft and kills the whole session family. The symptom is
      // "users randomly logged out".
      tokenStore.set({ accessToken: 'old', refreshToken: 'r-old', expiresIn: 900 });

      fetchMock.mockImplementation((url: string) => {
        if (String(url).endsWith('/auth/refresh')) {
          return Promise.resolve(
            jsonResponse(200, envelope({ accessToken: 'new', refreshToken: 'r-new', expiresIn: 900 })),
          );
        }
        const auth = 'Bearer new';
        const called = fetchMock.mock.calls.at(-1)?.[1]?.headers?.Authorization;
        return Promise.resolve(
          called === auth
            ? jsonResponse(200, envelope({ ok: true }))
            : jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
        );
      });

      const api = await client();
      await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);

      const refreshCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).endsWith('/auth/refresh'),
      );
      expect(refreshCalls).toHaveLength(1);
    });

    it('clears the session when refresh is rejected', async () => {
      tokenStore.set({ accessToken: 'old', refreshToken: 'r-old', expiresIn: 900 });

      fetchMock
        .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }))
        .mockResolvedValueOnce(
          jsonResponse(401, { error: { code: 'REFRESH_TOKEN_REUSED', message: 'x' } }),
        );

      const api = await client();
      await expect(api.get('/auth/me')).rejects.toBeInstanceOf(ApiError);
      expect(tokenStore.isAuthenticated).toBe(false);
    });

    it('does not loop when the refreshed token is also rejected', async () => {
      tokenStore.set({ accessToken: 'old', refreshToken: 'r-old', expiresIn: 900 });

      fetchMock
        .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }))
        .mockResolvedValueOnce(
          jsonResponse(200, envelope({ accessToken: 'new', refreshToken: 'r-new', expiresIn: 900 })),
        )
        .mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));

      const api = await client();
      await expect(api.get('/auth/me')).rejects.toBeInstanceOf(ApiError);
      // original + refresh + one replay, then stop
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('errors', () => {
    it('throws a typed ApiError carrying the shared error code', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, {
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Not found.', requestId: 'req-9' },
        }),
      );

      const api = await client();
      const error = await api.get('/probe/1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND');
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).requestId).toBe('req-9');
    });

    it('flags a tenant-unresolved error so the UI can prompt for a company', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, { error: { code: 'TENANT_UNRESOLVED', message: 'x' } }),
      );

      const api = await client();
      const error = (await api.get('/appointments').catch((e: unknown) => e)) as ApiError;

      expect(error.needsCompanySelection).toBe(true);
    });

    it('reports an unreachable server distinctly from an API error', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const api = await client();
      await expect(api.post('/auth/login', {})).rejects.toBeInstanceOf(ApiNetworkError);
    });
  });

  describe('retries', () => {
    it('retries an idempotent GET on 500', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } }))
        .mockResolvedValueOnce(jsonResponse(200, envelope({ ok: true })));

      const api = await client();
      await expect(api.get('/health')).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never retries a POST', async () => {
      // Retrying "create appointment" after a timeout is how you double-book.
      fetchMock.mockResolvedValue(
        jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } }),
      );

      const api = await client();
      await expect(api.post('/appointments', {})).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 4xx', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, { error: { code: 'VALIDATION_FAILED', message: 'x' } }),
      );

      const api = await client();
      await expect(api.get('/health')).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancellation', () => {
    it('surfaces an aborted request as ApiAbortError', async () => {
      fetchMock.mockImplementation(() => {
        const error = new DOMException('aborted', 'AbortError');
        return Promise.reject(error);
      });

      const controller = new AbortController();
      controller.abort();

      const api = await client();
      await expect(api.get('/health', { signal: controller.signal })).rejects.toBeInstanceOf(
        ApiAbortError,
      );
    });
  });

  describe('request shaping', () => {
    it('serialises query parameters and drops undefined', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, envelope([])));

      await (await client()).get('/appointments', {
        query: { limit: 10, status: 'CONFIRMED', branchId: undefined },
      });

      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('status')).toBe('CONFIRMED');
      expect(url.searchParams.has('branchId')).toBe(false);
    });

    it('sends X-Company-Id when a company is targeted explicitly', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, envelope([])));

      await (await client()).get('/appointments', { companyId: 'company-b' });

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers['X-Company-Id']).toBe('company-b');
    });
  });
});
