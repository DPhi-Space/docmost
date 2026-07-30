/**
 * Ask the browser not to evict this origin's storage (`navigator.storage
 * .persist()`), because since phases 2–4 IndexedDB can hold the **only** copy
 * of a user's work: offline page edits (`page.*` databases), the dirty
 * registry, and now whole attachment blobs in the upload outbox. "Best effort"
 * storage — the default — may be silently evicted under disk pressure, which
 * for this feature is indistinguishable from data loss.
 *
 * ## Why it is gated on the offline-editing switch, hard
 *
 * Firefox answers `persist()` with a **user-facing permission prompt**. A user
 * who never opted into offline editing must never see a browser dialog asking
 * to "store data in persistent storage" for an app they use online — so the
 * request is made only when the switch is on, checked *inside* this module
 * rather than trusted to call sites (a safeguard a call site can forget is
 * not a safeguard). Chromium grants or denies silently based on engagement
 * heuristics; Safari has no prompt either.
 *
 * ## The verdict is advisory, and what this does NOT protect against
 *
 * A denial changes nothing about behaviour: the feature keeps working on
 * best-effort storage, the verdict is logged and surfaced quietly in the
 * preference UI, and nothing retries on a schedule (the next boot with the
 * switch on asks again, which is enough — browsers change their answer with
 * site engagement). Even `persisted: true` protects only against *automatic
 * eviction under storage pressure*: the user clearing site data, private
 * browsing windows, and "delete cookies on close" policies all still erase
 * everything, and no API prevents that.
 */

import { useSyncExternalStore } from "react";
import { isOfflineEditingEnabled } from "./offline-editing-settings";

export type DurableStorageVerdict =
  /** The browser will not auto-evict this origin's storage. */
  | "granted"
  /** Asked and refused; offline data stays best-effort. */
  | "denied"
  /** No `navigator.storage.persist` in this browser. */
  | "unsupported"
  /** Never asked (switch off, or not yet requested this session). */
  | "unknown";

/** The slice of `navigator.storage` used; injected in tests. */
export interface StorageManagerLike {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

export interface DurableStorageDeps {
  storageManager: StorageManagerLike | null;
  isEnabled: () => boolean;
  log: (message: string) => void;
}

function defaultDeps(): DurableStorageDeps {
  const manager = (globalThis.navigator as Navigator | undefined)?.storage;
  return {
    storageManager:
      manager && typeof manager.persist === "function" ? manager : null,
    isEnabled: isOfflineEditingEnabled,
    log: (message) => console.info(`[docmost] ${message}`),
  };
}

let verdict: DurableStorageVerdict = "unknown";
const listeners = new Set<() => void>();

function publish(next: DurableStorageVerdict): void {
  if (next === verdict) return;
  verdict = next;
  for (const listener of listeners) listener();
}

/**
 * Request durable storage. Safe to call opportunistically: it no-ops with the
 * switch off, never throws, and never prompts twice in a session for an
 * already-answered question (`persisted()` is consulted first, and a granted
 * origin stays granted).
 */
export async function requestDurableStorage(
  deps: DurableStorageDeps = defaultDeps(),
): Promise<DurableStorageVerdict> {
  // The hard gate: with the switch off there is nothing worth a permission
  // prompt, so the API is not even consulted.
  if (!deps.isEnabled()) return verdict;

  if (!deps.storageManager) {
    publish("unsupported");
    return verdict;
  }

  try {
    if (await deps.storageManager.persisted()) {
      publish("granted");
      return verdict;
    }
    const granted = await deps.storageManager.persist();
    publish(granted ? "granted" : "denied");
    deps.log(
      granted
        ? "durable storage granted — offline data is safe from auto-eviction"
        : "durable storage denied — offline data may be evicted under storage pressure",
    );
  } catch {
    // An API that throws answers nothing; keep whatever we knew.
  }
  return verdict;
}

export function getDurableStorageVerdict(): DurableStorageVerdict {
  return verdict;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For the preference UI's quiet denial note. */
export function useDurableStorageVerdict(): DurableStorageVerdict {
  return useSyncExternalStore(
    subscribe,
    getDurableStorageVerdict,
    () => "unknown" as const,
  );
}

/** Test seam: module state must be resettable between cases. */
export function resetDurableStorageForTests(): void {
  verdict = "unknown";
  listeners.clear();
}
