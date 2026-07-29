/**
 * A short-lived collaboration session for a page nobody is looking at.
 *
 * This is the only file in phase 3 that constructs Yjs and Hocuspocus objects,
 * and it is a **transcription** of `page-editor.tsx:138-212`, not a design:
 * same document name, same construction order (`Y.Doc` → `IndexeddbPersistence`
 * → `HocuspocusProviderWebsocket` → `HocuspocusProvider` → `attach()`), same
 * teardown order (socket, provider, persistence). The fork is pinned to
 * v0.95.0 precisely because upstream's rewrite of that lifecycle lost content
 * (docmost#2353, see AGENTS.md); inventing a second lifecycle here would
 * reintroduce the risk the pin exists to remove, in a code path with no user
 * watching it.
 *
 * The one addition is `ydoc.destroy()` after the persistence, which
 * `page-editor.tsx` has no need for — its document dies with the component,
 * whereas a background loop that opens one per page per pass would accumulate
 * them for the life of the tab. It runs last, after `local.destroy()` has
 * already removed its own `doc.on("destroy")` handler, so nothing is torn down
 * twice.
 *
 * Nothing here reads or writes the document's content. The offline edits are
 * pushed by the sync protocol itself: the client answers the server's SyncStep1
 * with a SyncStep2 carrying everything the server lacks. That is the same
 * mechanism that pushes them today when the user re-opens the page — this file
 * only removes the requirement that they do.
 *
 * ## Why the constructors are injectable
 *
 * They are reached through a `ResyncSessionDeps` bundle whose default is the
 * four real classes, so the production path is unchanged. The point is that
 * this file was the riskiest on the branch and had **no coverage at all**: a
 * WebSocket and an IndexedDB connection cannot be had in jsdom, so the only way
 * to pin the ordering, the teardown and the sample mapping — which is where the
 * risk actually lives — is to be able to stand in for them.
 */

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
  type onStatusParameters,
} from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { getCollaborationUrl } from "@/lib/config";
import type { ResyncSession } from "./resync-page";

/** Mirrors `page-editor.tsx:140`; also the y-indexeddb database name. */
export function pageDocumentName(pageId: string): string {
  return `page.${pageId}`;
}

/** The Yjs document, as this file uses it: created, passed along, destroyed. */
export interface SessionDoc {
  destroy(): void;
}

export interface SessionPersistence {
  /** y-indexeddb sets this once the stored document has been replayed. */
  readonly synced: boolean;
  on(event: "synced", handler: () => void): void;
  destroy(): void;
}

export interface SessionSocket {
  destroy(): void;
}

export interface SessionProvider {
  readonly synced: boolean;
  readonly unsyncedChanges: number;
  attach(): void;
  destroy(): void;
}

export interface SessionProviderConfig {
  websocketProvider: SessionSocket;
  name: string;
  document: SessionDoc;
  token: string;
  onStatus(event: { status: string }): void;
  onAuthenticationFailed(): void;
}

export interface ResyncSessionDeps {
  createDoc(): SessionDoc;
  createPersistence(name: string, doc: SessionDoc): SessionPersistence;
  createSocket(url: string): SessionSocket;
  createProvider(config: SessionProviderConfig): SessionProvider;
  collaborationUrl(): string;
}

/**
 * The real classes, in the order and with the arguments `page-editor.tsx` uses.
 * The casts are at the boundary only: the structural interfaces above describe
 * a subset of each class, and every object handed across is the genuine one.
 */
export const realSessionDeps: ResyncSessionDeps = {
  createDoc: () => new Y.Doc(),
  createPersistence: (name, doc) =>
    new IndexeddbPersistence(name, doc as Y.Doc),
  createSocket: (url) => new HocuspocusProviderWebsocket({ url }),
  createProvider: (config) =>
    new HocuspocusProvider({
      websocketProvider: config.websocketProvider as HocuspocusProviderWebsocket,
      name: config.name,
      document: config.document as Y.Doc,
      token: config.token,
      onStatus: (event: onStatusParameters) =>
        config.onStatus({ status: event.status }),
      onAuthenticationFailed: config.onAuthenticationFailed,
    }),
  collaborationUrl: getCollaborationUrl,
};

/**
 * Open a session for `pageId`, authenticated with `token`.
 *
 * Rejects only if construction itself fails (a browser with no IndexedDB, a
 * malformed collaboration URL); a session that simply cannot reach the server
 * resolves normally and reports it through `sample()`, because "unreachable"
 * is a retry and "unopenable" is not something a retry would fix any faster.
 */
export async function openResyncSession(
  pageId: string,
  token: string,
  deps: ResyncSessionDeps = realSessionDeps,
): Promise<ResyncSession> {
  const documentName = pageDocumentName(pageId);
  const ydoc = deps.createDoc();

  let local: SessionPersistence | undefined;
  let socket: SessionSocket | undefined;
  let remote: SessionProvider | undefined;

  try {
    let localSynced = false;
    let connected = false;
    let authenticationFailed = false;

    local = deps.createPersistence(documentName, ydoc);
    local.on("synced", () => {
      localSynced = true;
    });

    socket = deps.createSocket(deps.collaborationUrl());

    remote = deps.createProvider({
      websocketProvider: socket,
      name: documentName,
      document: ydoc,
      token,
      onStatus: (event) => {
        connected = event.status === WebSocketStatus.Connected;
      },
      // No refetch-and-reconnect dance here, unlike the editor's handler: the
      // manager holds one token for the whole pass and a failure is answered
      // by `resync-page.ts`, which can tell "the token is stale" from "this
      // page is gone" and either retries the whole page later or reports it.
      onAuthenticationFailed: () => {
        authenticationFailed = true;
      },
    });

    // Same call, same reason as `page-editor.tsx:237` — the provider does not
    // manage its own socket when one is supplied, so nothing connects until it
    // is attached.
    remote.attach();

    const provider = remote;
    const persistence = local;
    const websocket = socket;

    return {
      sample: () => ({
        // Either signal will do: the event may have fired before this closure
        // existed, in which case the flag on the instance is the record of it.
        localSynced: localSynced || persistence.synced,
        connected,
        synced: provider.synced,
        unsyncedChanges: provider.unsyncedChanges,
        authenticationFailed,
      }),
      destroy: () => {
        websocket.destroy();
        provider.destroy();
        persistence.destroy();
        ydoc.destroy();
      },
    };
  } catch (error) {
    // Partial construction must not leak a socket or an open database.
    try {
      socket?.destroy();
      remote?.destroy();
      local?.destroy();
      ydoc.destroy();
    } catch {
      /* nothing useful left to do */
    }
    throw error;
  }
}
