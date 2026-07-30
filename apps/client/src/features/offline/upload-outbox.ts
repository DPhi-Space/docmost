/**
 * "Which attachment uploads has this browser accepted that no server has seen?"
 *
 * Phase 4 of the offline plan (issue #21). Phases 2/3 cover *text*: an offline
 * edit lands in the page's Yjs document and rides the collaboration handshake
 * on reconnect. Attachments never touch the CRDT — an Excalidraw diagram is a
 * single SVG uploaded over REST and referenced by node attrs, and a pasted
 * image is a REST upload that must finish before the node gets a real `src`.
 * So offline attachment work needs its own store: the blob itself, plus enough
 * metadata to replay the upload and to fix the document up afterwards.
 *
 * ## Records are keyed by ATTACHMENT id, not by a synthetic one
 *
 * Every queued upload has exactly one attachment id the document points at:
 *
 * - `mode: "create"` — a **client-generated placeholder id**. The node is
 *   inserted with `src = /api/files/<placeholder>/<fileName>` so the document
 *   is self-consistent, the service worker can serve the blob for that URL
 *   (`sw/outbox-serving.ts`), and the replay can find the node to rewrite once
 *   the server has assigned the real id.
 * - `mode: "overwrite"` — the **real server id** of an existing Excalidraw
 *   attachment, replayed as the same overwrite `uploadFile` performs online.
 *
 * Keying the store by that id gives three properties for free: a re-save of
 * the same diagram *replaces* its queued blob instead of queueing a duplicate
 * upload; the service worker can answer `GET /api/files/<id>/...` with one
 * `get(id)`; and the replay can never upload two blobs for one node.
 *
 * ## Two things this store deliberately does (mirroring `dirty-pages.ts`)
 *
 * 1. **It never forgets an entry it could not push.** An upload the server
 *    refuses (page deleted, access revoked, file rejected) is *marked* blocked
 *    and kept — the blob is the only copy of the user's drawing, and dropping
 *    it would destroy work silently.
 * 2. **A successful upload is not the end of the record.** For `create`
 *    records the document still points at the placeholder id until the node
 *    attrs are rewritten, which may have to wait for the page to be opened
 *    (`pending-node-rewrite.ts`). The record moves to `status: "uploaded"`,
 *    keeps the blob (the service worker keeps rendering it), and is deleted
 *    only once the rewrite has landed — or once the node is known deleted.
 *
 * A separate IndexedDB **database**, for the same reason `sync-markers.ts` and
 * `dirty-pages.ts` use one: idb-keyval's `createStore` opens at version 1 and
 * creates its store in the upgrade callback, so a second store name against an
 * existing database never runs the upgrade and every transaction then fails
 * with `NotFoundError`.
 *
 * Cleared on logout by `clearOfflineData()`. Preserved across session expiry
 * under the same provable-ownership rules as the dirty registry — see
 * `session-expiry.ts`.
 */

import { clear, createStore, del, entries, get, set, type UseStore } from "idb-keyval";
import type { DirtyPageLink } from "./dirty-pages";

export const UPLOAD_OUTBOX_DB_NAME = "docmost-offline-outbox";
export const UPLOAD_OUTBOX_STORE_NAME = "upload-outbox";

/** The issue's two kinds: a whole-diagram save vs. a pasted/dropped file. */
export type UploadKind = "excalidraw" | "media";

/** The ProseMirror node the queued upload belongs to. */
export type PendingNodeType =
  | "excalidraw"
  | "image"
  | "video"
  | "pdf"
  | "attachment";

/**
 * `create`: replayed as a plain upload; the server assigns a fresh id and the
 * node attrs must be rewritten from the placeholder to it.
 * `overwrite`: replayed with the `attachmentId` form of `uploadFile`, which the
 * server treats as "replace the file body of this existing attachment".
 */
export type UploadMode = "create" | "overwrite";

/**
 * Why an upload could not be pushed. Both are *server* answers — a transport
 * failure leaves the entry untouched so the next pass retries it.
 */
export type UploadBlockedReason =
  /**
   * 403 or 404: the page was deleted, access to it was revoked, or (for an
   * overwrite) the attachment itself is gone.
   */
  | "no-access"
  /**
   * 4xx other than auth: the server understood the request and refused the
   * file — too large, extension mismatch on an overwrite, malformed.
   */
  | "rejected";

/** The slice of `IAttachment` a rewrite needs, captured at upload time. */
export interface UploadedAttachmentInfo {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** ISO date string from the server; feeds the `?t=` cache-buster. */
  updatedAt?: string;
}

export interface UploadOutboxRecord {
  /** Primary key. Placeholder id for `create`, real server id for `overwrite`. */
  attachmentId: string;
  pageId: string;
  kind: UploadKind;
  nodeType: PendingNodeType;
  mode: UploadMode;
  blob: Blob;
  fileName: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  /** `uploaded` = on the server, awaiting the node-attr rewrite. */
  status: "pending" | "uploaded";
  /** Set once a replay concluded the server will not take the upload. */
  blocked?: { reason: UploadBlockedReason; at: number };
  /** Present iff `status === "uploaded"`. */
  uploaded?: UploadedAttachmentInfo;
  /** Same metadata the dirty registry keeps: enough to link to the page. */
  link?: DirtyPageLink;
}

