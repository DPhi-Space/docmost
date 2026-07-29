/**
 * Where ownership is settled and the background sync loop is started.
 *
 * Two hooks, and the split between them is the point.
 *
 * `useOfflineDataOwnership()` runs **unconditionally**. It is a privacy
 * control, not a feature: an audit found that gating it on the offline-editing
 * switch meant a user who simply did not want offline editing thereby disabled
 * the cleanup that keeps the previous user's documents out of their session.
 * Turning a feature off must never turn a safeguard off with it.
 *
 * `useOfflineResync(enabled)` is the feature, and stays gated: no manager, no
 * timers, no `online` listener while the switch is off.
 *
 * Both hang off `Layout`, the authenticated shell — it mounts once, before any
 * page route can render, and it already renders `OfflineIndicator`. That gives
 * the right lifetime (never on login, share or PDF-render routes; stops when
 * the session ends) at a cost of **no change to `layout.tsx` at all**.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { IPage } from "@/features/page/types/page.types";
import type { ICurrentUser } from "@/features/user/types/user.types";
import { reconcileOfflineDataOwnership } from "./data-ownership";
import { setDirtyPageLinkResolver } from "./dirty-page-link";
import { createResyncManager, type ResyncManager } from "./resync-manager";
import { resetResyncState } from "./resync-state";
import { clearPendingRecovery, rememberOfflineDataOwner } from "./session-expiry";

/**
 * Settle whose offline data is on this disk, before anything can read it.
 *
 * Unconditional, and the *only* thing that opens the readers: until this
 * resolves, `offlineDataIsOurs()` is false and both the editing gate and the
 * resync manager refuse. Erasing on mismatch and refusing until proof are two
 * halves of one answer — the audit showed that either alone has holes.
 *
 * The current user is read from the query cache rather than a hook so that a
 * cache restored from disk counts: an offline boot must be able to settle
 * ownership too.
 */
export function useOfflineDataOwnership(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const userId = queryClient.getQueryData<ICurrentUser>(["currentUser"])?.user
      ?.id;
    if (!userId) return;

    // The hint the 401 handler will read. Recorded unconditionally, because a
    // session whose owner was never recorded is a session whose work cannot be
    // preserved at all (`session-expiry.ts` refuses rather than guessing).
    rememberOfflineDataOwner(userId);

    void reconcileOfflineDataOwnership(userId).then((outcome) => {
      // The login-page notice has done its job once the owner is settled. It is
      // deliberately consumed *here* and not used as the trigger for anything:
      // treating "the notice is gone" as "the data is settled" was one of the
      // three ways the leak was reached.
      if (outcome !== "deferred") clearPendingRecovery();
    });
  }, [queryClient]);
}

/**
 * Guards against a second manager if the shell is ever mounted twice (React
 * StrictMode double-invokes effects in development, and a future route change
 * could remount `Layout`). Two managers in one tab would not corrupt anything —
 * the Web Lock is per-origin, so the second would simply decline — but they
 * would fight over the shared state store.
 */
let manager: ResyncManager | null = null;
let refCount = 0;

/**
 * `enabled` is the offline-editing switch. Gating the manager's *existence* on
 * it, rather than letting each pass check it, is what keeps phase 2's promise
 * that "switch off" means no timers and no listeners. The switch is reactive,
 * so turning it on starts the loop without a reload.
 */
export function useOfflineResync(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    setDirtyPageLinkResolver((pageId) =>
      queryClient.getQueryData<IPage>(["pages", pageId]),
    );
    return () => setDirtyPageLinkResolver(null);
  }, [queryClient, enabled]);

  useEffect(() => {
    if (!enabled) return;
    refCount += 1;
    manager ??= createResyncManager();
    return () => {
      refCount -= 1;
      if (refCount > 0) return;
      manager?.stop();
      manager = null;
      resetResyncState();
    };
  }, [enabled]);
}
