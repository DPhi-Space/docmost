/**
 * "Which pages hold edits this browser has not managed to push yet?"
 *
 * Phase 2 made a previously-synced page editable with no connection; the edit
 * lands in that page's `page.<pageId>` y-indexeddb database and is pushed the
 * next time *that page* is opened. Phase 3 removes the "next time that page is
 * opened" clause, and this store is the list it works from.
 *
 * A record is written by the phase-2 hook when the user edits a page whose
 * provider is not connected (`dirty-tracking.ts`), and removed when a genuine
 * remote sync for that page drains its unsynced-changes counter — either
 * because the user opened it (the hook again) or because the resync manager
 * pushed it in the background (`resync-manager.ts`).
 *
 * ## Two things this store deliberately does
 *
 * 1. **It never forgets an entry it could not push.** A page the server refuses
 *    (locked, trashed, access revoked) is *marked* `blocked` with a reason and
 *    kept, so the UI can list it and the user can act. Dropping it would throw
 *    away the only pointer to work that exists solely on this device.
 * 2. **It carries enough to render a link without the query cache.** The
 *    blocked list has to be usable in a session where the React Query cache has
 *    been cleared or has evicted the page, so the record keeps the slug, title
 *    and space slug captured at the moment the edit was made.
 *
 * A separate IndexedDB **database**, for the same reason `sync-markers.ts` uses
 * one: idb-keyval's `createStore` opens at version 1 and creates its store in
 * the upgrade callback, so a second store name against an existing database
 * never runs the upgrade and every transaction then fails with `NotFoundError`.
 *
 * Cleared on logout by `clearOfflineData()`.
 */

import { clear, createStore, del, entries, get, set, type UseStore } from "idb-keyval";

export const DIRTY_PAGES_DB_NAME = "docmost-offline-dirty";
export const DIRTY_PAGES_STORE_NAME = "dirty-pages";

/**
 * Why a page could not be pushed. Both are *server* answers, not transport
 * failures — a transport failure leaves the entry untouched so the next pass
 * retries it.
 */
export type BlockedReason =
  /**
   * The connection was accepted, the handshake completed, and the server never
   * acknowledged our updates: a read-only connection answering every update
   * with `SyncStatus(false)`. In this fork that is overwhelmingly the page
   * lock; it is also space-READER access, a page-level restriction, or a
   * trashed page. See `unsynced-changes.ts` for why only elapsed time can
   * detect it.
   */
  | "not-accepted"
  /**
   * Authentication failed while holding a token that is demonstrably *not*
   * expired (`collab-auth.ts`): the page was hard-deleted, or access to it was
   * revoked outright.
   */
  | "no-access";

/** Enough to build a page URL with `buildPageUrl` and name it to the user. */
export interface DirtyPageLink {
  slugId?: string;
  title?: string;
  /** `space.slug`; absent for a page whose space was not in the cache. */
  spaceSlug?: string;
}

export interface DirtyPageRecord {
  pageId: string;
  /** When the first still-unpushed edit was recorded. */
  dirtySince: number;
  /** When the most recent edit was recorded. */
  updatedAt: number;
  /** Set once a resync attempt concluded the server will not take the edits. */
  blocked?: { reason: BlockedReason; at: number };
  link?: DirtyPageLink;
}

/**
 * The slice of idb-keyval this module needs, so the semantics below can be
 * tested against a real map instead of against a jsdom without IndexedDB.
 */
export interface DirtyPageBackend {
  get(key: string): Promise<DirtyPageRecord | undefined>;
  set(key: string, value: DirtyPageRecord): Promise<void>;
  del(key: string): Promise<void>;
  entries(): Promise<[string, DirtyPageRecord][]>;
  clear(): Promise<void>;
}

/**
 * Resolved lazily and always inside a `try`, for the reason spelled out in
 * `sync-markers.ts`: `createStore` opens an IndexedDB connection as a side
 * effect, so at module scope it would create the database in sessions that
 * never turn offline editing on and would throw on import under jsdom.
 */
