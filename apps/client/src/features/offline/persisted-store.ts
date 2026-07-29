/**
 * The IndexedDB slot the dehydrated React Query cache lives in.
 *
 * Split out from `persistence.ts` for two reasons: logout cleanup needs to
 * erase the slot without pulling in the whole persister (and its build-time
 * `APP_VERSION` global), and the write kill switch below has to be reachable
 * from both sides.
 *
 * localStorage is not an option here — a single visited page's ProseMirror JSON
 * routinely runs to hundreds of kilobytes, and the whole store has to hold every
 * page the user visited.
 */

import { clear, createStore, del, get, set } from "idb-keyval";

export const QUERY_CACHE_DB_NAME = "docmost-offline";
export const QUERY_CACHE_STORE_NAME = "query-cache";
export const QUERY_CACHE_KEY = "react-query";

const store = createStore(QUERY_CACHE_DB_NAME, QUERY_CACHE_STORE_NAME);

/**
 * Flipped by {@link stopPersistingQueryCache}, never flipped back.
 *
 * Logout races the persister: `PersistQueryClientProvider` writes on a throttle,
 * so a write scheduled just before the user hit "log out" would otherwise land
 * *after* the store was erased and put the previous user's data back on disk.
 * Refusing all further writes for the lifetime of the document closes that race
 * without needing to reach into the persister's internals. Both exits from an
 * authenticated session end in a full-page navigation, so "for the lifetime of
 * the document" is the same thing as "until a new session starts".
 */
let writesDisabled = false;

export function stopPersistingQueryCache(): void {
  writesDisabled = true;
}

/** Test seam: the kill switch is module state and has to be resettable. */
export function resumePersistingQueryCacheForTests(): void {
  writesDisabled = false;
}

/**
 * `AsyncStorage` as `@tanstack/query-async-storage-persister` expects it:
 * `getItem` resolves `null` when absent, and all three reject-safe.
 */
export const queryCacheStorage = {
  getItem: async (key: string): Promise<string | null> => {
    const value = await get<string>(key, store);
    return value ?? null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (writesDisabled) return;
    await set(key, value, store);
  },
  removeItem: async (key: string): Promise<void> => {
    await del(key, store);
  },
};

/**
 * Erase the dehydrated cache. Records go first, so the data is unrecoverable
 * even if the database itself survives; dropping the (now empty) database is a
 * best-effort tidy-up that must never block the caller, because an open
 * idb-keyval connection makes `deleteDatabase` wait for `versionchange`.
 */
export async function deletePersistedQueryCache(): Promise<void> {
  await clear(store);
  try {
    globalThis.indexedDB?.deleteDatabase(QUERY_CACHE_DB_NAME);
  } catch {
    /* the records are already gone; an orphaned empty database is harmless */
  }
}
