/**
 * What phase 3 tells the user, held outside React.
 *
 * The manager is a per-tab singleton started from a hook but running on window
 * events and timers, so it has no React context to write through — the same
 * situation `offline-edit-state.ts` is in, solved the same way and for the same
 * reason (one store, `useSyncExternalStore`, snapshots compared by reference).
 *
 * `lastPass` exists so the success toast fires exactly once per pass. A toast
 * is an *event*, and deriving one from a state change needs something that
 * changes identity exactly when the event happens; a counter of pushed pages
 * would fire again on the next unrelated re-render.
 */

import { useSyncExternalStore } from "react";
import type { DirtyPageRecord } from "./dirty-pages";
import type { UploadOutboxRecord } from "./upload-outbox";

export interface ResyncPassResult {
  at: number;
  /** Pages pushed to the server in this pass. */
  synced: number;
  /** Pages the server refused in this pass. */
  blocked: number;
}

export interface ResyncState {
  phase: "idle" | "syncing";
  /** Pages this pass set out to push. */
  total: number;
  /** Pages this pass has finished with, successfully or not. */
  completed: number;
  /** Every entry the registry currently holds as blocked, oldest first. */
  blocked: readonly DirtyPageRecord[];
  /** Phase 4: uploads waiting in the outbox (pending, not yet on the server). */
  pendingUploads: number;
  /** Phase 4: outbox entries the server refused, oldest first. */
  blockedUploads: readonly UploadOutboxRecord[];
  lastPass: ResyncPassResult | null;
}

const EMPTY: ResyncState = {
  phase: "idle",
  total: 0,
  completed: 0,
  blocked: [],
  pendingUploads: 0,
  blockedUploads: [],
  lastPass: null,
};

let state: ResyncState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setResyncState(next: Partial<ResyncState>): void {
  const merged = { ...state, ...next };
  if (
    merged.phase === state.phase &&
    merged.total === state.total &&
    merged.completed === state.completed &&
    merged.blocked === state.blocked &&
    merged.pendingUploads === state.pendingUploads &&
    merged.blockedUploads === state.blockedUploads &&
    merged.lastPass === state.lastPass
  ) {
    return;
  }
  state = merged;
  emit();
}

export function getResyncState(): ResyncState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useResyncState(): ResyncState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

/** Test seam, and what the manager does when it stops. */
export function resetResyncState(): void {
  state = EMPTY;
  emit();
}
