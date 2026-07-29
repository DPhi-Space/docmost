/**
 * The one behavioural change phase 2 makes to the editor, and the invariant that
 * keeps it out of the data-loss regression class.
 *
 * On the base release `page-editor.tsx` shows a *static, read-only* copy of the
 * REST content until the collaboration provider has reported both `Connected`
 * and `synced` at least once; offline that moment never arrives, so a page is
 * permanently read-only. This module widens that gate by exactly one path, and
 * only when every one of the following holds:
 *
 * - the offline-editing switch is on (default off — `offline-editing-settings.ts`);
 * - y-indexeddb has finished loading the document (`isLocalSynced`), so the
 *   editor binds to a populated Yjs document rather than an empty one;
 * - **this page has completed a real remote sync in this browser before**
 *   (`sync-markers.ts`) — the invariant;
 * - the browser reports no network.
 *
 * The last term is not in the issue's stated predicate and is a deliberate
 * addition: it confines every behavioural difference to sessions with no
 * connection at all. With it, an ordinary online session — including the rapid
 * page-switching sequence of the AGENTS.md data-loss reproduction — takes the
 * *same* code path whether the switch is on or off. The cost is that a session
 * which is nominally online but cannot reach the collaboration server (captive
 * portal, blocked WebSocket) stays read-only exactly as it does today. That is
 * the status quo, not a regression; widening it is a follow-up.
 *
 * Nothing here re-closes the gate. `page-editor.tsx` latches `showStatic` to
 * false the first time the gate opens, so reconnecting mid-edit never yanks a
 * live editor out from under the user.
 *
 * Phase 3 (#20) hangs its dirty-page registry off this hook: the tick below
 * already holds the provider instance and knows whether the page is syncing.
 */

import { useEffect, useRef, useState } from "react";
import { WebSocketStatus } from "@hocuspocus/provider";
import { useOnlineStatus } from "./online-state";
import { useOfflineEditingEnabled } from "./offline-editing-settings";
import { hasPageRemoteSynced, markPageRemoteSynced } from "./sync-markers";
import {
  initialUnsyncedState,
  nextUnsyncedState,
  UNSYNCED_GRACE_MS,
  type UnsyncedState,
} from "./unsynced-changes";
import {
  clearPageUnavailable,
  setOfflineEditingActive,
  setUnsyncedChangesWarning,
} from "./offline-edit-state";

/** How often the provider is sampled. */
export const UNSYNCED_POLL_MS = 1_000;

export interface OfflineEditGateInput {
  featureEnabled: boolean;
  isLocalSynced: boolean;
  hasSyncedBefore: boolean;
  isOnline: boolean;
}

/**
 * The safety predicate, kept pure and exported so that every combination which
 * must **not** permit editing is pinned by a table-driven test.
 */
export function canEditWithoutConnection(input: OfflineEditGateInput): boolean {
  return (
    input.featureEnabled &&
    input.isLocalSynced &&
    input.hasSyncedBefore &&
    !input.isOnline
  );
}

/**
 * The slice of `HocuspocusProvider` this module reads. Structural on purpose:
 * the offline feature does not import the collaboration client's types, so an
 * upstream provider swap cannot silently change what is sampled here.
 */
export interface RemoteSyncSource {
  /** Per-instance; false until *this* document completes its handshake. */
  readonly synced: boolean;
  readonly unsyncedChanges: number;
}

export interface UseOfflineEditGateInput {
  pageId: string;
  /**
   * `page-editor.tsx`'s `providersRef` itself, not `providersRef.current`.
   *
   * The ref is the only always-current handle on the provider. `PageEditor` is
   * *not* remounted when the route changes — React reconciles the same element
   * and only the `pageId` prop changes — and the provider effect that swaps the
   * providers does not necessarily trigger a further render, so a value read
   * during render can refer to a provider that has since been destroyed. That
   * matters here more than anywhere else: a destroyed *previous* page's
   * provider still reports `synced === true`, which would write a sync marker
   * for a page the server never acknowledged.
   */
  providers: { current: { remote: RemoteSyncSource } | null } | null;
  /** y-indexeddb finished loading. */
  isLocalSynced: boolean;
  /** `yjsConnectionStatusAtom`. */
  connectionStatus: string;
}

