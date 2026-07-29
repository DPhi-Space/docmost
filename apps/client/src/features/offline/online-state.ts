/**
 * Reconciling "is this browser online" between the browser, React Query and the
 * UI. Two consumers, one subject.
 *
 * `navigator.onLine === false` is trustworthy (the OS says there is no route);
 * `true` only means an interface exists, so this is a hint, never a
 * precondition for a request.
 */

import { useSyncExternalStore } from "react";
import { onlineManager } from "@tanstack/react-query";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function getSnapshot(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/** Server snapshot: assume online so nothing renders an offline state in SSR. */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * `useSyncExternalStore` rather than `useState` + effects: the browser can flip
 * connectivity between render and effect, and the store form makes the
 * subscription the single source of truth instead of a copy that can drift.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The slice of React Query's `onlineManager` this module drives. */
export interface OnlineManagerLike {
  setOnline(online: boolean): void;
}

/**
 * Tell React Query the truth about connectivity **at boot**.
 *
 * `OnlineManager` starts at `online = true` and only ever changes on `online` /
 * `offline` window events — it never reads `navigator.onLine`. A tab loaded
 * while already offline therefore never receives an `offline` event, so React
 * Query believes it is online and, instead of pausing fetches
 * (`networkMode: "online"`), runs every query straight into a network error.
 *
 * That single default is what stands between a persisted cache and a usable
 * offline app. Left alone it does two kinds of damage, both observed in a real
 * browser before this existed:
 *
 * 1. every restored query is refetched, fails, and flips to `error`, so the app
 *    renders "Error fetching page data." on top of a perfectly good cache;
 * 2. the now-errored cache is dehydrated over the good one — only successful
 *    queries are persisted — so each offline reload *erases* more of the store.
 *
 * Seeding it once at startup fixes both: fetches park as `paused`, restored data
 * keeps `status: "success"`, and the window `online` event resumes everything.
 *
 * Only ever sets `false`. `true` is already the default, and forcing it would
 * risk overwriting a genuine `offline` event that arrived first.
 */
export function seedQueryOnlineState(
  manager: OnlineManagerLike = onlineManager,
  nav: { onLine: boolean } | undefined = globalThis.navigator,
): void {
  if (nav?.onLine === false) manager.setOnline(false);
}
