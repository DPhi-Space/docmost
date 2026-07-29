/**
 * "Does this Yjs document actually hold anything?"
 *
 * ## The defect this closes
 *
 * `sync-markers.ts` promises that a marker means *"y-indexeddb holds a copy of
 * real server content — never an empty shell"*. Nothing enforced it. The marker
 * store and the page's document live in **two independent IndexedDB databases**
 * that can disagree, and they do: delete just the `page.<pageId>` database — by
 * hand, through a storage eviction, or through any partial cleanup — and the
 * marker survives it. Offline, `isLocalSynced` then goes true for the empty
 * database exactly as it would for a populated one, the gate opens, and the
 * user gets a **live, editable, blank** editor above the words "changes are
 * saved locally and will sync when you reconnect". They believe they are
 * looking at their document.
 *
 * (It is not data loss — typing into the empty document and reconnecting
 * *merges*, leaving the server content intact — but it is the headline feature
 * telling the user something false.)
 *
 * ## Why an emptiness check rather than moving the marker
 *
 * The other fix on offer is to store the marker inside the page's own
 * y-indexeddb database, so the two cannot be separated. That is a larger change
 * with a worse failure mode: it means writing into the database
 * `IndexeddbPersistence` owns (its `custom` store) from outside it, on the
 * collaboration path, in a fork whose one rule is not to touch that path — and
 * it would still not detect a database that exists but was truncated.
 *
 * Asking the document directly is smaller and answers the real question. The
 * gate does not actually care where the marker lives; it cares that the editor
 * is about to bind to something real.
 *
 * ## The test used
 *
 * A `Y.Doc` with no content has no entries in its client store, so
 * `Y.encodeStateVector` returns a single zero byte. That is public API, exact,
 * and costs one varint decode.
 *
 * Note what this deliberately does *not* reject: a document with clients whose
 * content has all been deleted — a genuinely empty page. That has completed a
 * real sync and is real server content; refusing to open it would make an empty
 * page uneditable offline for no reason. The distinction is "never synced" vs
 * "synced and empty", which is exactly the state vector's distinction.
 */

import * as Y from "yjs";

/** The slice of `Y.Doc` this module needs; structural so tests can be honest. */
export type ContentBearingDoc = Y.Doc;

/**
 * Has anything ever been written to this document?
 *
 * Answers `false` — "treat as empty" — for anything unreadable, which closes
 * the gate. This is the safety direction: a page wrongly held read-only costs
 * the user a trip online, a page wrongly opened costs them their confidence in
 * the feature.
 */
export function hasDocContent(doc: ContentBearingDoc | undefined | null): boolean {
  if (!doc) return false;
  try {
    // `encodeStateVector` writes one varUint per client. No clients ⇒ a single
    // zero byte ⇒ nothing has ever been written into this document.
    return Y.encodeStateVector(doc).length > 1;
  } catch {
    return false;
  }
}
