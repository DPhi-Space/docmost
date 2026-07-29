/**
 * Reactive `navigator.onLine`.
 *
 * `useSyncExternalStore` rather than `useState` + effects: the browser can flip
 * connectivity between render and effect, and the store form makes the
 * subscription the single source of truth instead of a copy that can drift.
 *
 * `navigator.onLine === false` is trustworthy (the OS says there is no route);
 * `true` only means an interface exists, so this is a hint for the UI, never a
 * precondition for a request. React Query reaches the same conclusion through
 * its own online manager.
 */

import { useSyncExternalStore } from "react";

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

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
