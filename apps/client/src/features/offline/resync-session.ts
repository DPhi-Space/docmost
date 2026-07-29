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
): Promise<ResyncSession> {
  const documentName = pageDocumentName(pageId);
  const ydoc = new Y.Doc();

  let local: IndexeddbPersistence | undefined;
  let socket: HocuspocusProviderWebsocket | undefined;
  let remote: HocuspocusProvider | undefined;

  try {
    let localSynced = false;
    let connected = false;
    let authenticationFailed = false;

    local = new IndexeddbPersistence(documentName, ydoc);
    local.on("synced", () => {
      localSynced = true;
    });

    socket = new HocuspocusProviderWebsocket({ url: getCollaborationUrl() });

    remote = new HocuspocusProvider({
      websocketProvider: socket,
      name: documentName,
      document: ydoc,
      token,
      onStatus: (event: onStatusParameters) => {
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
