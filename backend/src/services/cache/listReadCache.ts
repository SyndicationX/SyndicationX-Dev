import { createTtlCache } from "../../common/ttlCache.js";

/** Keep list payloads fresh enough for navigation without serving stale CRM/deals. */
export const LIST_READ_CACHE_TTL_MS = 20_000;

export const contactDirectoryCache = createTtlCache<unknown>(LIST_READ_CACHE_TTL_MS);
export const dealsListCache = createTtlCache<unknown>(LIST_READ_CACHE_TTL_MS);
export const visibleDealIdsCache = createTtlCache<string[]>(LIST_READ_CACHE_TTL_MS);

export function invalidateContactDirectoryCache(): void {
  contactDirectoryCache.invalidateAll();
}

export function invalidateDealsListCache(): void {
  dealsListCache.invalidateAll();
  visibleDealIdsCache.invalidateAll();
}
