import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '@/services/token-store';
import { makeQueryClient } from '@/test/render';
import { useLogout } from './use-logout';
import { useSwitchCompany } from './use-switch-company';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

describe('session mutations', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let queryClient: ReturnType<typeof makeQueryClient>;

  beforeEach(() => {
    replace.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    queryClient = makeQueryClient();
    tokenStore.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  /** Stand in for a previous tenant's data sitting in the cache. */
  function seedCache() {
    queryClient.setQueryData(['members', 'company-a'], [{ id: 'm1' }]);
    expect(queryClient.getQueryData(['members', 'company-a'])).toBeDefined();
  }

  describe('logout', () => {
    it('clears the token, the cache and the route', async () => {
      tokenStore.set({ accessToken: 'tok', expiresIn: 900, activeCompanyId: 'c1' });
      seedCache();
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      const { result } = renderHook(() => useLogout(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync();
      });

      expect(tokenStore.isAuthenticated).toBe(false);
      // The cache holds one company's members and customers. Leaving it means
      // the next person to sign in on this machine sees the previous tenant's
      // data rendered from memory.
      expect(queryClient.getQueryData(['members', 'company-a'])).toBeUndefined();
      expect(replace).toHaveBeenCalledWith('/login');
    });

    it('signs out locally even when the server call fails', async () => {
      // Asymmetric risk: ending a session that is already dead costs nothing,
      // while leaving one alive on a shared machine is the actual harm.
      tokenStore.set({ accessToken: 'tok', expiresIn: 900 });
      seedCache();
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const { result } = renderHook(() => useLogout(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync().catch(() => undefined);
      });

      await waitFor(() => expect(tokenStore.isAuthenticated).toBe(false));
      expect(queryClient.getQueryData(['members', 'company-a'])).toBeUndefined();
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });

  describe('switching company', () => {
    it('clears the cache rather than invalidating it', async () => {
      /**
       * `invalidateQueries` would keep the previous company's data and
       * re-render it while refetching — a visible cross-tenant flash under the
       * new company's name. The backend spends four layers of effort making
       * cross-tenant reads impossible; the client must not reintroduce one in
       * a cache.
       */
      tokenStore.set({ accessToken: 'old', expiresIn: 900, activeCompanyId: 'c1' });
      seedCache();

      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          envelope({
            accessToken: 'new',
            tokenType: 'Bearer',
            expiresIn: 900,
            activeCompanyId: 'c2',
            memberships: [],
          }),
        ),
      );

      const { result } = renderHook(() => useSwitchCompany(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ companyId: 'c2' });
      });

      expect(queryClient.getQueryData(['members', 'company-a'])).toBeUndefined();
      expect(tokenStore.activeCompanyId).toBe('c2');
      // A token is valid for exactly one company, so the new one must replace
      // the old rather than sit alongside it.
      expect(tokenStore.accessToken).toBe('new');
      expect(replace).toHaveBeenCalledWith('/dashboard');
    });

    it('leaves the session alone when the switch is refused', async () => {
      // 404 is what the API returns for a company you do not belong to — it
      // will not confirm that the company exists.
      tokenStore.set({ accessToken: 'old', expiresIn: 900, activeCompanyId: 'c1' });
      fetchMock.mockResolvedValue(
        jsonResponse(404, { error: { code: 'TENANT_NOT_FOUND', message: 'Not found.' } }),
      );

      const { result } = renderHook(() => useSwitchCompany(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ companyId: 'not-mine' }).catch(() => undefined);
      });

      expect(tokenStore.accessToken).toBe('old');
      expect(tokenStore.activeCompanyId).toBe('c1');
      expect(replace).not.toHaveBeenCalled();
    });
  });
});
