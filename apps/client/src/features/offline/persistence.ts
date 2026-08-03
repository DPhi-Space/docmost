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
 * boots and renders read-only content instead of a blank screen. The decisions
 * about *what* may be written, and *when*, live entirely in
 * `persistence-policy.ts`.
 */

import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { removeOldestQuery } from "@tanstack/react-query-persist-client";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import type { QueryClient } from "@tanstack/react-query";
import { QUERY_CACHE_KEY, queryCacheStorage } from "./persisted-store";
import { installQueryOnlineManager } from "./online-state";
import { whenServerReachable } from "./reachability";
import {
  isSnapshotWorthPersisting,
  sanitizeRestoredClient,
  shouldDehydrateQuery,
} from "./persistence-policy";

// Runs on import, i.e. before `main.tsx` renders and therefore before the first
// query observer mounts — which is the only moment at which the initial value is
// still useful. See `installQueryOnlineManager` for why it is load-bearing.
installQueryOnlineManager();

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
 * `APP_VERSION` alone is not enough: this fork pins the upstream base, so the
 * package version is `0.95.0` on *every* fork build and a version-only buster
 * never fires — which is how a store written by one deploy survived into the
 * next. `APP_BUILD_ID` (the git SHA, injected at build time; see
 * `vite.config.ts` and the `BUILD_ID` Docker build arg) changes per build and
 * restores the intended behaviour.
 *
 * Both are Vite `define`s, so they are compile-time constants in the app and
 * simply absent under vitest — hence the `typeof` guards, which Vite folds to
 * `typeof "…"` in a real build.
 */
function cacheBuster(): string {
  const version = typeof APP_VERSION === "string" ? APP_VERSION : "dev";
  const buildId = typeof APP_BUILD_ID === "string" ? APP_BUILD_ID : "dev";
  return `${version}+${buildId}`;
}

const storagePersister = createAsyncStoragePersister({
  storage: queryCacheStorage,
  key: QUERY_CACHE_KEY,
  throttleTime: PERSIST_THROTTLE_MS,
  // A cache holding many pages can outgrow the origin's quota. Rather than
  // giving up on persistence entirely, drop the least recently updated query and
  // try again — the tail of the cache is the least likely to be wanted offline.
  retry: removeOldestQuery,
  // Heal stores poisoned before the dehydrate-side corruption check existed:
  // a restored infinite query holding a non-object page crashes render before
  // anything can refetch it (see `isCorruptInfiniteData`).
  deserialize: (cached) =>
    sanitizeRestoredClient(JSON.parse(cached)) as PersistedClient,
});

/**
 * Persistence overwrites the store wholesale, so a snapshot taken while the app
 * cannot reach the server would erase a good offline cache. The guard is here
 * rather than in the storage layer because this is the only place that can see
 * what is actually being written.
 */
const persister: Persister = {
  ...storagePersister,
  persistClient: (client: PersistedClient) =>
    isSnapshotWorthPersisting(client)
      ? storagePersister.persistClient(client)
      : undefined,
};

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
 * Invalidating with `refetchType: "active"` fixes that at exactly the right
 * scope: "active" means the queries with a mounted observer, i.e. the ones on
 * screen — those refetch (invalidation overrides `refetchOnMount`), while the
 * long tail of restored-but-unused entries stays on disk costing nothing.
 *
 * The delay is the point: this runs from the restore promise, before React has
 * re-rendered with `isRestoring: false` and therefore before a single observer
 * has mounted. Invalidating then would match nothing at all. Offline it is
 * skipped outright — the fetches would only park as paused.
 *
 * "Offline" is waited for rather than read. At boot the reachability verdict is
 * an optimistic assumption until the first probe answers (`reachability.ts`), and
 * `navigator.onLine` — which this used to read — is exactly the thing that lies
 * about it on a VPN. Invalidating on the assumption is what produced "Error
 * fetching page data." on top of a good cache, so this waits for the real
 * verdict; the wait is bounded by the probe's own timeout and, on a working
 * network, is shorter than the delay it runs alongside.
 */
const RESTORE_INVALIDATE_DELAY_MS = 500;

export function onQueryCacheRestored(queryClient: QueryClient): void {
  void (async () => {
    const [reachable] = await Promise.all([
      whenServerReachable(),
      new Promise((resolve) => setTimeout(resolve, RESTORE_INVALIDATE_DELAY_MS)),
    ]);
    if (!reachable) return;
    void queryClient.invalidateQueries({ refetchType: "active" });
  })();
}
