/**
 * "Is the offline data on this disk provably mine?"
 *
 * ## The leak this closes
 *
 * The session-expiry fix started preserving `page.<pageId>` documents through a
 * 401, and the cleanup that was supposed to protect the next user of the
 * browser failed three separate ways in an audit — every one ending with the
 * previous user's text on the next user's screen **and pushed to the server
 * under their identity**:
 *
 * 1. the owner was never recorded, and an unknown owner was read as "same
 *    user";
 * 2. the reconcile hook was gated on the offline-editing switch, so a user who
 *    simply did not want offline editing thereby disabled the privacy cleanup;
 * 3. the reconcile was triggered by a *notice* it consumed on first sign-in,
 *    while leaving the data — so the second sign-in found no notice, took the
 *    "nothing to do" branch, and never checked the owner at all.
 *
 * Three failures of one cleanup hook is a diagnosis, not three bugs. So the
 * design here is not another hook:
 *
 * - **presence of the data is the trigger**, not any note about it
 *   (`readOfflineDataOwner`, stored in IndexedDB beside the documents);
 * - **reconciliation runs unconditionally on sign-in**, never gated on a
 *   feature switch;
 * - **and the readers refuse independently.** This module publishes a verdict
 *   that the editing gate and the background-sync manager both consult, and
 *   both refuse to act on anything but `"ours"`. A missed cleanup therefore
 *   degrades to "data sits inert on disk" rather than "data appears in someone
 *   else's session".
 *
 * The default is `"unknown"`, which reads as *refuse*. Nothing has to go right
 * for that to hold; something has to go right to leave it.
 *
 * ## What this does not cover, stated plainly
 *
 * `page-editor.tsx` binds `IndexeddbPersistence` for every page it opens,
 * online or off — that is ordinary collaboration code the fork does not touch.
 * So a foreign document that is still on disk when a page is opened would still
 * merge. The answer is that such a document should not exist: preservation is
 * *refused outright* when the owner cannot be established
 * (`session-expiry.ts`), and reconciliation erases on mismatch before any page
 * route can render. The refusals here are defence in depth for the window in
 * between and for the "pushed under the wrong identity" half, not the primary
 * control.
 */

import { useSyncExternalStore } from "react";
import { clearOfflineData } from "./clear-offline-data";
import {
  readDirtyPages,
  readOfflineDataOwner,
  type DirtyPagesRead,
  type OfflineDataOwner,
} from "./dirty-pages";

export type OwnershipStatus =
  /** Not established yet, or established as somebody else's. Refuse. */
  | "unknown"
  /** This browser's offline data provably belongs to the signed-in user. */
  | "ours";

let status: OwnershipStatus = "unknown";
/** Who reconciliation last settled for; the readers compare against this. */
let settledUserId: string | null = null;
const listeners = new Set<() => void>();

/**
 * The identity the current verdict was reached for.
 *
 * Published so that readers can check ownership **against the store the work
 * lives in**, rather than trusting this module's boolean. The boolean is a
 * cache of an answer; the stamp in the dirty-page store is the answer, and it
 * cannot be out of step with the records beside it.
 */
export function getSettledUserId(): string | null {
  return settledUserId;
}

export function getOwnershipStatus(): OwnershipStatus {
  return status;
}

/** The one question every reader asks. Fails closed by construction. */
export function offlineDataIsOurs(): boolean {
  return status === "ours";
}

function setStatus(next: OwnershipStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notified whenever the verdict changes.
 *
 * The resync manager needs this, not just the value: its first pass runs the
 * moment it is created, which is *before* reconciliation has had time to ask
 * the server who is signed in. Without a nudge the pass returns empty, the
 * schedule books its next attempt a minute later, and a user who has just
 * recovered a session watches nothing happen. Observed in a browser.
 */
export function subscribeOwnership(listener: () => void): () => void {
  return subscribe(listener);
}

export function useOfflineDataIsOurs(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => status === "ours",
    () => false,
  );
}

export interface ReconcileDeps {
  readOfflineDataOwner?: () => Promise<OfflineDataOwner>;
  /** Whether this disk holds offline work at all; see the `"none"` branch. */
  readDirtyPages?: () => Promise<DirtyPagesRead>;
  clearOfflineData?: () => Promise<void>;
}

export type ReconcileOutcome =
  /** No user known yet: nothing decided, nothing erased, readers stay refusing. */
  | "deferred"
  /** No preserved data on this disk. */
  | "clean"
  /** The preserved data is the signed-in user's. */
  | "ours"
  /** It was somebody else's, or unreadable. Everything has been erased. */
  | "erased";

/**
 * Decide, once per sign-in, whether the offline data on this disk may be used.
 *
 * Called unconditionally — **not** behind the offline-editing switch — because
 * a user turning that switch off is asking for less offline editing, not for
 * less privacy.
 *
 * Erasing is the answer to both "it is someone else's" and "I cannot tell",
 * which are the same thing from the next user's point of view.
 */
export async function reconcileOfflineDataOwnership(
  currentUserId: string | null | undefined,
  deps: ReconcileDeps = {},
): Promise<ReconcileOutcome> {
  const {
    readOfflineDataOwner: readOwner = readOfflineDataOwner,
    readDirtyPages: readPages = readDirtyPages,
    clearOfflineData: clear = clearOfflineData,
  } = deps;

  settledUserId = currentUserId ?? null;

  if (!currentUserId) {
    // No identity yet, so no claim can be proved *or* disproved. Erasing here
    // would destroy the signed-in user's own pending work every time the user
    // query happened to be slow; refusing to decide costs nothing, because the
    // readers stay closed and the app renders no pages without a user.
    setStatus("unknown");
    return "deferred";
  }

  const owner = await readOwner();

  if (owner.status === "none") {
    /**
     * **No stamp is only benign when there is nothing to own.**
     *
     * Every authenticated boot now stamps this disk (`use-offline-resync.ts`),
     * so an absent stamp should mean "a browser that has never held anyone's
     * offline data". It is still not *proof* of that — a stamp write can fail
     * on quota, and a navigation can kill the session-expiry cleanup before it
     * lands — so the records themselves are consulted rather than trusted to
     * be absent.
     *
     * Unstamped **and empty** is a fresh browser: nothing to protect, nothing
     * to lose. Unstamped **with work on it** is data nobody has claimed, which
     * from the next user's point of view is indistinguishable from a
     * stranger's, and is erased on the same principle as a mismatch. A fresh
     * browser therefore never pays for this, and a browser that lost its stamp
     * cannot hand its contents to whoever signs in next.
     */
    const pages = await readPages();
    const holdsWork = !pages.readable || pages.records.length > 0;
    if (!holdsWork) {
      setStatus("ours");
      return "clean";
    }
    setStatus("unknown");
    await clear();
    setStatus("ours");
    return "erased";
  }

  if (owner.status === "known" && owner.ownerUserId === currentUserId) {
    setStatus("ours");
    return "ours";
  }

  // Somebody else's, or a stamp that cannot be read. Erase first, then open
  // the readers — never the other way round.
  setStatus("unknown");
  await clear();
  setStatus("ours");
  return "erased";
}

/** Test seam: module state has to be resettable between cases. */
export function resetOwnershipForTests(): void {
  status = "unknown";
  settledUserId = null;
  for (const listener of listeners) listener();
}
