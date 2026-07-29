/**
 * Noticing that the user has just made an edit no server has seen.
 *
 * ## Why an origin filter, and why it is exact
 *
 * A `Y.Doc` emits `update` for *every* change, including the ones that are not
 * the user typing. Two of those matter here, and both were read out of the
 * installed sources rather than guessed:
 *
 * - `y-indexeddb@9.0.12` replays the stored document with
 *   `Y.transact(doc, () => …, idbPersistence, false)` — the transaction origin
 *   **is the `IndexeddbPersistence` instance**. Without the filter, simply
 *   *opening* a page offline would replay its whole history and mark it dirty,
 *   and every page the user merely read offline would be queued for a resync —
 *   and, if it happened to be locked, reported to them as blocked.
 * - `@hocuspocus/provider@3.4.4` applies server updates with the provider as
 *   the origin (`readSyncMessage(…, provider)`), which is also why its own
 *   `documentUpdateHandler` starts with `if (origin === this) return`.
 *
 * Everything else is a local edit. `y-prosemirror` commits editor changes with
 * `ySyncPluginKey` as the origin, but the rule here is stated as an exclusion
 * rather than as a match on that key: a *missed* edit is silently lost work,
 * while a spurious record costs one redundant background sync. The asymmetry
 * decides the direction the filter fails in.
 *
 * ## Why "not connected" rather than "offline"
 *
 * The phase-2 gate asks whether the server is reachable at all (`reachability.ts`);
 * this asks whether *this document's* provider is connected. They are
 * deliberately different questions.
 * The gate is about permitting an edit at all and is kept as narrow as
 * possible; this is about not losing one, and an edit made during a reconnect
 * gap, a captive portal or a dropped WebSocket is just as unpushed as one made
 * in a tunnel. Recording it is harmless if the page's own provider then pushes
 * it — the entry is cleared as soon as the counter drains.
 */

/** The slice of `Y.Doc` this module needs. */
export interface DocUpdateSource {
  on(event: "update", handler: (update: Uint8Array, origin: unknown) => void): void;
  off(event: "update", handler: (update: Uint8Array, origin: unknown) => void): void;
}

/**
 * Is this update the user editing, rather than a replay from disk or from the
 * server?
 *
 * `ignoredOrigins` holds the `IndexeddbPersistence` and the `HocuspocusProvider`
 * for this document. Nullish entries are ignored so a caller that has only one
 * of the two still gets the other's protection.
 */
export function isLocalEditOrigin(
  origin: unknown,
  ignoredOrigins: readonly unknown[],
): boolean {
  return !ignoredOrigins.some(
    (ignored) => ignored != null && origin === ignored,
  );
}

export interface DirtyTrackingInput {
  doc: DocUpdateSource;
  /** Re-read at event time: the set is stable, the connection state is not. */
  ignoredOrigins: () => readonly unknown[];
  /** Whether this document's provider is currently connected. */
  isConnected: () => boolean;
  onDirty: () => void;
}

/**
 * Subscribe to a document and report the edits that are not going anywhere.
 *
 * Returns the unsubscribe. Every input is a callback rather than a value
 * because the caller — the phase-2 hook's one-second tick — attaches this once
 * per page but re-evaluates connectivity every second, and re-subscribing on
 * each status change would race with the edits happening across the gap.
 */
export function trackDirtyEdits({
  doc,
  ignoredOrigins,
  isConnected,
  onDirty,
}: DirtyTrackingInput): () => void {
  const handler = (_update: Uint8Array, origin: unknown) => {
    if (isConnected()) return;
    if (!isLocalEditOrigin(origin, ignoredOrigins())) return;
    onDirty();
  };
  doc.on("update", handler);
  return () => doc.off("update", handler);
}
