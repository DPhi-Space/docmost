/**
 * Where the background sync loop is started, and why it is here.
 *
 * The manager is a per-tab singleton with no React state of its own, so it
 * needs one owner whose lifetime matches "an authenticated session in this
 * tab". `Layout` is exactly that — it is the authenticated shell, it mounts
 * once, and it already renders `OfflineIndicator`. Hanging the manager off that
 * component means:
 *
 * - it never runs on the login, share or PDF-render routes, which have no
 *   session and no collaboration token to fetch;
 * - it stops when the session ends, because logout unmounts the shell;
 * - **`layout.tsx` needs no change at all.** Phase 1a/1b/2 spent their upstream
 *   diff budget on `main.tsx`, `vite.config.ts` and `page-editor.tsx`; phase 3
 *   spends none, which is worth more than the tidiness of a dedicated
 *   provider component.
 *
 * The hook also installs the dirty-registry link resolver, because this is the
 * innermost place that has both a `QueryClient` and no test-time cost to the
 * modules that record dirty pages (see `dirty-page-link.ts`).
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { IPage } from "@/features/page/types/page.types";
import { setDirtyPageLinkResolver } from "./dirty-page-link";
import { createResyncManager, type ResyncManager } from "./resync-manager";
import { resetResyncState } from "./resync-state";

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
 * that "switch off" means no timers, no listeners and no new behaviour at all.
 * The switch is reactive, so turning it on starts the loop without a reload.
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
