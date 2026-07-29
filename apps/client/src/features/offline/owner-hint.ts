/**
 * Which account is browsing, in a form the axios 401 interceptor can read.
 *
 * A leaf module with no imports, because both `clear-offline-data.ts` and
 * `session-expiry.ts` need it and they already depend on each other.
 *
 * **This is a hint, not a guard.** The guard is the owner stamp written into
 * IndexedDB beside the data (`dirty-pages.ts`, `setOfflineDataOwner`), which is
 * what every reader checks. This exists only because `redirectToLogin()` runs
 * outside React, with no query client to ask and no async boundary to await an
 * IndexedDB read on — and because a 401 has to decide *whether to preserve at
 * all* in that moment. Missing hint ⇒ nothing is preserved.
 *
 * It holds a user id and nothing else: no name, no email, no token.
 */

export const OFFLINE_DATA_OWNER_KEY = "docmost.offline.owner";

/** The slice of `Storage` this module uses; injected in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultOwnerStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari private mode, and any embedding that blocks storage access.
    return null;
  }
}

export function rememberOfflineDataOwner(
  userId: string | null | undefined,
  storage: StorageLike | null = defaultOwnerStorage(),
): void {
  try {
    if (userId) storage?.setItem(OFFLINE_DATA_OWNER_KEY, userId);
  } catch {
    // Without it, session expiry falls back to erasing — fail closed.
  }
}

export function readOfflineDataOwnerHint(
  storage: StorageLike | null = defaultOwnerStorage(),
): string | null {
  try {
    return storage?.getItem(OFFLINE_DATA_OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Content-free, but a stable identifier; it goes on an explicit logout. */
export function forgetOfflineDataOwner(
  storage: StorageLike | null = defaultOwnerStorage(),
): void {
  try {
    storage?.removeItem(OFFLINE_DATA_OWNER_KEY);
  } catch {
    /* nothing to do */
  }
}
