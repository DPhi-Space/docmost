/**
 * The state phase 2 shares between the editor and the UI that explains it.
 *
 * A small external store rather than jotai atoms, matching this feature's other
 * cross-cutting state (`online-state.ts`, `offline-editing-settings.ts`). Two of
 * the three facts are written from a React effect, but the third — "the server
 * refused this page" — is written from `page-editor.tsx`'s
 * `onAuthenticationFailed`, a plain provider callback with no React context, so
 * the store has to be writable imperatively either way.
 *
 * One `PageEditor` is mounted at a time, so page-scoped facts can live in
 * module scope without ambiguity; `pageUnavailable` still carries the page id so
 * a stale report cannot be shown against a page the user has navigated to since.
 *
 * The banner that renders all of this lives in `full-editor.tsx`, not in
 * `page-editor.tsx`: keeping the collaboration-adjacent file free of UI is part
 * of what holds its diff to the ~24 lines AGENTS.md commits to re-applying by
 * hand.
 */

import { useSyncExternalStore } from "react";

export interface OfflineEditState {
  /** The live editor is open with no connection behind it. */
  offlineEditingActive: boolean;
  /**
   * The server accepted the connection and then discarded our updates — a
   * locked, trashed or newly-restricted page. See `unsynced-changes.ts`.
   */
  unsyncedChangesWarning: boolean;
  /**
   * The page whose collaboration authentication failed for a reason that is
   * *not* an expired token: hard-deleted, or access revoked outright.
   *
   * Before phase 2, `page-editor.tsx` called `jwtDecode(collabQuery?.token)` on
   * a possibly undefined token (it throws `Invalid token specified`) and, when
   * the token decoded and was valid, ignored the failure in silence.
   */
  unavailablePageId: string | null;
}

const EMPTY: OfflineEditState = {
  offlineEditingActive: false,
  unsyncedChangesWarning: false,
  unavailablePageId: null,
};

let state: OfflineEditState = EMPTY;
const listeners = new Set<() => void>();

function update(next: Partial<OfflineEditState>): void {
  const merged = { ...state, ...next };
  if (
    merged.offlineEditingActive === state.offlineEditingActive &&
    merged.unsyncedChangesWarning === state.unsyncedChangesWarning &&
    merged.unavailablePageId === state.unavailablePageId
  ) {
    // Identity matters: `useSyncExternalStore` compares snapshots by reference
    // and re-renders — or loops — on a fresh object every time it is polled.
    return;
  }
  state = merged;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOfflineEditState(): OfflineEditState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

export function setOfflineEditingActive(active: boolean): void {
  update({ offlineEditingActive: active });
}

export function setUnsyncedChangesWarning(warned: boolean): void {
  update({ unsyncedChangesWarning: warned });
}

export function reportPageUnavailable(pageId: string): void {
  update({ unavailablePageId: pageId });
}

export function clearPageUnavailable(pageId: string): void {
  if (state.unavailablePageId === pageId) update({ unavailablePageId: null });
}

/** Test seam: module state has to be resettable between cases. */
export function resetOfflineEditStateForTests(): void {
  state = EMPTY;
  for (const listener of listeners) listener();
}
