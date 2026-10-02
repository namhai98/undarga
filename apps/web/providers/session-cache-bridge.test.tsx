import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { tokenStore } from '@/services/token-store';
import { SessionCacheBridge } from './session-cache-bridge';

/**
 * Regression: an anonymous visitor's bootstrap refresh 401s moments after the
 * public booking page starts loading, which clears the token store. The bridge
 * used to `queryClient.clear()` there, removing the page's in-flight queries and
 * leaving it on "Loading…" forever. Found in a real browser; component tests
 * inject a fixed session and never bootstrap, so they could not see it.
 */
describe('SessionCacheBridge', () => {
  afterEach(() => tokenStore.clear('signed-out'));

  function mount() {
    const client = new QueryClient();
    client.setQueryData(['public-booking', 'lotus', 'company'], { name: 'Lotus' });
    client.setQueryData(['appointments', 'co-1', 'list'], { items: [1] });
    render(
      <QueryClientProvider client={client}>
        <SessionCacheBridge>
          <div />
        </SessionCacheBridge>
      </QueryClientProvider>,
    );
    return client;
  }

  it('drops session-scoped data when the session ends, but keeps public booking data', () => {
    const client = mount();

    act(() => tokenStore.clear('signed-out'));

    expect(client.getQueryData(['appointments', 'co-1', 'list'])).toBeUndefined();
    expect(client.getQueryData(['public-booking', 'lotus', 'company'])).toEqual({ name: 'Lotus' });
  });

  it('keeps everything on a routine token rotation', () => {
    const client = mount();

    act(() =>
      tokenStore.set({ accessToken: 'a', expiresAt: Date.now() + 60_000 } as never, 'refreshed'),
    );

    expect(client.getQueryData(['appointments', 'co-1', 'list'])).toEqual({ items: [1] });
  });
});
