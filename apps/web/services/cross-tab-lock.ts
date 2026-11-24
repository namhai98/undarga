/**
 * Run `fn` while holding a lock that every tab of this origin shares.
 *
 * Refresh tokens rotate, and presenting an already-rotated one revokes the
 * whole session family. An in-tab single flight is not enough: two tabs whose
 * access tokens expire together would each send the same refresh cookie, and
 * the server must treat the second as a stolen token, signing the user out
 * everywhere. Under the lock the second tab's request starts only after the
 * first one's response has replaced the cookie, so it rotates the new one.
 *
 * Browsers without the Web Locks API fall back to the caller's in-tab single
 * flight.
 */
export async function withCrossTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(name, fn) as Promise<T>;
}

export const STAFF_REFRESH_LOCK = 'undarga:staff-refresh';
export const customerRefreshLock = (slug: string) => `undarga:customer-refresh:${slug}`;
