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
 * ## Preservation requires a provable owner — no exceptions
 *
 * The first version of this module preserved first and established ownership
 * later, from a localStorage note that a cleanup hook consulted. An audit
 * reached the next user's session three separate ways through that gap. So the
 * rule is now the other way round:
 *
 * > **Nothing is preserved unless this browser can say, in the same IndexedDB
 * > store as the data, whose it is.**
 *
 * No owner known, or the stamp unwritable? Then this is the logout path: erase
 * everything, including the unsynced edits. That loses work in a case that
 * should not arise — the owner is recorded on every authenticated boot,
 * unconditionally — and losing work is the lesser failure against handing it to
 * a stranger. `data-ownership.ts` carries the rest of the reasoning and the
 * reader-side refusals that back it up.
 *
 * What preservation keeps is exactly what is needed to recover the work:
 * - the `page.<pageId>` database of every page the dirty registry lists;
 * - the sync markers for those same pages, and no others (a marker whose
 *   document has been deleted is the lie `offline-edit-gate.ts` refuses to act
 *   on);
 * - the registry itself, stamped with its owner;
 * - the upload outbox (phase 4), whenever it holds records — its blobs are the
 *   only copy of drawings and files the server never received, and the same
 *   reasoning applies to them verbatim. An outbox record is self-contained
 *   (blob + target page + target attachment), so preserving it forces nothing
 *   else to be preserved with it. Note that the outbox is consulted
 *   *independently* of the dirty registry: an offline re-save of an existing
 *   Excalidraw diagram queues an upload without ever touching the page's Yjs
 *   document, so "no dirty pages" does not imply "no pending work".
 *
 * Everything else still goes: the dehydrated query cache, the runtime caches
 * (attachments included), every other page's database, every other marker. With
 * nothing pending, the 401 path is byte-for-byte the logout path.
 */

import { clearOfflineData, type ClearOfflineDataDeps } from "./clear-offline-data";
import {
  readDirtyPages,
  setOfflineDataOwner,
  type DirtyPagesRead,
} from "./dirty-pages";
import { readUploadOutbox, type UploadOutboxRead } from "./upload-outbox";
import {
  defaultOwnerStorage,
  forgetOfflineDataOwner,
  readOfflineDataOwnerHint,
  type StorageLike,
} from "./owner-hint";

export {
  OFFLINE_DATA_OWNER_KEY,
  forgetOfflineDataOwner,
  readOfflineDataOwnerHint,
  rememberOfflineDataOwner,
} from "./owner-hint";
export type { StorageLike } from "./owner-hint";

export const PENDING_RECOVERY_KEY = "docmost.offline.pending-recovery";

export interface PendingRecoveryPage {
  pageId: string;
  title?: string;
}

export interface PendingRecoveryNotice {
  at: number;
  ownerUserId: string;
  pages: PendingRecoveryPage[];
}

const defaultStorage = defaultOwnerStorage;

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
    // The data is still preserved and still stamped; only the announcement is
    // lost. **Nothing downstream keys off this note** — that was the third of
    // the three leaks, where consuming the note was mistaken for settling the
    // data. See `data-ownership.ts`.
  }
}

export interface SessionExpiryDeps {
  readDirtyPages?: () => Promise<DirtyPagesRead>;
  readUploadOutbox?: () => Promise<UploadOutboxRead>;
  setOfflineDataOwner?: (ownerUserId: string) => Promise<boolean>;
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
    readDirtyPages: read = readDirtyPages,
    readUploadOutbox: readOutbox = readUploadOutbox,
    setOfflineDataOwner: stampOwner = setOfflineDataOwner,
    clearOfflineData: clear = clearOfflineData,
    storage = defaultStorage(),
    now = Date.now,
  } = deps;

  const eraseEverything = async () => {
    clearPendingRecovery(storage);
    forgetOfflineDataOwner(storage);
    await clear();
  };

  // Ownership first, before anything is inspected: without it there is no
  // preservation to consider, whatever the registry says.
  const ownerUserId = readOfflineDataOwnerHint(storage);
  if (!ownerUserId) {
    await eraseEverything();
    return;
  }

  let pending: DirtyPagesRead;
  try {
    pending = await read();
  } catch {
    pending = { readable: false };
  }

  // The outbox is consulted with the same rules: unreadable means "I cannot
  // tell", which must preserve, and its records count as pending work even
  // when no page is dirty (an Excalidraw re-save never touches the ydoc).
  let outbox: UploadOutboxRead;
  try {
    outbox = await readOutbox();
  } catch {
    outbox = { readable: false };
  }
  const outboxHoldsWork = !outbox.readable || outbox.records.length > 0;

  if (pending.readable && pending.records.length === 0 && !outboxHoldsWork) {
    // Nothing on this device that the server does not already have. There is
    // no work to protect, so the privacy answer wins outright and this is the
    // logout path exactly.
    await eraseEverything();
    return;
  }

  // An unreadable registry is **not** "nothing is pending" — it is "I cannot
  // tell what is pending", and deleting every document on that basis is how the
  // original defect destroyed work. Keep them all; the owner stamp and the
  // reconcile on next sign-in still keep them out of anyone else's session.
  const preserveAllPages = !pending.readable;
  const records = pending.readable ? pending.records : [];

  // Stamped *before* anything is erased, so a browser that dies mid-cleanup is
  // left holding data that is attributable rather than anonymous.
  if (!(await stampOwner(ownerUserId))) {
    await eraseEverything();
    return;
  }

  await clear({
    preservePageIds: records.map((record) => record.pageId),
    preserveAllPages,
    // The dirty registry is preserved only when it indexes preserved documents;
    // with no dirty pages (outbox-only work) there is nothing for it to index
    // and `clearOfflineData` clears it as usual.
    preserveDirtyPages: records.length > 0 || preserveAllPages,
    preserveUploadOutbox: outboxHoldsWork,
  });

  writePendingRecovery(
    {
      at: now(),
      ownerUserId,
      pages: records.map((record) => ({
        pageId: record.pageId,
        title: record.link?.title,
      })),
    },
    storage,
  );
}
