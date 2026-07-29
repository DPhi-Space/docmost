/**
 * Erase everything this browser profile kept about the signed-in user.
 *
 * Three stores accumulate user content on disk, and until now none of them were
 * cleaned up on logout:
 *
 * 1. the dehydrated React Query cache (new in this phase — user, workspace,
 *    space tree, and the full body of every page visited);
 * 2. one y-indexeddb database per opened page, `page.<pageId>` — a pre-existing
 *    gap that has always outlived logout, and one that persisting REST content
 *    makes considerably more visible;
 * 3. the service worker's runtime caches, which include `GET /api/files/*`
 *    responses, i.e. attachments;
 * 4. the phase-2 per-page sync markers, which record which pages this user was
 *    allowed to sync — both a small disclosure and, left behind, a way for the
 *    next user of the browser to be handed an offline editor on them;
 * 5. the phase-3 dirty-page registry, which names the pages this user edited
 *    offline and, for blocked entries, their titles and space slugs. It is the
 *    most directly readable of the five — and, left behind, it would aim the
 *    next session's background sync at the previous user's pages.
 *
 * Note what deleting (5) *is not*: it does not delete the edits. Those live in
 * the `page.<pageId>` databases, which step (2) removes in the same pass. The
 * registry is an index, and it is dropped alongside what it indexes.
 *
 * Called from both exits of an authenticated session: the explicit
 * `handleLogout` and the 401 handler's `redirectToLogin`. Both end in a
 * full-page navigation, so this runs on a document that is about to die — every
 * step is therefore best-effort and bounded, and a failure in one must never
 * prevent the others or delay the redirect.
 */

import { CACHE_PREFIX } from "./sw/cache-policy";
import {
  deletePersistedQueryCache,
  stopPersistingQueryCache,
} from "./persisted-store";
import { clearPageSyncMarkers } from "./sync-markers";
import { clearDirtyPages } from "./dirty-pages";

/** y-indexeddb database name for a page, mirroring `page-editor.tsx:136`. */
const PAGE_DB_PREFIX = "page.";

/** Precaches hold build output only — see {@link runtimeCachesToDelete}. */
const PRECACHE_PREFIX = `${CACHE_PREFIX}precache-`;

/** Never let a blocked `deleteDatabase` hold up the logout redirect. */
const DEFAULT_DELETE_TIMEOUT_MS = 2_000;

/** The narrow slice of `QueryClient` this module uses. */
export interface QueryClientLike {
  clear(): void;
  getQueryCache(): { getAll(): ReadonlyArray<{ queryKey: readonly unknown[] }> };
}

export interface ClearOfflineDataDeps {
  /**
   * Cleared in memory as well as on disk. Optional because `redirectToLogin`
   * has no React context to reach a client through; that path relies on the
   * full-page navigation that immediately follows.
   */
  queryClient?: QueryClientLike;
  indexedDB?: IDBFactory | null;
  caches?: CacheStorage | null;
  deletePersistedQueryCache?: () => Promise<void>;
  stopPersistingQueryCache?: () => void;
  /** Phase 2's per-page "has completed a real remote sync" markers. */
  clearPageSyncMarkers?: () => Promise<void>;
  /** Phase 3's registry of pages with edits that were never pushed. */
  clearDirtyPages?: () => Promise<void>;
  deleteTimeoutMs?: number;
}

/**
 * Which of the databases the browser reports belong to a page's Yjs document.
 *
 * Pure so the naming rule is pinned by a test: it is the one piece of knowledge
 * this module shares with the collaboration code, which the fork does not touch.
 */
export function pageDatabaseNames(existing: readonly string[]): string[] {
  return existing.filter(
    (name) => name.startsWith(PAGE_DB_PREFIX) && name.length > PAGE_DB_PREFIX.length,
  );
}

/**
 * Fallback for browsers without `indexedDB.databases()` (Firefox, as of
 * writing): reconstruct the page database names from the query cache, which
 * holds a `["pages", <id>]` entry for every page the session touched.
 *
 * Those entries are keyed by both UUID and slugId (`page-query.ts:56-64`), so
 * this yields some names that were never real databases — deleting a database
 * that does not exist is a no-op, which is the right trade against leaving a
 * real one behind.
 */
