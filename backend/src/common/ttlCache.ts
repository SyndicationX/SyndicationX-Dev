type CacheEntry<T> = { expiresAt: number; value: T };

/**
 * Process-local TTL map for expensive list reads. Not shared across instances;
 * use a short TTL and invalidate on writes.
 */
export function createTtlCache<T>(defaultTtlMs: number) {
  const map = new Map<string, CacheEntry<T>>();

  function pruneExpired(now: number): void {
    for (const [key, entry] of map) {
      if (entry.expiresAt <= now) map.delete(key);
    }
  }

  function get(key: string): T | undefined {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: T, ttlMs = defaultTtlMs): void {
    const now = Date.now();
    if (map.size > 500) pruneExpired(now);
    map.set(key, { value, expiresAt: now + Math.max(1, ttlMs) });
  }

  function invalidateAll(): void {
    map.clear();
  }

  return { get, set, invalidateAll };
}
