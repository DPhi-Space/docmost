/**
 * Replaying the upload outbox — phase 4's half of a resync pass.
 *
 * Runs inside the #20 resync manager's pass, after the page loop, under the
 * same Web Lock, the same switch, and the same two ownership gates: uploads
 * ride the schedule that already exists rather than growing a second one.
 * Unlike pages there is **no open-page exclusion** — an upload is a REST
 * request that touches no collaboration provider, and replaying while the user
 * is on the page is strictly better, because the node-attr rewrite can land
 * immediately instead of deferring.
 *
 * ## Blocked vs retry
 *
 * The discriminator is HTTP-simple here (nothing like #35's handshake
 * subtlety): the server *answered* with a refusal → `blocked`, kept and
 * surfaced; anything else — transport failure, timeout, 5xx — → `retry`,
 * entry untouched, backoff. 401 is `retry` too: the axios interceptor is
 * already routing the session expiry, and that path preserves the outbox.
 *
 * ## The mid-upload re-save race
 *
 * The user can save the same diagram again while its previous blob is in
 * flight. `markUploadUploaded` refuses to mark a record whose `updatedAt`
 * moved past the snapshot this pass took, so the newer blob stays `pending`
 * and is replayed by the next pass; the upload that just finished merely
 * becomes the penultimate version on the server. Nothing is discarded.
 *
 * ## What happens after a successful upload
 *
 * - `create` records: the document still points at the placeholder id. Try
 *   the live rewrite; if the page is not open (or not loaded), the record
 *   stays as `uploaded` — the service worker keeps rendering it — until
 *   `pending-node-rewrite.ts`'s watcher settles it on the next page open.
 * - `overwrite` records: the node already points at the real id; only the
 *   `?t=` cache-buster is stale. Try the live rewrite once, then delete the
 *   record either way — keeping it would pin the service worker to the local
 *   blob on a page the user may never reopen in this tab, hiding any *newer*
 *   server version from them indefinitely.
 */

import { uploadFile } from "@/features/page/services/page-service.ts";
import type { IAttachment } from "@/features/attachments/types/attachment.types";
import { attemptPendingRewrite, type RewriteOutcome } from "./pending-node-rewrite";
import { setResyncState } from "./resync-state";
import {
  classifyUploadFailure,
  uploadBlockedReason,
} from "./upload-interception";
import {
  blockedUploads,
  deleteUploadRecord,
  listUploadRecords,
  markUploadBlocked,
  markUploadUploaded,
  readUploadRecord,
  selectUploadsToReplay,
  type UploadOutboxRecord,
  type UploadedAttachmentInfo,
} from "./upload-outbox";

export interface UploadReplaySummary {
  attempted: number;
  /** Uploads the server accepted in this pass. */
  uploaded: number;
  /** Uploads the server refused; marked and kept. */
  blocked: number;
  /** Uploads left for a later pass: transport failures, 5xx, races. */
  deferred: number;
}

export const EMPTY_UPLOAD_SUMMARY: UploadReplaySummary = {
  attempted: 0,
  uploaded: 0,
  blocked: 0,
  deferred: 0,
};

export interface UploadReplayDeps {
  listUploadRecords: typeof listUploadRecords;
  readUploadRecord: typeof readUploadRecord;
  markUploadUploaded: (
    attachmentId: string,
    uploaded: UploadedAttachmentInfo,
    asOf: number,
  ) => Promise<void>;
  markUploadBlocked: typeof markUploadBlocked;
  deleteUploadRecord: typeof deleteUploadRecord;
  /** The REST upload; `attachmentId` present = overwrite. */
  upload: (
    file: File,
    pageId: string,
    attachmentId?: string,
  ) => Promise<UploadedAttachmentInfo>;
  attemptRewrite: (record: UploadOutboxRecord) => RewriteOutcome;
  /** Re-checked between uploads, exactly like the page loop. */
  isOnline: () => boolean;
  publish: (records: readonly UploadOutboxRecord[]) => void;
  log: (message: string, detail?: unknown) => void;
}

/** Publish the outbox-derived slice of the pill's state. */
export function publishUploadState(
  records: readonly UploadOutboxRecord[],
): void {
  setResyncState({
    pendingUploads: records.filter((record) => record.status === "pending")
      .length,
    blockedUploads: blockedUploads(records),
  });
}

async function uploadedInfoFromAttachment(
  attachment: IAttachment,
): Promise<UploadedAttachmentInfo> {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    mimeType: attachment.mimeType,
    updatedAt: attachment.updatedAt,
  };
}

