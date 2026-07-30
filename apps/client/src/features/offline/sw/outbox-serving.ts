/**
 * The pure half of "the service worker answers pending-upload URLs from the
 * outbox" — the decision logic, kept out of the event handlers for the same
 * reason as `routes.ts` and `cache-policy.ts`: a service worker cannot be
 * exercised in jsdom, so everything testable lives here and `sw.ts` supplies
 * the plumbing.
 *
 * ## Why the worker serves these at all
 *
 * A queued upload's node carries `src = /api/files/<attachmentId>/<fileName>`
 * (`pending-media.ts`), a URL the server does not know yet. The worker's
 * existing `api-file` route already intercepts that path; consulting the
 * outbox **first** — before the network — makes the pending content render:
 *
 * - offline, including after a reload (an object URL would have died with the
 *   document; the outbox blob did not);
 * - online before the replay lands, where the network would answer 404;
 * - for an *existing* Excalidraw diagram with a queued overwrite, where the
 *   network would answer the **stale** previous version — which is also what
 *   makes reopening the editor safe: `handleOpen` fetches the node's `src`,
 *   the worker serves the queued blob, and the user edits their latest save
 *   instead of clobbering it with edits to the old one.
 *
 * A record is consulted for *every* `GET /api/files/` request (one keyed read
 * against an id that misses for every real attachment), and answered for every
 * status: `pending` and `blocked` because the blob is the only copy anywhere,
 * `uploaded` because the identical bytes are on the server and the node attrs
 * simply have not been rewritten yet.
 *
 * ## Stated limitation
 *
 * The worker has no notion of who is signed in, so it will serve an outbox
 * blob to any session of this browser profile until `data-ownership.ts`'s
 * sign-in reconcile erases a foreign outbox. The window is the same one that
 * ownership reconcile already bounds for the `page.*` documents, and reaching
 * a blob inside it requires knowing its placeholder UUID; documented rather
 * than hidden.
 */

import { FILE_API_PATH_PREFIX } from "./routes";

/**
 * The attachment id of a `GET /api/files/<id>/<fileName>` path, or null for
 * anything shaped differently. Query strings (`?t=` cache busters) are the
 * caller's to strip — this takes a pathname.
 */
export function outboxCandidateIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(FILE_API_PATH_PREFIX)) return null;
  const rest = pathname.slice(FILE_API_PATH_PREFIX.length);
  const [id, ...tail] = rest.split("/");
  // Require the two-segment shape and a plausible id: sub-routes like
  // `/api/files/upload` or `/api/files/info` must never hit the outbox.
  if (!id || tail.length === 0 || tail.every((part) => part === "")) return null;
  if (!/^[0-9a-f][0-9a-f-]{8,}$/i.test(id)) return null;
  return id;
}

/** Headers for a blob served from the outbox. */
export function outboxResponseHeaders(record: {
  mimeType: string;
  blob: { size: number };
}): Record<string, string> {
  return {
    "content-type": record.mimeType || "application/octet-stream",
    "content-length": String(record.blob.size),
    // The HTTP cache must never keep a copy: once the record is deleted the
    // URL should 404 like any unknown attachment, not echo a stale blob.
    "cache-control": "no-store",
    "x-docmost-sw-outbox": "1",
  };
}