/**
 * The slice of idb-keyval this module needs, so the semantics can be tested
 * against a real map instead of a jsdom without IndexedDB.
 */
export interface UploadOutboxBackend {
  get(key: string): Promise<UploadOutboxRecord | undefined>;
  set(key: string, value: UploadOutboxRecord): Promise<void>;
  del(key: string): Promise<void>;
  entries(): Promise<[string, UploadOutboxRecord][]>;
  clear(): Promise<void>;
}

/**
 * Resolved lazily and always inside a `try`, for the reason spelled out in
 * `sync-markers.ts`: `createStore` opens an IndexedDB connection as a side
 * effect, so at module scope it would create the database in sessions that
 * never turn offline editing on and would throw on import under jsdom.
 */
let store: UseStore | undefined;
function defaultBackend(): UploadOutboxBackend {
  store ??= createStore(UPLOAD_OUTBOX_DB_NAME, UPLOAD_OUTBOX_STORE_NAME);
  const s = store;
  return {
    get: (key) => get<UploadOutboxRecord>(key, s),
    set: (key, value) => set(key, value, s),
    del: (key) => del(key, s),
    entries: () => entries<string, UploadOutboxRecord>(s),
    clear: () => clear(s),
  };
}

/** Guards against a half-written or older-shaped record wedging a pass. */
export function isUploadOutboxRecord(
  value: unknown,
): value is UploadOutboxRecord {
  const record = value as UploadOutboxRecord;
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.attachmentId === "string" &&
    typeof record.pageId === "string" &&
    typeof record.fileName === "string"
  );
}

export interface EnqueueUploadInput {
  attachmentId: string;
  pageId: string;
  kind: UploadKind;
  nodeType: PendingNodeType;
  mode: UploadMode;
  blob: Blob;
  fileName: string;
  mimeType: string;
  link?: DirtyPageLink;
}

/**
 * Queue (or re-queue) an upload.
 *
 * A record that already exists for the same attachment id is **replaced in
 * content but not in identity**: `createdAt`, `kind`, `nodeType` and `mode`
 * survive, so a diagram saved three times offline is still one `create` replay
 * in its original queue position. A `blocked` mark is *cleared* — unlike a
 * dirty page, a re-save is a new file, and the server's last answer was about
 * the previous body (a diagram blocked for "too large" can be saved smaller).
 *
 * Returns false when the write failed (quota, private mode) so the caller can
 * say so instead of letting the user believe the save landed.
 */
export async function enqueueUpload(
  input: EnqueueUploadInput,
  backend?: UploadOutboxBackend,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const store = backend ?? defaultBackend();
    const existing = await store.get(input.attachmentId);
    await store.set(input.attachmentId, {
      attachmentId: input.attachmentId,
      pageId: input.pageId,
      kind: existing?.kind ?? input.kind,
      nodeType: existing?.nodeType ?? input.nodeType,
      mode: existing?.mode ?? input.mode,
      blob: input.blob,
      fileName: input.fileName,
      mimeType: input.mimeType,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: "pending",
      link: input.link ?? existing?.link,
    });
    return true;
  } catch {
    return false;
  }
}

