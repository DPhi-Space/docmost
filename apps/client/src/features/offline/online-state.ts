/**
 * Reconciling "can this app reach its server" between the browser, React Query
 * and the UI. Two consumers, one subject.
 *
 * The subject itself lives in `reachability.ts` — which is a change of meaning,
 * not just of module. This used to read `navigator.onLine` on every render, and
 * `navigator.onLine === true` turned out to be worth nothing: with a VPN
 * configured, both Chrome and Safari keep reporting `true` after Wi-Fi is
 * switched off, because the tunnel's virtual interface is still up. Every
 * consumer below was therefore told the app was online while nothing at all was
 * reachable — the editing gate stayed shut, React Query ran restored queries
 * into errors instead of pausing them, and the resync loop never saw the
 * `online` event that is its reconnect trigger.
 *
 * `false` is still believed outright, and is still consulted live; it is only
 * `true` that now has to be corroborated by something the server said.
 */

import { onlineManager } from "@tanstack/react-query";
import {
  isServerReachable,
  subscribeReachability,
  useServerReachable,
} from "./reachability";

/**
 * Is the server reachable?
 *
 * Named for its consumers rather than its mechanism: `title-editor.tsx`,
 * `offline-indicator.tsx`, `resync-indicator.tsx` and `offline-edit-gate.ts` all
 * ask "are we online", and all four mean "can we reach the server", which is
 * what this now answers.
 */
export function useOnlineStatus(): boolean {
  return useServerReachable();
}

/** The slice of React Query's `onlineManager` this module drives. */
export interface OnlineManagerLike {
  setEventListener(
    setup: (setOnline: (online: boolean) => void) => (() => void) | undefined,
  ): void;
}

/**
 * Tell React Query the truth about connectivity — at boot and from then on.
 *
 * `OnlineManager` starts at `online = true` and, by default, only ever changes
 * on `online` / `offline` window events. It never reads `navigator.onLine`, so a
 * tab loaded while already offline never receives an `offline` event and React
 * Query believes it is online: instead of pausing fetches
 * (`networkMode: "online"`) it runs every restored query straight into a network
 * error. Left alone that does two kinds of damage, both observed in a real
 * browser before this existed:
 *
 * 1. every restored query is refetched, fails, and flips to `error`, so the app
 *    renders "Error fetching page data." on top of a perfectly good cache;
 * 2. the now-errored cache is dehydrated over the good one — only successful
 *    queries are persisted — so each offline reload *erases* more of the store.
 *
 * This replaces the manager's event listener outright rather than seeding a
 * value once, because the events themselves were the other half of the problem:
 * where `navigator.onLine` is stuck at `true`, neither event ever fires, so a
 * seeded value could never be corrected and a reconnect could never be noticed.
 * Driving it from the reachability store fixes both — the initial value is the
 * store's, and every subsequent change is a change the store actually observed.
 *
 * `setEventListener` invokes `setup` immediately, so the seed and the
 * subscription are one call. React Query re-invokes it whenever it acquires its
 * first listener again, which is why `setup` must stay re-entrant.
 */
export function installQueryOnlineManager(
  manager: OnlineManagerLike = onlineManager,
): void {
  manager.setEventListener((setOnline) => {
    setOnline(isServerReachable());
    // Both of these delegate to the current monitor on every call rather than
    // capturing it, so `resetReachabilityForTests` cannot leave React Query
    // subscribed to a dead one.
    return subscribeReachability(() => setOnline(isServerReachable()));
  });
}
