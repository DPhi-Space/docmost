/**
 * Cache naming, bounds and eviction rules for the service worker.
 *
 * Everything here is pure so the policy can be unit tested without a service
 * worker environment; `sw.ts` supplies the `caches` plumbing.
 */

export const CACHE_PREFIX = "docmost-offline-";

/** Single entry holding the last HTML the server actually served us. */
export const SHELL_CACHE_KEY = "/__docmost-offline-shell__";

/** NetworkFirst timeout for navigations before falling back to the shell. */
export const NAVIGATION_TIMEOUT_MS = 3_000;

/** NetworkFirst timeout for `GET /api/files/*`. */
export const FILE_TIMEOUT_MS = 8_000;

export const MAX_ASSET_ENTRIES = 400;
export const MAX_LOCALE_ENTRIES = 32;
export const MAX_FILE_ENTRIES = 200;
export const FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Header stamped onto runtime-cached responses so age can be evaluated later. */
export const CACHED_AT_HEADER = "x-docmost-sw-cached-at";

export interface CacheNames {
  /** Build-scoped: replaced wholesale on every deploy. */
  precache: string;
  /** Survives deploys: the last server-rendered HTML. */
  shell: string;
  /** Survives deploys: content-hashed asset URLs are immutable. */
  assets: string;
  locales: string;
  files: string;
}

export function cacheNames(buildId: string): CacheNames {
  return {
    precache: `${CACHE_PREFIX}precache-${buildId}`,
    shell: `${CACHE_PREFIX}shell-v1`,
    assets: `${CACHE_PREFIX}assets-v1`,
    locales: `${CACHE_PREFIX}locales-v1`,
    files: `${CACHE_PREFIX}files-v1`,
  };
}

/**
 * Which existing caches this worker should drop on activate. Only caches this
 * feature owns (`CACHE_PREFIX`) are ever considered, so an unrelated cache put
 * there by something else in the app is left alone.
 */
export function cachesToDelete(existing: string[], keep: CacheNames): string[] {
  const keepSet = new Set<string>(Object.values(keep));
  return existing.filter(
    (name) => name.startsWith(CACHE_PREFIX) && !keepSet.has(name),
  );
}

/**
 * FIFO eviction. `Cache.keys()` resolves in insertion order, so the head of the
 * list is the oldest entry.
 */
export function keysToEvict<T>(keys: readonly T[], max: number): T[] {
  if (max <= 0) return [...keys];
  const overflow = keys.length - max;
  return overflow > 0 ? keys.slice(0, overflow) : [];
}

export function isExpired(
  cachedAt: string | null | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!cachedAt) return false; // unknown age: keep it, offline value outweighs staleness
  const stamped = Number(cachedAt);
  if (!Number.isFinite(stamped)) return false;
  return now - stamped > maxAgeMs;
}

/**
 * Only successful, non-partial, same-origin-readable responses are worth
 * storing. 206 in particular must never be cached — a partial body served back
 * as a full response corrupts media playback.
 */
export function isCacheableResponse(response: {
  ok: boolean;
  status: number;
  type: string;
  redirected?: boolean;
}): boolean {
  if (!response.ok) return false;
  if (response.status === 206) return false;
  if (response.type === "opaque" || response.type === "opaqueredirect")
    return false;
  return true;
}
