/**
 * Pushing one page's offline edits, and deciding what happened.
 *
 * The mechanics of opening a collaboration session live in
 * `resync-session.ts`; this file is the part with the judgement in it, and it
 * is written against a `ResyncSession` interface so the judgement can be tested
 * without a WebSocket.
 *
 * ## What the provider actually tells us (read out of 3.4.4, not assumed)
 *
 * - `provider.synced` is set to `true` when the **server sends SyncStep2**
 *   (`applySyncMessage`: `if (emitSynced && syncMessageType === messageYjsSyncStep2)`),
 *   not when our writes land. It therefore means "the handshake completed" and
 *   it becomes true even on a connection the server has marked read-only.
 * - `provider.unsyncedChanges` is seeded to exactly 1 by `startSync()`
 *   (`resetUnsyncedChanges`, which *assigns* 1 rather than incrementing, so any
 *   count accumulated while the socket was still opening is discarded), and is
 *   decremented only by `SyncStatus(true)`. There is no `false` branch — see
 *   `unsynced-changes.ts`. So the counter reaching zero is the *only* evidence
 *   the server accepted our updates, and a counter pinned above zero on a
 *   completed handshake is the signature of a read-only connection.
 *
 * The offline edits themselves ride the handshake: the client answers the
 * server's SyncStep1 with a SyncStep2 containing everything the server lacks.
 * That is why waiting for local (y-indexeddb) sync first matters — a handshake
 * that completes before the stored document has been replayed would push an
 * incomplete diff and then have to catch up through a second round.
 *
 * ## The four outcomes
 *
 * | outcome | means | what the manager does |
 * |---|---|---|
 * | `synced` | handshake completed and the counter drained | forget the entry |
 * | `blocked` | the server answered, and refused | mark, keep, tell the user |
 * | `retry` | we never got a usable answer | leave untouched, back off |
 * | `aborted` | the editor took this document | leave untouched, move on |
 *
 * The distinction between `blocked` and `retry` is the one that matters: a
 * network that died mid-pass must never be reported to the user as "this page
 * could not sync", and a locked page must never be retried forever in silence.
 * The discriminator is whether a handshake was ever observed.
 */

import type { BlockedReason } from "./dirty-pages";

/** How long one page may take before the attempt is concluded. */
export const RESYNC_PAGE_TIMEOUT_MS = 30_000;
/** How often the session is sampled. */
export const RESYNC_POLL_MS = 250;

export type RetryReason =
  /** No collaboration token could be obtained (offline, or a failing API). */
  | "no-token"
  /** The handshake never completed inside the timeout. */
  | "no-handshake"
  /** The session could not be constructed at all. */
  | "session-failed";

export type PageResyncOutcome =
  | { status: "synced" }
  | { status: "blocked"; reason: BlockedReason }
  | { status: "retry"; reason: RetryReason }
  | { status: "aborted" };

/** One sample of a live collaboration session. */
export interface ResyncSessionSample {
  /** y-indexeddb has finished replaying `page.<pageId>`. */
  localSynced: boolean;
  /** The socket is up. */
  connected: boolean;
  /** The document handshake completed (server sent SyncStep2). */
  synced: boolean;
  /** `HocuspocusProvider.unsyncedChanges`. */
  unsyncedChanges: number;
  /**
   * `onAuthenticationFailed` fired. Meaningful only together with the token:
   * with a token that is demonstrably not expired it means the page is gone or
   * access to it was revoked.
   */
  authenticationFailed: boolean;
}

export interface ResyncSession {
  sample(): ResyncSessionSample;
  /** Tear down socket, provider and persistence. Must never throw. */
  destroy(): void;
}

export interface ResyncPageDeps {
  /** Construct and attach a session for `page.<pageId>`. */
  openSession(pageId: string, token: string): Promise<ResyncSession>;
  /** A collaboration token, refreshed if the held one has expired. */
  getToken(): Promise<string | undefined>;
  /** `isCollabTokenExpired`; injected so the auth verdict is testable. */
  isTokenExpired(token: string): boolean;
  /** The editor has taken this document and we must stand down. */
  shouldAbort(pageId: string): boolean;
  wait(ms: number): Promise<void>;
  now(): number;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Attempt one page, always tearing the session down before returning.
 *
 * Nothing in here touches the page's Yjs document beyond what the provider does
 * on its own: no update is constructed, discarded or replayed by this code. A
 * page that cannot be pushed keeps its local content exactly as it was, which
 * is what makes "blocked" a report rather than a loss.
 */
export async function resyncPage(
  pageId: string,
  deps: ResyncPageDeps,
): Promise<PageResyncOutcome> {
  const {
    openSession,
    getToken,
    isTokenExpired,
    shouldAbort,
    wait,
    now,
    timeoutMs = RESYNC_PAGE_TIMEOUT_MS,
    pollMs = RESYNC_POLL_MS,
  } = deps;

  if (shouldAbort(pageId)) return { status: "aborted" };

  const token = await getToken();
  if (!token) return { status: "retry", reason: "no-token" };

  let session: ResyncSession;
  try {
    session = await openSession(pageId, token);
  } catch {
    return { status: "retry", reason: "session-failed" };
  }

  try {
    const deadline = now() + timeoutMs;
    // Latched: the server answered our handshake at least once. Everything
    // downstream of this flag is the difference between "refused" and
    // "unreachable".
    let handshakeObserved = false;

    for (;;) {
      if (shouldAbort(pageId)) return { status: "aborted" };

      const sample = session.sample();

      if (sample.authenticationFailed) {
        // A token we can still read, with an expiry in the future, and the
        // server refused it anyway: the refusal is about the page, not the
        // token. An unreadable or expired token is simply a stale token — the
        // next pass fetches a new one.
        return isTokenExpired(token)
          ? { status: "retry", reason: "no-token" }
          : { status: "blocked", reason: "no-access" };
      }

      if (sample.connected && sample.synced) {
        handshakeObserved = true;
        // `localSynced` is required *here* and not earlier: it is what
        // guarantees the zero counter means "everything on disk landed"
        // rather than "there was nothing to send yet".
        if (sample.localSynced && sample.unsyncedChanges === 0) {
          return { status: "synced" };
        }
      }

      if (now() >= deadline) {
        return handshakeObserved
          ? { status: "blocked", reason: "not-accepted" }
          : { status: "retry", reason: "no-handshake" };
      }

      await wait(pollMs);
    }
  } finally {
    try {
      session.destroy();
    } catch {
      // A failed teardown must not turn a successful push into a failure.
    }
  }
}
