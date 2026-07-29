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
 * Phase 3 (#20) hangs its dirty-page registry off this hook, exactly as
 * anticipated: the tick below already holds the provider instance and knows
 * whether the page is syncing, so background sync needs **no further change to
 * `page-editor.tsx`**. Three things were added here and nowhere else:
 *
 * - the document is claimed in `open-page-registry.ts` while this hook is
 *   mounted, which is what stops the resync manager from ever opening a second
 *   provider on the same `documentName`;
 * - edits made while this page's provider is not connected are recorded in the
 *   dirty registry (`dirty-tracking.ts` explains the origin filter);
 * - the registry entry is dropped the moment a real handshake drains the
 *   unsynced-changes counter — the "genuine sync" the issue asks for, and the
 *   same signal the dropped-write detector below already samples.
 */

import { useEffect, useRef, useState } from "react";
import { WebSocketStatus } from "@hocuspocus/provider";
import { useOnlineStatus } from "./online-state";
import { useOfflineEditingEnabled } from "./offline-editing-settings";
import { hasPageRemoteSynced, markPageRemoteSynced } from "./sync-markers";
import { clearDirtyPage, recordDirtyPage } from "./dirty-pages";
import { hasDocContent, type ContentBearingDoc } from "./doc-content";
import { useOfflineDataIsOurs } from "./data-ownership";
import { resolveDirtyPageLink } from "./dirty-page-link";
import { trackDirtyEdits, type DocUpdateSource } from "./dirty-tracking";
import { claimOpenPage, releaseOpenPage } from "./open-page-registry";
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
  /**
   * The document the editor would bind to actually holds something
   * (`doc-content.ts`).
   *
   * `isLocalSynced` alone is not this. y-indexeddb reports "synced" for an
   * empty database exactly as it does for a populated one, and the marker that
   * satisfies `hasSyncedBefore` lives in a *different* IndexedDB database, so
   * the two can disagree — delete just `page.<pageId>` and the marker survives.
   * Without this term the gate opened a live, editable, **blank** editor
   * claiming the user's changes were saved locally.
   */
  hasLocalContent: boolean;
  /**
   * The offline data on this disk is provably the signed-in user's
   * (`data-ownership.ts`).
   *
   * Defaults to false and stays false until reconciliation proves otherwise, so
   * a browser holding a previous user's preserved documents cannot open one in
   * a live editor while the cleanup is still deciding. A cleanup hook that
   * *must* run is exactly what failed three ways in the audit; this term is the
   * reader refusing on its own account.
   */
  offlineDataIsOurs: boolean;
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
    input.hasLocalContent &&
    input.offlineDataIsOurs &&
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
  /**
   * The Yjs document — read for dirty tracking and for the emptiness check.
   * Optional so a test can supply only what it is asking about; a bundle
   * without it can never open the gate, since `hasDocContent(undefined)` is
   * false.
   */
  readonly document?: DocUpdateSource & ContentBearingDoc;
}

/**
 * The bundle `page-editor.tsx` keeps in `providersRef`.
 *
 * `pageId` is the important field. Everything this hook does — writing a sync
 * marker, recording a dirty page, clearing one — is a statement *about a
 * specific page*, made from a provider read out of a mutable ref. Carrying the
 * provenance in the bundle turns "is this the right provider?" from an
 * assumption about React's scheduling into a comparison this file can make and
 * a test can break.
 *
 * `local` is needed purely as an update *origin* to exclude (the y-indexeddb
 * replay); it is never called.
 */
export interface PageProviders {
  /** The page these providers were constructed for (`page-editor.tsx:140`). */
  pageId?: string;
  remote: RemoteSyncSource;
  local?: unknown;
}

export interface UseOfflineEditGateInput {
  pageId: string;
  /**
   * `page-editor.tsx`'s `providersRef` itself, not `providersRef.current`.
   *
   * The ref is the only always-current handle on the provider: the effect that
   * builds the providers runs *after* the render that calls this hook, so a
   * value captured during render is null on the first pass and can be stale
   * afterwards. Reading through the ref inside the timer is what makes it
   * current.
   *
   * A previous, *destroyed* provider still reports `synced === true`, so acting
   * on the wrong one would write a sync marker for a page the server never
   * acknowledged. Earlier revisions of this comment justified the ref by
   * asserting that `PageEditor` is not remounted across navigation. **That is
   * false** — `pages/page/page.tsx:169` puts `key={page.id}` on the memoized
   * editor, so it is remounted per page — and the code was in fact safe only
   * because of React's declaration-order effect execution across two files.
   * That is not an invariant worth depending on, so the bundle now carries its
   * own `pageId` and everything below refuses to act unless it matches.
   */
  providers: { current: PageProviders | null } | null;
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
  const offlineDataIsOurs = useOfflineDataIsOurs();

