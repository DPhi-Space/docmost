/**
 * The offline-editing kill switch.
 *
 * Phase 2 is the only part of the offline work that changes how the *editor*
 * behaves, and it is the only part that touches a collaboration-adjacent file
 * (`features/editor/page-editor.tsx`). It therefore ships behind an explicit,
 * **default-off** switch, mirroring the fork's two-switch philosophy for the MCP
 * write surface (`settings.ai.mcp` turns the endpoint on, `settings.ai.mcpWrite`
 * turns writes on — see AGENTS.md).
 *
 * With the switch off, every side effect this phase introduces is skipped: no
 * sync markers are written, no IndexedDB database is created, no editor gate is
 * widened, no banner renders, and the title editor behaves exactly as it does on
 * the base release. "Off" means "byte-identical to upstream", and that is what
 * makes the phase safe to merge.
 *
 * **localStorage, not the server.** Two reasons, both hard: the fork makes zero
 * `apps/server/` changes in this phase, and a setting that gates *offline*
 * behaviour must be readable when there is no network — a user preference
 * fetched over REST is unavailable on precisely the boot where it matters.
 * The cost is that the switch is per-browser rather than per-account, which is
 * the right granularity anyway: offline capability is a property of the device.
 */

import { useSyncExternalStore } from "react";

export const OFFLINE_EDITING_STORAGE_KEY = "docmost.offline-editing";

/**
 * Broadcast within the document. The `storage` event only fires in *other*
 * tabs, so a same-tab toggle needs its own notification for the settings switch
 * and the editor to agree without a reload.
 */
const CHANGE_EVENT = "docmost:offline-editing-changed";

/** The slice of `Storage` this module uses; injected in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari in private mode, and any embedding that blocks storage access.
    return null;
  }
}

/**
 * Read the switch.
 *
 * Anything other than the exact string `"true"` reads as **off**, including a
 * corrupt value, a missing key and a storage implementation that throws. A
 * feature that widens the editing gate must fail closed.
 */
export function isOfflineEditingEnabled(
  storage: StorageLike | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(OFFLINE_EDITING_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setOfflineEditingEnabled(
  enabled: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    if (enabled) storage?.setItem(OFFLINE_EDITING_STORAGE_KEY, "true");
    else storage?.removeItem(OFFLINE_EDITING_STORAGE_KEY);
  } catch {
    // A browser that refuses to persist the switch simply keeps it off.
  }
  globalThis.dispatchEvent?.(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Subscribe to the switch.
 *
 * `useSyncExternalStore` for the same reason `useOnlineStatus` uses it: the
 * value lives outside React and a copy held in `useState` can drift from it.
 */
export function useOfflineEditingEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOfflineEditingEnabled(),
    () => false,
  );
}
