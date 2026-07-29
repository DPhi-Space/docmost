/**
 * What happens to offline work when the *session* ends but the *user* does not.
 *
 * ## The defect this exists to fix
 *
 * `redirectToLogin()` fires on any 401 and used to call `clearOfflineData()` —
 * the explicit-logout cleanup, which deletes every `page.<pageId>` IndexedDB
 * database. Since phase 2 those databases can hold the **only** copy of the
 * user's work, and since phase 3 the dirty registry is the only index of which
 * ones do. So a token expiring while a laptop was offline, an admin revoking a
 * session, "log out all devices", or a server restart with a rotated
 * `APP_SECRET` silently and permanently destroyed unsynced edits. Verified end
 * to end before this module existed: two pages edited offline, cookie dropped,
 * reconnect — `page.*` gone, registry gone, edits never on the server.
 *
 * ## Why the two exits differ, and must keep differing
 *
 * #18 made logout cleanup non-optional for **privacy on a shared machine**, and
 * that reasoning is untouched: an explicit logout is the user saying they are
 * done with this device, and `clearOfflineData()` still erases everything for
 * it. A 401 is a different event with a different meaning — *the session
 * expired*, not *the user left*. Treating the two identically was defensible
 * when #18 was written, because a `page.*` database then held only a cached
 * copy of content the server already had. Phases 2 and 3 changed what is at
 * stake; this is a deliberate, narrow reversal of #18's stated behaviour on one
 * of its two paths, and nothing else.
 *
 * What the 401 path keeps is exactly what is needed to recover the work:
 * - the `page.<pageId>` database of every page the dirty registry lists;
 * - the sync markers for those same pages, and no others (a marker whose
 *   document has been deleted is the lie `offline-edit-gate.ts` now refuses to
 *   act on);
 * - the registry itself, which is the index of the above.
 *
 * Everything else still goes: the dehydrated query cache, the runtime caches
 * (attachments included), every other page's database, every other marker. With
 * nothing pending, the 401 path is byte-for-byte the logout path.
 *
 * ## And it is not kept silently
 *
 * The preserved state is announced twice. A notice is written to localStorage
 * and rendered on the login page the user is about to land on
 * (`unsynced-recovery-notice.tsx`), and on the next sign-in the resync manager
 * pushes the edits by itself. If a **different** account signs in on this
 * browser, `reconcilePendingRecovery` erases the preserved data before that
 * user can see any of it — which is the shared-machine case #18 cared about,
 * handled at the moment it can actually be identified.
 */

import { clearOfflineData, type ClearOfflineDataDeps } from "./clear-offline-data";
import { listDirtyPages, type DirtyPageRecord } from "./dirty-pages";

export const PENDING_RECOVERY_KEY = "docmost.offline.pending-recovery";
export const OFFLINE_DATA_OWNER_KEY = "docmost.offline.owner";

export interface PendingRecoveryPage {
  pageId: string;
  title?: string;
}

export interface PendingRecoveryNotice {
  at: number;
  /**
   * Who the preserved documents belong to, if it was recorded. `null` means
   * unknown, which is read as "the same user" — see `reconcilePendingRecovery`.
   */
  ownerUserId: string | null;
  pages: PendingRecoveryPage[];
}

/** The slice of `Storage` this module uses; injected in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Remember which account the on-disk offline data belongs to.
 *
 * Written from the authenticated shell (`use-offline-resync.ts`), because the
 * 401 handler runs outside React and has no way to ask. localStorage rather
 * than the query cache: the 401 path erases the query cache, and this has to
 * outlive it.
 */
export function rememberOfflineDataOwner(
  userId: string | null | undefined,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    if (userId) storage?.setItem(OFFLINE_DATA_OWNER_KEY, userId);
  } catch {
    // An unknown owner is handled; a failed write is not worth reporting.
  }
}