export interface OfflineEditGate {
  /** May the live editor be shown with no live connection? */
  canEditOffline: boolean;
}

export function useOfflineEditGate({
  pageId,
  providers,
  isLocalSynced,
  connectionStatus,
}: UseOfflineEditGateInput): OfflineEditGate {
  const featureEnabled = useOfflineEditingEnabled();
  const isOnline = useOnlineStatus();

  /**
   * Held as "which page is known synced" rather than as a boolean, for the same
   * reason the provider is read through a ref: a boolean would survive a route
   * change and hand a never-synced page the previous page's permission, which
   * is the one mistake this gate exists to prevent.
   */
  const [syncedPageId, setSyncedPageId] = useState<string | null>(null);
  const hasSyncedBefore = syncedPageId === pageId;
  const isConnected = connectionStatus === WebSocketStatus.Connected;

  // Read the marker for this page. Skipped entirely while the switch is off, so
  // a browser that never opts in never opens the marker database at all.
  useEffect(() => {
    if (!featureEnabled) return;
    let cancelled = false;
    void hasPageRemoteSynced(pageId).then((synced) => {
      if (!cancelled && synced) setSyncedPageId(pageId);
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, featureEnabled]);

  const canEditOffline = canEditWithoutConnection({
    featureEnabled,
    isLocalSynced,
    hasSyncedBefore,
    isOnline,
  });

  useEffect(() => {
    setOfflineEditingActive(canEditOffline);
  }, [canEditOffline]);

  // The warning belongs to a page, so it is dropped when the page changes — but
  // *not* when the connection drops (see `nextUnsyncedState`, rule 1).
  const stateRef = useRef<UnsyncedState>(initialUnsyncedState);
  /** Which page the timer below has already written a marker for. */
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    stateRef.current = initialUnsyncedState;
    markedRef.current = null;
    setUnsyncedChangesWarning(false);
  }, [pageId, featureEnabled]);

  /**
   * One timer drives both the sync marker and the dropped-write detector,
   * because both need the provider instance's own view of the handshake and
   * neither can be driven from `page-editor.tsx`'s React state: it keeps
   * `isRemoteSynced` in state it never resets when `pageId` changes, and its
   * `onSynced` handler calls `setIsRemoteSynced(true)` on a value that is often
   * already `true`, so React skips the re-render.
   *
   * See `unsynced-changes.ts` for why the counter is sampled rather than
   * subscribed to.
   */
  useEffect(() => {
    if (!featureEnabled) return;

    const tick = () => {
      const provider = providers?.current?.remote;
      if (!provider) return;

      const hasLiveSync = isConnected && provider.synced;
      if (hasLiveSync) {
        // A page that syncs is, by definition, available again.
        clearPageUnavailable(pageId);
        if (markedRef.current !== pageId) {
          // Once per page per mount: the timer runs every second and the marker
          // is write-once, so re-asking the disk would be pure overhead.
          markedRef.current = pageId;
          setSyncedPageId(pageId);
          void markPageRemoteSynced(pageId);
        }
      }
      stateRef.current = nextUnsyncedState(
        stateRef.current,
        {
          hasLiveSync,
          unsyncedChanges: provider.unsyncedChanges,
          now: Date.now(),
        },
        UNSYNCED_GRACE_MS,
      );
      setUnsyncedChangesWarning(stateRef.current.warned);
    };

    tick();
    const interval = setInterval(tick, UNSYNCED_POLL_MS);
    return () => clearInterval(interval);
  }, [pageId, featureEnabled, providers, isConnected]);

  useEffect(
    () => () => {
      setOfflineEditingActive(false);
      setUnsyncedChangesWarning(false);
    },
    [],
  );

  return { canEditOffline };
}
