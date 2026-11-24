import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAFF_REFRESH_LOCK, withCrossTabLock } from './cross-tab-lock';

/** A Web Locks stand-in: one holder per name, the rest queue — as across tabs. */
function fakeLocks() {
  const queues = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, fn: () => Promise<unknown>) => {
    const prev = queues.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    queues.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  });
  return { request };
}

function installLocks(locks: unknown) {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

describe('withCrossTabLock', () => {
  afterEach(() => {
    installLocks(undefined);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('runs two holders of one name one after the other', async () => {
    installLocks(fakeLocks());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withCrossTabLock('x', async () => {
      order.push('first:start');
      await new Promise<void>((r) => (releaseFirst = r));
      order.push('first:end');
    });
    const second = withCrossTabLock('x', async () => {
      order.push('second:start');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('still runs without the Web Locks API', async () => {
    installLocks(undefined);
    await expect(withCrossTabLock('x', async () => 42)).resolves.toBe(42);
  });

  it('the staff client refreshes under the shared lock', async () => {
    const locks = fakeLocks();
    installLocks(locks);
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).endsWith('/auth/refresh')
          ? new Response(JSON.stringify({ data: { accessToken: 'new', expiresIn: 900 } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify({ data: { ok: true } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { apiClient } = await import('./api-client');
    await apiClient.ensureSession();

    expect(locks.request).toHaveBeenCalledWith(STAFF_REFRESH_LOCK, expect.any(Function));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/auth/refresh'))).toBe(true);
  });
});
