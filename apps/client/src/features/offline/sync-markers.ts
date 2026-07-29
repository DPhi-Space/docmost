/**
 * "Has this page ever completed a real remote sync in this browser?"
 *
 * This is the single fact the offline editing gate is built on, and the reason
 * phase 2 does not belong to the regression class the fork is pinned away from.
 * Upstream's Hocuspocus v4 rewrite (docmost#2353, see AGENTS.md) lost content by
 * letting an *empty* local Yjs document become authoritative. A marker is
 * written only after the server has answered a sync handshake for that exact
 * document, so its presence means y-indexeddb holds a copy of real server
 * content — never an empty shell.
 *
 * A separate IndexedDB **database** rather than a second object store inside
 * `docmost-offline`: idb-keyval's `createStore` opens at version 1 and creates
 * its store in the upgrade callback, so a second store name against the same
 * database name finds an existing version-1 database, never runs the upgrade,
 * and every transaction then fails with `NotFoundError`.
 *
 * Cleared on logout by `clearOfflineData()` — a marker is a statement about a
 * specific user's access to a specific page, and outliving the session would let
 * the next user of the browser open a live editor on it.
 */

import { clear, createStore, get, set, type UseStore } from "idb-keyval";

export const SYNC_MARKER_DB_NAME = "docmost-offline-sync";
export const SYNC_MARKER_STORE_NAME = "page-sync-markers";

/**
 * The slice of idb-keyval this module needs, so the semantics below can be
 * tested against a real map instead of against a jsdb-less IndexedDB.
 */
export interface SyncMarkerBackend {
  get(key: string): Promise<number | undefined>;
  set(key: string, value: number): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Resolved lazily, and always *inside* a `try`.
 *
 * `createStore` opens an IndexedDB connection as a side effect. At module scope
 * it would create the database in every session — including the sessions that
 * never turn offline editing on, which must leave no trace — and would throw on
 * import in any environment without IndexedDB (jsdom, so every test that
 * transitively reaches this file).
 */
let store: UseStore | undefined;
function defaultBackend(): SyncMarkerBackend {
  store ??= createStore(SYNC_MARKER_DB_NAME, SYNC_MARKER_STORE_NAME);
  const s = store;
  return {
    get: (key) => get<number>(key, s),
    set: (key, value) => set(key, value, s),
    clear: () => clear(s),
  };
}

/**
 * Record that `pageId` completed a genuine remote sync.
 *
 * Idempotent and best-effort: the timestamp is only written the first time, so
 * repeated syncs of an open page do not turn every reconnect into a disk write,
 * and a rejected write (quota, private mode) leaves the page un-editable
 * offline rather than failing the editor.
 */
export async function markPageRemoteSynced(
  pageId: string,
  backend?: SyncMarkerBackend,
): Promise<void> {
  try {
    const store = backend ?? defaultBackend();
    if ((await store.get(pageId)) !== undefined) return;
    await store.set(pageId, Date.now());
  } catch {
    // Fail closed: no marker, no offline editing.
  }
}

/**
 * Has `pageId` completed a genuine remote sync in this browser?
 *
 * Any failure answers `false`. This is the safety predicate — an unreadable
 * store must never be mistaken for a synced page.
 */
export async function hasPageRemoteSynced(
  pageId: string,
  backend?: SyncMarkerBackend,
): Promise<boolean> {
  try {
    return (await (backend ?? defaultBackend()).get(pageId)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Drop every marker, leaving the database shell in place.
 *
 * Same reasoning as `deletePersistedQueryCache`: idb-keyval holds its connection
 * open with no `versionchange` handler, so `deleteDatabase` parks as `blocked`
 * and then blocks every later `open` of that name for the life of the document.
 */
export async function clearPageSyncMarkers(
  backend?: SyncMarkerBackend,
): Promise<void> {
  try {
    await (backend ?? defaultBackend()).clear();
  } catch {
    // Best effort; logout is followed by a full-page navigation.
  }
}