export function createDefaultUploadReplayDeps(): UploadReplayDeps {
  return {
    listUploadRecords,
    readUploadRecord,
    markUploadUploaded: (attachmentId, uploaded, asOf) =>
      markUploadUploaded(attachmentId, uploaded, asOf),
    markUploadBlocked,
    deleteUploadRecord,
    upload: async (file, pageId, attachmentId) =>
      uploadedInfoFromAttachment(await uploadFile(file, pageId, attachmentId)),
    attemptRewrite: attemptPendingRewrite,
    isOnline: () => true, // replaced by the manager wiring's reachability check
    publish: publishUploadState,
    log: (message, detail) => {
      if (detail === undefined) console.info(`[docmost] ${message}`);
      else console.info(`[docmost] ${message}`, detail);
    },
  };
}

/**
 * Replay the outbox once, serially, oldest first.
 *
 * Also settles any rewrites that became possible (records already `uploaded`
 * whose page is now open) so a replay pass leaves no work behind that it could
 * have finished. Never rejects.
 */
export async function replayUploadPass(
  includeBlocked: boolean,
  deps: UploadReplayDeps,
): Promise<UploadReplaySummary> {
  const summary: UploadReplaySummary = { ...EMPTY_UPLOAD_SUMMARY };

  let records: UploadOutboxRecord[];
  try {
    records = await deps.listUploadRecords();
  } catch {
    return summary;
  }
  if (records.length === 0) return summary;

  // Settle rewrites first: an `uploaded` record whose page is on screen can be
  // finished without any network at all.
  for (const record of records.filter((r) => r.status === "uploaded")) {
    await settleUploadedRecord(record, deps);
  }

  const pending = selectUploadsToReplay(records, { includeBlocked });
  summary.attempted = pending.length;
  if (pending.length > 0) {
    deps.log(
      `offline uploads: ${pending.length} queued upload(s) to push`,
      pending.map((record) => `${record.nodeType}:${record.attachmentId}`),
    );
  }

  for (const record of pending) {
    if (!deps.isOnline()) {
      summary.deferred = pending.length - summary.uploaded - summary.blocked;
      break;
    }

    const outcome = await replayOneUpload(record, deps);
    summary[outcome] += 1;
  }

  try {
    deps.publish(await deps.listUploadRecords());
  } catch {
    // Presentation only; the records themselves are already settled.
  }
  return summary;
}

async function replayOneUpload(
  record: UploadOutboxRecord,
  deps: UploadReplayDeps,
): Promise<"uploaded" | "blocked" | "deferred"> {
  const asOf = record.updatedAt;
  const file = new File([record.blob], record.fileName, {
    type: record.mimeType,
  });

  let uploaded: UploadedAttachmentInfo;
  try {
    uploaded = await deps.upload(
      file,
      record.pageId,
      // A `create` record's placeholder id must never reach the server; it
      // names nothing there.
      record.mode === "overwrite" ? record.attachmentId : undefined,
    );
  } catch (error) {
    const reason = uploadBlockedReason(classifyUploadFailure(error));
    if (reason) {
      await deps.markUploadBlocked(record.attachmentId, reason);
      deps.log(
        `offline uploads: ${record.attachmentId} refused by the server`,
        reason,
      );
      return "blocked";
    }
    deps.log(`offline uploads: ${record.attachmentId} deferred`);
    return "deferred";
  }

  await deps.markUploadUploaded(record.attachmentId, uploaded, asOf);

  // Re-read: a save racing the upload leaves the record `pending` with a newer
  // blob, which the *next* pass replays. Only a record that really moved to
  // `uploaded` is settled further.
  const current = await deps.readUploadRecord(record.attachmentId);
  if (!current) return "uploaded";
  if (current.status !== "uploaded") {
    deps.log(
      `offline uploads: ${record.attachmentId} re-saved mid-upload, will replay again`,
    );
    return "deferred";
  }

  await settleUploadedRecord(current, deps);
  return "uploaded";
}

async function settleUploadedRecord(
  record: UploadOutboxRecord,
  deps: UploadReplayDeps,
): Promise<void> {
  const outcome = deps.attemptRewrite(record);
  if (outcome === "rewritten" || outcome === "node-gone") {
    await deps.deleteUploadRecord(record.attachmentId);
    return;
  }
  // `unavailable`, page not open here:
  if (record.mode === "overwrite") {
    // The node already points at the real attachment; only the ?t= cache
    // buster is stale. Deleting now frees the URL to reach the server again —
    // keeping the record would pin this tab's service worker to the local blob
    // forever on a page never reopened here, hiding newer server versions.
    await deps.deleteUploadRecord(record.attachmentId);
    return;
  }
  // `create` records stay: the placeholder URL must keep rendering until the
  // rewrite lands on the next page open (pending-node-rewrite.ts).
}
