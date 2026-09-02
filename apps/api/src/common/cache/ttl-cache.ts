/**
 * A small TTL + LRU cache.
 *
 * Deliberately in-process. The things cached here (company lookups, resolved
 * permission sets) are read on every request and change rarely, so a local
 * cache removes two queries per request without adding an infrastructure
 * dependency to the tenant boundary — if Redis is down, requests should still
 * be authorised correctly rather than failing open or failing entirely.
 *
 * The cost is staleness of up to TTL seconds across replicas: revoking a
 * membership takes effect within TENANT_CACHE_TTL_SECONDS (default 60) rather
 * than instantly. Anything needing immediate revocation must also invalidate,
 * which is what `delete()` and `deleteByPrefix()` are for. When a shared cache
 * becomes necessary, implement this same interface over Redis — nothing else
 * has to change.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;

    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh recency for the LRU eviction below.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value);
    return value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Used to drop everything for one company when its roles change. */
  deleteByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