/** One record, by the attachment id a document node points at. Never throws. */
export async function readUploadRecord(
  attachmentId: string,
  backend?: UploadOutboxBackend,
): Promise<UploadOutboxRecord | undefined> {
  try {
    const record = await (backend ?? defaultBackend()).get(attachmentId);
    return isUploadOutboxRecord(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mark an entry as one the server would not take, **keeping it**. No-ops if the
 * entry has since been removed.
 */
export async function markUploadBlocked(
  attachmentId: string,
  reason: UploadBlockedReason,
  backend?: UploadOutboxBackend,
  now: number = Date.now(),
): Promise<void> {
  try {
    const store = backend ?? defaultBackend();
    const existing = await store.get(attachmentId);
    if (!existing) return;
    await store.set(attachmentId, {
      ...existing,
      blocked: { reason, at: now },
    });
  } catch {
    // The entry stays un-marked and is retried on the next pass.
  }
}

/**
 * The server accepted the upload; the record now exists only to carry the
 * rewrite. The blob is deliberately kept: for a `create` record the document
 * still points at the placeholder URL until the rewrite lands, and the service
 * worker keeps answering that URL from this record.
 *
 * No-ops if the record was replaced by a *newer* save while the upload was in
 * flight (`updatedAt` moved): the newer blob supersedes the one that was
 * uploaded and must be replayed again, not marked done.
 */
export async function markUploadUploaded(
  attachmentId: string,
  uploaded: UploadedAttachmentInfo,
  asOf: number,
  backend?: UploadOutboxBackend,
): Promise<void> {
  try {
    const store = backend ?? defaultBackend();
    const existing = await store.get(attachmentId);
    if (!existing) return;
    if (existing.updatedAt > asOf) return;
    await store.set(attachmentId, {
      ...existing,
      status: "uploaded",
      uploaded,
      blocked: undefined,
    });
  } catch {
    // Worst case the same blob is uploaded again: overwrites are idempotent
    // and a duplicate `create` upload leaves one orphaned attachment, which is
    // the same cost as deleting an image after uploading it.
  }
}

/** Forget an upload whose work is fully settled (rewritten, or node deleted). */
export async function deleteUploadRecord(
  attachmentId: string,
  backend?: UploadOutboxBackend,
): Promise<void> {
  try {
    await (backend ?? defaultBackend()).del(attachmentId);
  } catch {
    // A stale entry costs one redundant replay attempt, nothing more.
  }
}

/** Every queued upload. Never throws; an unreadable store reads as empty. */
export async function listUploadRecords(
  backend?: UploadOutboxBackend,
): Promise<UploadOutboxRecord[]> {
  try {
    const rows = await (backend ?? defaultBackend()).entries();
    return rows.map(([, record]) => record).filter(isUploadOutboxRecord);
  } catch {
    return [];
  }
}

/**
 * Every queued upload, together with whether the store could be read at all.
 *
 * The distinction is load-bearing for session expiry, exactly as it is for
 * `readDirtyPages`: an unreadable outbox must mean *preserve*, never "nothing
 * is pending" — the blobs here are the only copy of the user's drawings.
 */
export type UploadOutboxRead =
  | { readable: true; records: UploadOutboxRecord[] }
  | { readable: false };

export async function readUploadOutbox(
  backend?: UploadOutboxBackend,
): Promise<UploadOutboxRead> {
  try {
    const rows = await (backend ?? defaultBackend()).entries();
    return {
      readable: true,
      records: rows.map(([, record]) => record).filter(isUploadOutboxRecord),
    };
  } catch {
    return { readable: false };
  }
}

/**
 * Drop every entry, leaving the database shell in place — same reasoning as
 * `clearDirtyPages`: idb-keyval holds its connection open with no
 * `versionchange` handler, so `deleteDatabase` parks as `blocked` and then
 * blocks every later `open` of that name for the life of the document.
 */
export async function clearUploadOutbox(
  backend?: UploadOutboxBackend,
): Promise<void> {
  try {
    await (backend ?? defaultBackend()).clear();
  } catch {
    // Best effort; logout is followed by a full-page navigation.
  }
}

export interface SelectUploadsOptions {
  /**
   * Whether entries already marked `blocked` are retried in this pass. Same
   * rule as `selectPagesToResync`: true for passes a change of circumstances
   * triggers, false for the periodic timer.
   */
  includeBlocked: boolean;
}

/**
 * Which uploads a replay pass should attempt, oldest first ("upload each entry
 * in order" — issue #21). `uploaded` records are excluded: their remaining work
 * is a rewrite, not an upload.
 *
 * Unlike pages, the currently-open page is **not** excluded. The #20 exclusion
 * exists so two collaboration providers never share a document; an upload is a
 * REST request and touches no provider, and replaying it while the user is on
 * the page is strictly better — the rewrite can land immediately.
 */
export function selectUploadsToReplay(
  records: readonly UploadOutboxRecord[],
  { includeBlocked }: SelectUploadsOptions,
): UploadOutboxRecord[] {
  return records
    .filter((record) => record.status === "pending")
    .filter((record) => includeBlocked || !record.blocked)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** The entries the UI lists under "could not upload", oldest first. */
export function blockedUploads(
  records: readonly UploadOutboxRecord[],
): UploadOutboxRecord[] {
  return records
    .filter((record) => record.blocked)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** Records whose upload landed but whose node attrs still await rewriting. */
export function uploadsAwaitingRewrite(
  records: readonly UploadOutboxRecord[],
): UploadOutboxRecord[] {
  return records.filter(
    (record) => record.status === "uploaded" && record.uploaded !== undefined,
  );
}

/**
 * The `src`/`url` a queued upload's node carries while the upload is pending.
 *
 * Deliberately shaped exactly like a real attachment URL: the service worker's
 * `api-file` route already intercepts this path, so serving the blob needs no
 * new route, and every consumer (image view, Excalidraw's `<img>`, the scene
 * fetch in `handleOpen`) works unchanged.
 */
export function pendingFileSrc(attachmentId: string, fileName: string): string {
  return `/api/files/${attachmentId}/${encodeURIComponent(fileName)}`;
}

/**
 * A placeholder attachment id for a `create` record.
 *
 * A real UUID on purpose: attachment URLs are pattern-matched in a few places
 * (`editor-paste-handler.tsx`'s `ATTACHMENT_URL_RE` expects `[0-9a-f-]+`), and
 * a shape that matches keeps every such consumer behaving as it would for a
 * real attachment. The id never reaches the server — a `create` replay uploads
 * *without* an attachment id and takes the server's.
 */
export function newPlaceholderAttachmentId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // Fallback for antique WebViews: random hex in UUID grouping.
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, hex);
}