let store: UseStore | undefined;
function defaultBackend(): DirtyPageBackend {
  store ??= createStore(DIRTY_PAGES_DB_NAME, DIRTY_PAGES_STORE_NAME);
  const s = store;
  return {
    get: (key) => get<DirtyPageRecord>(key, s),
    set: (key, value) => set(key, value, s),
    del: (key) => del(key, s),
    entries: () => entries<string, DirtyPageRecord>(s),
    clear: () => clear(s),
  };
}

/**
 * Record that `pageId` holds an edit this browser has not pushed.
 *
 * Merging rather than replacing: `dirtySince` is preserved so the UI can order
 * by age, and an existing `blocked` mark **survives a further edit**. The mark
 * describes the server's last answer, and typing more does not make a locked
 * page writable; it is cleared only by a successful push, or by a retry pass
 * that gets a different answer.
 *
 * Best effort — a rejected write (quota, private mode) leaves the edit exactly
 * where it already is, in the page's own y-indexeddb database, recoverable by
 * opening the page.
 */
export async function recordDirtyPage(
  pageId: string,
  link?: DirtyPageLink,
  backend?: DirtyPageBackend,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const store = backend ?? defaultBackend();
    const existing = await store.get(pageId);
    await store.set(pageId, {
      ...existing,
      pageId,
      dirtySince: existing?.dirtySince ?? now,
      updatedAt: now,
      // A later edit may know more about the page than the first one did.
      link: link ?? existing?.link,
    });
    return true;
  } catch {
    // Reported rather than swallowed: a page that could not be registered is a
    // page a later session-expiry will not know to preserve, so the caller gets
    // the chance to say so out loud.
    return false;
  }
}

/** Forget a page whose edits the server has acknowledged. */
export async function clearDirtyPage(
  pageId: string,
  backend?: DirtyPageBackend,
): Promise<void> {
  try {
    await (backend ?? defaultBackend()).del(pageId);
  } catch {
    // A stale entry costs one redundant resync attempt, nothing more.
  }
}

/**
 * Mark an entry as one the server would not take, **keeping it**.
 *
 * No-ops if the entry has since been removed, so a push that succeeded in
 * another tab between the attempt and its verdict cannot resurrect it.
 */
export async function markDirtyPageBlocked(
  pageId: string,
  reason: BlockedReason,
  backend?: DirtyPageBackend,
  now: number = Date.now(),
): Promise<void> {
  try {
    const store = backend ?? defaultBackend();
    const existing = await store.get(pageId);
    if (!existing) return;
    await store.set(pageId, { ...existing, blocked: { reason, at: now } });
  } catch {
    // The entry stays un-marked and is retried on the next pass.
  }
}

/**
 * Who the data in this store — and the `page.*` documents it indexes — belongs
 * to.
 *
 * Held **in IndexedDB, beside the data**, not in localStorage. The two must not
 * be separable: a browser holding one user's preserved offline documents with
 * another user's (or no) owner record is exactly the cross-account leak this
 * exists to prevent, and localStorage is cleared, blocked and per-origin-quota'd
 * independently of IndexedDB.
 *
 * It is stored under a reserved key inside the dirty-page store rather than in
 * a store of its own, because it must survive and disappear with precisely the
 * same records it describes. `isDirtyPageRecord` filters it out of every listing
 * (it has no `pageId`), so nothing else has to know it is there.
 */
export const OFFLINE_DATA_OWNER_RECORD_KEY = "__offline-data-owner";

export interface OfflineDataOwnerRecord {
  ownerUserId: string;
  at: number;
}

function isOwnerRecord(value: unknown): value is OfflineDataOwnerRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OfflineDataOwnerRecord).ownerUserId === "string"
  );
}

