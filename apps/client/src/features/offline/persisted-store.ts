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
import { isServerReachable } from "./reachability";

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
 * An offline session can only ever *lose* information: nothing new can be
 * fetched, queries for pages that were never visited park as `pending`, and
 * inactive entries age out of the cache. Dehydrating that over a store written
 * by a healthy online session would quietly erode it, one offline reload at a
 * time — which is exactly what happened in a browser before this guard existed
 * (`currentUser` and the sidebar tree disappeared after a single offline
 * reload, so the *second* one booted blank).
 *
 * So the store is only ever written from a session that can reach the server.
 * Skipping the write costs nothing, because there is nothing to save that is not
 * already saved.
 *
 * `reachability.ts` rather than `navigator.onLine`: the erosion this guards
 * against is caused by a session that *cannot reach the server*, and
 * `navigator.onLine` reports `true` throughout one of the commonest ways of
 * being in that state (a VPN interface still up after Wi-Fi is switched off), so
 * the guard did not fire for it.
 */
function isOffline(): boolean {
  return !isServerReachable();
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
    if (writesDisabled || isOffline()) return;
    await set(key, value, store);
  },
  removeItem: async (key: string): Promise<void> => {
    await del(key, store);
  },
};

/**
 * Erase the dehydrated cache: every record goes, leaving an empty database.
 *
 * The empty database shell is left in place **deliberately**. Dropping it with
 * `deleteDatabase` looks tidier and is actively harmful: idb-keyval holds its
 * connection open and registers no `versionchange` handler, so the request
 * parks in the `blocked` state — and a blocked delete makes every *subsequent*
 * `indexedDB.open` of that name queue behind it. Measured in a browser: after a
 * logout that called `deleteDatabase`, nothing else in the document could open
 * the database again. No user data survives a `clear`, so the shell buys
 * nothing worth that.
 */
export async function deletePersistedQueryCache(): Promise<void> {
  await clear(store);
}