  /**
   * Held as "which page is known synced" rather than as a boolean, for the same
   * reason the provider is read through a ref: a boolean would survive a route
   * change and hand a never-synced page the previous page's permission, which
   * is the one mistake this gate exists to prevent.
   */
  const [syncedPageId, setSyncedPageId] = useState<string | null>(null);
  const hasSyncedBefore = syncedPageId === pageId;
  /**
   * Which page the timer last saw a **populated** document for. Same
   * page-scoped shape, same reason: a boolean would let one page's content
   * vouch for the next page's empty shell.
   */
  const [populatedPageId, setPopulatedPageId] = useState<string | null>(null);
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
    hasLocalContent: populatedPageId === pageId,
    offlineDataIsOurs,
    isOnline,
  });

  useEffect(() => {
    setOfflineEditingActive(canEditOffline);
  }, [canEditOffline]);

  /**
   * Tell the resync manager which document is taken.
   *
   * Unconditional — not gated on the switch — because it is a statement of
   * fact about this tab rather than a behaviour, and because a claim that is
   * missing is far worse than one that is redundant: the manager would open a
   * second provider on a document the editor already holds. Released only if
   * the claim is still ours (see `open-page-registry.ts`).
   */
  useEffect(() => {
    claimOpenPage(pageId);
    return () => releaseOpenPage(pageId);
  }, [pageId]);

  /**
   * Whether the registry may still hold an entry for this page.
   *
   * Starts true on every page change so an entry left by an earlier session —
   * or by another tab — is cleared the first time this page syncs cleanly, and
   * is set again by each recorded edit. Without it the tick would issue an
   * IndexedDB delete every second for the life of the page.
   */
  const maybeDirtyRef = useRef(true);
  const isConnectedRef = useRef(isConnected);
  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  /** The dirty-edit subscription, which follows the provider, not the render. */
  const trackingRef = useRef<{ pageId: string; stop: () => void } | null>(null);
  useEffect(() => {
    maybeDirtyRef.current = true;
    return () => {
      trackingRef.current?.stop();
      trackingRef.current = null;
    };
  }, [pageId, featureEnabled]);

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
      const bundle = providers?.current;
      const provider = bundle?.remote;
      if (!provider) return;

      /**
       * Provenance, checked rather than assumed.
       *
       * Every write below names `pageId`, but the *evidence* for it comes from
       * whatever the ref happens to hold. If the two disagree — a bundle not
       * yet swapped, or one already replaced — the honest answer is to do
       * nothing this tick and try again in a second. `pageId` is undefined only
       * for a caller that predates this field, and such a caller has no
       * provenance to offer, so it is refused too.
       */
      if (bundle.pageId !== pageId) return;

      // Attached from the tick rather than from an effect because the effect
      // that creates the providers runs after this hook's, so there is no
      // render that reliably coincides with a live provider for this page.
      if (trackingRef.current?.pageId !== pageId && provider.document) {
        trackingRef.current?.stop();
        trackingRef.current = {
          pageId,
          stop: trackDirtyEdits({
            doc: provider.document,
            ignoredOrigins: () => [
              providers?.current?.local,
              providers?.current?.remote,
            ],
            isConnected: () => isConnectedRef.current,
            onDirty: () => {
              maybeDirtyRef.current = true;
              void recordDirtyPage(pageId, resolveDirtyPageLink(pageId));
            },
          }),
        };
      }

      // Sampled here, next to the provenance check, because this is the only
      // place the *actual document the editor would bind to* is in hand. A
      // marker on its own cannot answer it: it lives in another database.
      if (isLocalSynced && hasDocContent(provider.document)) {
        setPopulatedPageId(pageId);
      }

      const hasLiveSync = isConnected && provider.synced;
      if (hasLiveSync) {
        // A page that syncs is, by definition, available again.
        clearPageUnavailable(pageId);
        // A completed handshake with nothing outstanding is the "genuine
        // remote sync" the registry is cleared on — the same evidence
        // `resync-page.ts` requires of a background push, so the open page and
        // a background page are held to one standard.
        if (provider.unsyncedChanges === 0 && maybeDirtyRef.current) {
          maybeDirtyRef.current = false;
          void clearDirtyPage(pageId);
        }
        if (markedRef.current !== pageId) {
          // Once per page per mount: the timer runs every second and the marker
          // is write-once, so re-asking the disk would be pure overhead.
          markedRef.current = pageId;
          setSyncedPageId(pageId);
          void markPageRemoteSynced(pageId);
        }
      }
      const wasWarned = stateRef.current.warned;
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

      /**
       * Register the page the moment the server is shown to be refusing its
       * writes.
       *
       * `dirty-tracking.ts` only records edits made while the provider is
       * *disconnected*, but this is the other shape of unpushed work: a live,
       * synced connection the server answers with `SyncStatus(false)`. Those
       * edits were never in the registry, so a later session expiry would not
       * know to preserve them — and would delete exactly the edits the banner
       * above them promises are safe on this device.
       */
      if (!wasWarned && stateRef.current.warned) {
        maybeDirtyRef.current = true;
        void recordDirtyPage(pageId, resolveDirtyPageLink(pageId)).then(
          (recorded) => {
            if (!recorded) {
              // Not swallowed: the user is being told their edits are safe
              // here, and this is the one place that can know the index of
              // them was not written.
              console.warn(
                `[docmost] offline: could not register unsaved changes for page ${pageId}`,
              );
            }
          },
        );
      }
    };

    tick();
    const interval = setInterval(tick, UNSYNCED_POLL_MS);
    return () => clearInterval(interval);
    // `isLocalSynced` is a dependency so the content check runs the instant
    // y-indexeddb finishes, rather than up to a second later.
  }, [pageId, featureEnabled, providers, isConnected, isLocalSynced]);

  useEffect(
    () => () => {
      setOfflineEditingActive(false);
      setUnsyncedChangesWarning(false);
    },
    [],
  );

  return { canEditOffline };
}