/** Stamp the store with its owner. Returns false if it could not be written. */
export async function setOfflineDataOwner(
  ownerUserId: string,
  backend?: DirtyPageBackend,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const store = backend ?? defaultBackend();
    await store.set(OFFLINE_DATA_OWNER_RECORD_KEY, {
      ownerUserId,
      at: now,
    } as unknown as DirtyPageRecord);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the owner stamp.
 *
 * Three answers, and the caller must treat two of them the same way:
 * `{ status: "none" }` — nothing is preserved, nothing to protect;
 * `{ status: "known", ownerUserId }` — compare it;
 * `{ status: "unreadable" }` — **assume the worst**, because an unreadable
 * store is indistinguishable from one holding somebody else's work.
 */
export type OfflineDataOwner =
  | { status: "none" }
  | { status: "known"; ownerUserId: string }
  | { status: "unreadable" };

export async function readOfflineDataOwner(
  backend?: DirtyPageBackend,
): Promise<OfflineDataOwner> {
  try {
    const raw = await (backend ?? defaultBackend()).get(
      OFFLINE_DATA_OWNER_RECORD_KEY,
    );
    if (raw === undefined) return { status: "none" };
    return isOwnerRecord(raw)
      ? { status: "known", ownerUserId: raw.ownerUserId }
      : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

/**
 * Every page with unpushed edits, together with whether the store could be read
 * at all.
 *
 * The distinction is load-bearing for session expiry: `listDirtyPages`
 * answering `[]` for an unreadable store reads as "nothing is pending", and
 * "nothing is pending" is what licenses deleting every `page.*` database. An
 * unreadable registry must mean *preserve*, not *erase*.
 */
export type DirtyPagesRead =
  | { readable: true; records: DirtyPageRecord[] }
  | { readable: false };

export async function readDirtyPages(
  backend?: DirtyPageBackend,
): Promise<DirtyPagesRead> {
  try {
    const rows = await (backend ?? defaultBackend()).entries();
    return {
      readable: true,
      records: rows.map(([, record]) => record).filter(isDirtyPageRecord),
    };
  } catch {
    return { readable: false };
  }
}

/** Every page with unpushed edits, blocked or not. Never throws. */
export async function listDirtyPages(
  backend?: DirtyPageBackend,
): Promise<DirtyPageRecord[]> {
  try {
    const rows = await (backend ?? defaultBackend()).entries();
    return rows.map(([, record]) => record).filter(isDirtyPageRecord);
  } catch {
    return [];
  }
}

/** Guards against a half-written or older-shaped record wedging a pass. */
function isDirtyPageRecord(value: unknown): value is DirtyPageRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DirtyPageRecord).pageId === "string"
  );
}

/**
 * Drop every entry, leaving the database shell in place.
 *
 * Same reasoning as `clearPageSyncMarkers`: idb-keyval holds its connection
 * open with no `versionchange` handler, so `deleteDatabase` parks as `blocked`
 * and then blocks every later `open` of that name for the life of the document.
 */
export async function clearDirtyPages(
  backend?: DirtyPageBackend,
): Promise<void> {
  try {
    await (backend ?? defaultBackend()).clear();
  } catch {
    // Best effort; logout is followed by a full-page navigation.
  }
}

export interface SelectPagesOptions {
  /** The document `PageEditor` currently owns; never resynced from here. */
  openPageId: string | null;
  /**
   * Whether entries already marked `blocked` are retried in this pass.
   *
   * True for the passes a *change of circumstances* triggers — coming back
   * online, booting, an explicit retry — because that is when a lifted lock or
   * a restored permission would be discovered. False for the periodic timer,
   * where each blocked page would otherwise burn its full 30 s timeout on
   * every tick forever.
   */
  includeBlocked: boolean;
}

/**
 * Which pages this pass should attempt, oldest edit first.
 *
 * Pure, because the two exclusions are the whole safety story of the manager:
 * the currently-open page is skipped so two providers never hold the same
 * `documentName`, and blocked entries are excluded from periodic passes without
 * ever being removed from the store.
 */
export function selectPagesToResync(
  records: readonly DirtyPageRecord[],
  { openPageId, includeBlocked }: SelectPagesOptions,
): DirtyPageRecord[] {
  return records
    .filter((record) => record.pageId !== openPageId)
    .filter((record) => includeBlocked || !record.blocked)
    .sort((a, b) => (a.dirtySince ?? 0) - (b.dirtySince ?? 0));
}

/** The entries the UI lists under "could not sync", oldest first. */
export function blockedPages(
  records: readonly DirtyPageRecord[],
): DirtyPageRecord[] {
  return records
    .filter((record) => record.blocked)
    .sort((a, b) => (a.dirtySince ?? 0) - (b.dirtySince ?? 0));
}