export function readOfflineDataOwner(
  storage: StorageLike | null = defaultStorage(),
): string | null {
  try {
    return storage?.getItem(OFFLINE_DATA_OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readPendingRecovery(
  storage: StorageLike | null = defaultStorage(),
): PendingRecoveryNotice | null {
  try {
    const raw = storage?.getItem(PENDING_RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingRecoveryNotice;
    return Array.isArray(parsed?.pages) && parsed.pages.length > 0
      ? parsed
      : null;
  } catch {
    // A corrupt notice must not break the login page.
    return null;
  }
}

export function clearPendingRecovery(
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(PENDING_RECOVERY_KEY);
  } catch {
    /* nothing to do */
  }
}

function writePendingRecovery(
  notice: PendingRecoveryNotice,
  storage: StorageLike | null,
): void {
  try {
    storage?.setItem(PENDING_RECOVERY_KEY, JSON.stringify(notice));
  } catch {
    // The data is still preserved; only the announcement is lost.
  }
}

export interface SessionExpiryDeps {
  listDirtyPages?: () => Promise<DirtyPageRecord[]>;
  clearOfflineData?: (deps?: ClearOfflineDataDeps) => Promise<void>;
  storage?: StorageLike | null;
  now?: () => number;
}

/**
 * The cleanup for a 401, as opposed to a logout.
 *
 * Never rejects: it runs on a document that is one statement away from a
 * full-page navigation, and a rejected promise there would be an unhandled
 * rejection and nothing more.
 */
export async function clearOfflineDataOnSessionExpiry(
  deps: SessionExpiryDeps = {},
): Promise<void> {
  const {
    listDirtyPages: list = listDirtyPages,
    clearOfflineData: clear = clearOfflineData,
    storage = defaultStorage(),
    now = Date.now,
  } = deps;

  let pending: DirtyPageRecord[] = [];
  try {
    pending = await list();
  } catch {
    pending = [];
  }

  if (pending.length === 0) {
    // Nothing on this device that the server does not already have. There is
    // no work to protect, so the privacy answer wins outright and this is the
    // logout path exactly.
    clearPendingRecovery(storage);
    await clear();
    return;
  }

  const preservePageIds = pending.map((record) => record.pageId);
  await clear({ preservePageIds, preserveDirtyPages: true });

  writePendingRecovery(
    {
      at: now(),
      ownerUserId: readOfflineDataOwner(storage),
      pages: pending.map((record) => ({
        pageId: record.pageId,
        title: record.link?.title,
      })),
    },
    storage,
  );
}

export interface ReconcileDeps {
  clearOfflineData?: (deps?: ClearOfflineDataDeps) => Promise<void>;
  storage?: StorageLike | null;
}

/**
 * Settle a pending recovery once somebody signs back in.
 *
 * Two outcomes, and the interesting one is the second:
 *
 * - **Same user** (or an owner that was never recorded): drop the notice and
 *   leave the data alone. The resync manager finds the registry on boot and
 *   pushes the edits with no further ceremony. An unrecorded owner is read as
 *   "same user" on purpose — the alternative is destroying work on a guess,
 *   which is the defect this whole module exists to undo.
 * - **Different user**: erase everything, now, before the new user can open any
 *   of it. This is #18's shared-machine case, and deferring it to here is
 *   strictly better than acting at 401 time: at 401 nobody knows yet whether
 *   the machine changed hands, and here it is a fact.
 */
export async function reconcilePendingRecovery(
  currentUserId: string | null | undefined,
  deps: ReconcileDeps = {},
): Promise<"kept" | "discarded" | "none"> {
  const { clearOfflineData: clear = clearOfflineData, storage = defaultStorage() } =
    deps;

  const notice = readPendingRecovery(storage);
  if (!notice) return "none";

  if (notice.ownerUserId && currentUserId && notice.ownerUserId !== currentUserId) {
    clearPendingRecovery(storage);
    await clear();
    return "discarded";
  }

  clearPendingRecovery(storage);
  return "kept";
}
