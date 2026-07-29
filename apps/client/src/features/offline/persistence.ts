/**
 * Offline persistence of the React Query cache.
 *
 * `main.tsx` mounts `PersistQueryClientProvider` with {@link offlinePersistOptions}
 * around the *same* `queryClient` instance it already exported — many modules
 * import that binding directly (`features/page/queries/page-query.ts`,
 * `features/editor/page-editor.tsx`), so the client is wrapped, never replaced.
 *
 * What this buys: after a reload with no network the app still has the user, the
 * workspace, the space, the sidebar tree and every page that was visited, so it
 * boots and renders read-only content instead of a blank screen. The decision of
 * *what* is allowed on disk lives entirely in `query-allowlist.ts`.
 */

import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { removeOldestQuery } from "@tanstack/react-query-persist-client";
import type { QueryClient } from "@tanstack/react-query";
import { QUERY_CACHE_KEY, queryCacheStorage } from "./persisted-store";
import { shouldDehydrateQuery } from "./query-allowlist";

/**
 * How long a dehydrated cache stays usable. Long, because the value of offline
 * mode is exactly that a laptop opened after a fortnight still shows its pages;
 * short enough that an abandoned profile does not keep content forever.
 */
export const QUERY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Coalesce bursts of cache writes (a page load touches dozens of queries). */
const PERSIST_THROTTLE_MS = 1_000;

/**
 * Discard the whole store whenever the client build changes.
 *
 * `APP_VERSION` is a Vite `define`, so it is a compile-time constant in the app
 * and simply absent under vitest — hence the `typeof` guard, which Vite folds to
 * `typeof "0.95.0"` in a real build.
 */
function cacheBuster(): string {
  return typeof APP_VERSION === "string" ? APP_VERSION : "dev";
}

const persister = createAsyncStoragePersister({
  storage: queryCacheStorage,
  key: QUERY_CACHE_KEY,
  throttleTime: PERSIST_THROTTLE_MS,
  // A cache holding many pages can outgrow the origin's quota. Rather than
  // giving up on persistence entirely, drop the least recently updated query and
  // try again — the tail of the cache is the least likely to be wanted offline.
  retry: removeOldestQuery,
});

export const offlinePersistOptions = {
  persister,
  maxAge: QUERY_CACHE_MAX_AGE_MS,
  buster: cacheBuster(),
  dehydrateOptions: { shouldDehydrateQuery },
};

/**
 * Called once the dehydrated cache has been restored into the client.
 *
 * Restoring reintroduces a staleness problem the app did not have before: its
 * global defaults are `refetchOnMount: false` with a 5 minute `staleTime`, which
 * used to be harmless because a reload started from an empty cache. With a
 * persisted cache, a reload would otherwise show yesterday's sidebar and never
 * refresh it.
 *
 * Invalidating with `refetchType: "active"` on the next task fixes that at
 * exactly the right scope: by then the app has mounted, so "active" means the
 * queries actually on screen — those refetch (invalidation overrides
 * `refetchOnMount`), and the long tail of restored-but-unused entries stays on
 * disk costing nothing. Offline, this is skipped entirely: React Query's
 * `networkMode: "online"` would only park the fetches, but skipping keeps the
 * offline boot free of pointless paused queries.
 */
export function onQueryCacheRestored(queryClient: QueryClient): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  setTimeout(() => {
    void queryClient.invalidateQueries({ refetchType: "active" });
  }, 0);
}