export function pageDatabaseNamesFromQueryCache(
  queryClient: QueryClientLike,
): string[] {
  const names = new Set<string>();
  for (const query of queryClient.getQueryCache().getAll()) {
    const [root, id] = query.queryKey;
    if (root === "pages" && typeof id === "string" && id.length > 0) {
      names.add(`${PAGE_DB_PREFIX}${id}`);
    }
  }
  return [...names];
}

/**
 * Which service worker caches to drop.
 *
 * Everything the offline feature owns, **except** the build's precache. The
 * precache holds nothing but compiled application assets, and it is the thing
 * that lets the app boot with no network; dropping it would leave the next
 * session unable to start offline until the following deploy, since an already
 * activated worker never re-runs `install`. Stale precaches from earlier builds
 * are pruned by the worker's own `activate`.
 *
 * The runtime caches, by contrast, hold the last served HTML and — in the
 * `files` cache — attachment bodies, which are user content.
 */
export function runtimeCachesToDelete(existing: readonly string[]): string[] {
  return existing.filter(
    (name) => name.startsWith(CACHE_PREFIX) && !name.startsWith(PRECACHE_PREFIX),
  );
}

export async function clearOfflineData(
  deps: ClearOfflineDataDeps = {},
): Promise<void> {
  const {
    queryClient,
    indexedDB: idb = globalThis.indexedDB,
    caches: cacheStorage = globalThis.caches,
    deletePersistedQueryCache: deleteCache = deletePersistedQueryCache,
    stopPersistingQueryCache: stopPersisting = stopPersistingQueryCache,
    clearPageSyncMarkers: clearMarkers = clearPageSyncMarkers,
    clearDirtyPages: clearDirty = clearDirtyPages,
    deleteTimeoutMs = DEFAULT_DELETE_TIMEOUT_MS,
  } = deps;

  // First, before anything else: make the persister refuse further writes, so a
  // throttled write already in flight cannot restore what we are about to erase.
  stopPersisting();

  // Read the page database names while the cache is still populated — the
  // fallback path derives them from it.
  const fallbackNames = queryClient
    ? pageDatabaseNamesFromQueryCache(queryClient)
    : [];

  await Promise.allSettled([
    deleteCache(),
    clearMarkers(),
    clearDirty(),
    deletePageDatabases(idb, fallbackNames, deleteTimeoutMs),
    deleteRuntimeCaches(cacheStorage),
  ]);

  queryClient?.clear();
}

async function deletePageDatabases(
  idb: IDBFactory | null | undefined,
  fallbackNames: readonly string[],
  timeoutMs: number,
): Promise<void> {
  if (!idb) return;

  let names: readonly string[];
  if (typeof idb.databases === "function") {
    const listed = await idb.databases();
    names = pageDatabaseNames(
      listed.map((info) => info.name).filter((n): n is string => Boolean(n)),
    );
  } else {
    names = fallbackNames;
  }

  await Promise.allSettled(
    names.map((name) => deleteDatabase(idb, name, timeoutMs)),
  );
}

/**
 * `deleteDatabase` fires `blocked` and then waits indefinitely while another
 * connection is open — during logout an editor's y-indexeddb connection very
 * often still is. Resolve on the timeout instead: the deletion stays queued and
 * completes as soon as the navigation tears the connection down.
 */
function deleteDatabase(
  idb: IDBFactory,
  name: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      const request = idb.deleteDatabase(name);
      request.onsuccess = settle;
      request.onerror = settle;
    } catch {
      settle();
    }
  });
}

async function deleteRuntimeCaches(
  cacheStorage: CacheStorage | null | undefined,
): Promise<void> {
  if (!cacheStorage) return;
  const keys = await cacheStorage.keys();
  await Promise.allSettled(
    runtimeCachesToDelete(keys).map((name) => cacheStorage.delete(name)),
  );
}
