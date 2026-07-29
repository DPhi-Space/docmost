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
import { getMyInfo } from "@/features/user/services/user-service";
import { reconcileOfflineDataOwnership } from "./data-ownership";
import { setDirtyPageLinkResolver } from "./dirty-page-link";
import { createResyncManager, type ResyncManager } from "./resync-manager";
import { resetResyncState } from "./resync-state";
import { clearPendingRecovery, rememberOfflineDataOwner } from "./session-expiry";

/**
 * Who is *actually* signed in, asked of the server.
 *
 * **The cached user is not proof of identity.** Phase 1b persists
 * `["currentUser"]` to disk and `UserProvider` renders from it immediately —
 * which is what makes the app usable offline, and exactly why it cannot settle
 * ownership. The audit's third leak trigger survived a first attempt at this
 * fix for that reason: the next user signed in, the app booted holding the
 * *previous* user's identity in a restored cache, and the mismatch was never
 * seen. Nor can the fix be "wait for the app to refetch": the app's defaults
 * are `refetchOnMount: false` with a five-minute `staleTime`, and a browser run
 * confirmed `/users/me` is **not** requested at all on a boot with a warm
 * cache.
 *
 * So this asks, once per authenticated mount, with a **direct service call**.
 * Deliberately not `queryClient.fetchQuery(["currentUser"])`: that rewrites the
 * shared query's options, and a first attempt using it with `staleTime: 0` set
 * the app refetching `/users/me` and `/auth/collab-token` in a loop — six and
 * seven times in a sixty-second window in a browser run — which broke the very
 * recovery this is meant to protect. Ownership is this module's question and it
 * asks it on its own behalf.
 *
 * A 401 answer routes into the ordinary session-expiry path, which is correct:
 * the session really has ended.
 *
 * With no network, the cached user is used: signing in requires the server, so
 * nobody can have become a different user since the cache was written.
 */
async function resolveCurrentUserId(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<string | null> {
  const cached = () =>
    queryClient.getQueryData<ICurrentUser>(["currentUser"])?.user?.id ?? null;

  // Asking while offline is pointless and the answer is knowable: nobody can
  // have signed in without the server, so the cached user is the only user.
  if (globalThis.navigator?.onLine === false) return cached();

  try {
    const me = await getMyInfo();
    return me?.user?.id ?? null;
  } catch {
    /**
     * **No fallback to the cache here.** Online, the server is the only
     * authority on who is signed in, and a failed request means "I cannot
     * tell" — which must refuse, not guess. Falling back was observed to guess
     * *wrong* in a browser run: the request lost a race with the new session,
     * the restored cache answered with the previous user, ownership settled as
     * "ours", and the resync manager pushed that user's document under the new
     * user's cookie before the second, correct reconcile erased it.
     *
     * Refusing costs nothing here: nothing is erased, the readers stay closed,
     * and the next mount asks again.
     */
    return null;
  }
}

/**
 * Settle whose offline data is on this disk, before anything can read it.
 *
 * Unconditional, and the *only* thing that opens the readers: until this
 * resolves, `offlineDataIsOurs()` is false and both the editing gate and the
 * resync manager refuse. Erasing on mismatch and refusing until proof are two
 * halves of one answer — the audit showed that either alone has holes.
 */
export function useOfflineDataOwnership(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const userId = await resolveCurrentUserId(queryClient);
      if (cancelled) return;

      if (!userId) {
        // Refuse, and keep refusing, until an identity can be established.
        void reconcileOfflineDataOwnership(null);
        return;
      }

      // The hint the 401 handler will read. Recorded unconditionally, because a
      // session whose owner was never recorded is a session whose work cannot
      // be preserved at all (`session-expiry.ts` refuses rather than guessing).
      rememberOfflineDataOwner(userId);

      const outcome = await reconcileOfflineDataOwnership(userId);
      // The login-page notice has done its job once the owner is settled. It is
      // consumed *here* and used as the trigger for nothing: treating "the
      // notice is gone" as "the data is settled" was one of the three ways the
      // leak was reached.
      if (outcome !== "deferred") clearPendingRecovery();
    })();

    return () => {
      cancelled = true;
    };
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
