/**
 * The decisions behind "queue this upload instead of sending it" — pure, so
 * the whole policy is a table of tests. The side effects (enqueue, insert,
 * notify) live in `offline-uploads.ts`.
 *
 * ## When uploads are queued
 *
 * Three conditions, all required, mirroring the phase-2 editing gate term for
 * term:
 *
 * - the offline-editing switch is on (`docmost.offline-editing`, default off —
 *   with it off, nothing in phase 4 is read or written and both call sites
 *   behave byte-identically to upstream);
 * - the server is unreachable by the *reachability verdict* (`reachability.ts`),
 *   never `navigator.onLine` — the VPN case broke every consumer that used it;
 * - the offline data on this disk is provably the signed-in user's
 *   (`data-ownership.ts`). Queued blobs are pushed under the current session's
 *   cookie on reconnect, so they must never be written to a disk whose other
 *   offline data cannot be attributed.
 *
 * ## Failure classification
 *
 * One classifier serves both moments an upload can fail:
 *
 * - at **save time**, `transport` reroutes into the queue (the reachability
 *   verdict lags behind the first failed request of an outage; losing the
 *   drawing to that lag would be phase 4 failing at exactly its own job),
 *   while every server answer is rethrown so the modal stays open exactly as
 *   upstream's does;
 * - at **replay time**, the same classes map onto blocked-vs-retry: server
 *   refusals are `blocked` (kept and surfaced, never silently retried
 *   forever), transport failures and 5xx are `retry` (a dead network must
 *   never be reported as "the server refused"), and 401 is `retry` because the
 *   axios interceptor is already routing the session expiry — the entry is
 *   preserved by that path, not judged here.
 */

import { isServerReachable } from "./reachability";
import { isOfflineEditingEnabled } from "./offline-editing-settings";
import { offlineDataIsOurs } from "./data-ownership";
import type { PendingNodeType, UploadBlockedReason } from "./upload-outbox";

export interface QueueUploadsInput {
  featureEnabled: boolean;
  serverReachable: boolean;
  dataIsOurs: boolean;
}

/** Pure predicate; `shouldQueueUploadsOffline` is its production wiring. */
export function shouldQueueUploads(input: QueueUploadsInput): boolean {
  return input.featureEnabled && !input.serverReachable && input.dataIsOurs;
}

export function shouldQueueUploadsOffline(): boolean {
  return shouldQueueUploads({
    featureEnabled: isOfflineEditingEnabled(),
    serverReachable: isServerReachable(),
    dataIsOurs: offlineDataIsOurs(),
  });
}

export type UploadFailureClass =
  /** Nothing came back: DNS, connect, timeout, abort. Not a server answer. */
  | "transport"
  /** 401 — the session ended; the global interceptor owns what happens next. */
  | "auth"
  /** 403/404 — page deleted, access revoked, or the overwrite target is gone. */
  | "no-access"
  /** Any other 4xx — the server understood the request and refused the file. */
  | "rejected"
  /** 5xx — the server is unwell; indistinguishable in effect from transport. */
  | "server";

/** The slice of an axios error this module inspects. */
export interface UploadErrorLike {
  response?: { status?: number };
}

export function classifyUploadFailure(error: unknown): UploadFailureClass {
  const status = (error as UploadErrorLike)?.response?.status;
  if (typeof status !== "number") return "transport";
  if (status === 401) return "auth";
  if (status === 403 || status === 404) return "no-access";
  if (status >= 400 && status < 500) return "rejected";
  return "server";
}

/**
 * Should this save-time failure reroute into the queue?
 *
 * Only a transport failure, and only when the queueing conditions hold. A
 * server that *answered* has made a decision, and hiding that decision behind
 * a silent enqueue would turn "the server said no" into "it will upload later",
 * which is false.
 */
export function shouldQueueAfterFailure(
  failure: UploadFailureClass,
  queueingAvailable: boolean,
): boolean {
  return failure === "transport" && queueingAvailable;
}

/**
 * Blocked-vs-retry for a replayed upload. `null` means retry: leave the entry
 * untouched and let the schedule come back to it.
 */
export function uploadBlockedReason(
  failure: UploadFailureClass,
): UploadBlockedReason | null {
  switch (failure) {
    case "no-access":
      return "no-access";
    case "rejected":
      return "rejected";
    default:
      return null;
  }
}

/**
 * Which node a pasted or dropped file becomes, mirroring the validators of the
 * four upstream upload actions (`upload-image-action.tsx` and friends): each
 * action claims its media type and `uploadAttachmentAction` takes everything
 * else — audio included, since the paste path wires no audio action.
 */
export function mediaNodeTypeForFile(mimeType: string): PendingNodeType {
  const type = mimeType || "";
  if (type.includes("image/")) return "image";
  if (type.includes("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  return "attachment";
}
