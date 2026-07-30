/**
 * The entire surface the editor's upload call sites import from phase 4 —
 * one module, for the same reason `offline-editing.ts` exists: the touched
 * upstream files (`excalidraw-menu.tsx`, `excalidraw-view.tsx`,
 * `editor-paste-handler.tsx`) must each gain exactly one import statement,
 * small enough to re-create by hand if upstream ever rewrites them.
 *
 * Two entry points:
 *
 * - {@link saveExcalidrawOrQueue} replaces the `uploadFile` +
 *   `updateAttributes`-payload pair in both Excalidraw components. Online it
 *   *is* that pair, byte-for-byte in effect; offline (switch on, server
 *   unreachable, ownership settled) it queues the SVG in the outbox instead.
 * - {@link queueMediaFilesOffline} sits at the top of the paste/drop file
 *   branches. It answers `false` — do the upstream thing — in every session
 *   except a queueing one, where it enqueues each file and inserts a pending
 *   node rendered by the service worker from the outbox blob.
 *
 * ## What the user is told
 *
 * A queued save is announced once ("Saved on this device…"), because unlike a
 * text edit there is no grey phase-2 banner attached to an upload. A queue
 * *failure* (quota, private browsing) is announced loudly and the Excalidraw
 * save throws — the modal stays open, exactly as it does for a failed upload
 * today, because letting it close would tell the user the drawing is safe when
 * it is not.
 */

import type { Editor } from "@tiptap/core";
import { notifications } from "@mantine/notifications";
import i18n from "@/i18n.ts";
import { formatBytes } from "@/lib";
import { getFileUploadSizeLimit } from "@/lib/config.ts";
import { uploadFile } from "@/features/page/services/page-service.ts";
import type { IAttachment } from "@/features/attachments/types/attachment.types";
import { resolveDirtyPageLink } from "./dirty-page-link";
import {
  insertPendingNode,
  pendingNodeAttrs,
  probeImageDimensions,
} from "./pending-media";
import { publishUploadState } from "./upload-replay";
import {
  deleteUploadRecord,
  enqueueUpload,
  listUploadRecords,
  newPlaceholderAttachmentId,
  pendingFileSrc,
  readUploadRecord,
} from "./upload-outbox";
import {
  classifyUploadFailure,
  mediaNodeTypeForFile,
  shouldQueueAfterFailure,
  shouldQueueUploadsOffline,
} from "./upload-interception";

/** The attrs `excalidraw-menu.tsx` applies via `updateAttributes`. */
export interface ExcalidrawNodeAttrs {
  src: string;
  title: string;
  size: number;
  attachmentId: string;
}

export interface SaveExcalidrawInput {
  file: File;
  pageId: string;
  /** The node's current attachment id; null/undefined for a new diagram. */
  attachmentId?: string | null;
}

export interface SaveExcalidrawResult {
  queued: boolean;
  /**
   * Attrs to apply via `updateAttributes`. For a queued re-save of an
   * existing diagram the id and path are unchanged and only the `?t=`
   * cache-buster moves, so the in-page preview re-fetches through the service
   * worker and shows the queued blob immediately (review gap #3). Null only
   * on paths that have nothing to apply.
   */
  attrs: ExcalidrawNodeAttrs | null;
}

function excalidrawAttrsFromAttachment(
  attachment: IAttachment,
): ExcalidrawNodeAttrs {
  // Transcription of excalidraw-menu.tsx's updateAttributes payload.
  return {
    src: `/api/files/${attachment.id}/${attachment.fileName}?t=${new Date(attachment.updatedAt).getTime()}`,
    title: attachment.fileName,
    size: attachment.fileSize,
    attachmentId: attachment.id,
  };
}

function notifyQueued(message: string): void {
  notifications.show({ color: "blue", message: i18n.t(message) });
}

/** Recount the outbox for the pill; best-effort, never awaited by callers. */
export async function publishUploadOutboxState(): Promise<void> {
  publishUploadState(await listUploadRecords());
}

/**
 * Upload an Excalidraw SVG, or queue it when the server cannot be reached.
 *
 * The online path also repairs two queue-related states it can meet:
 *
 * - the node's attachment id is a **placeholder** (a diagram created offline
 *   whose replay has not run yet): the id must not reach the server — it names
 *   nothing there — so the save uploads as a *new* attachment, takes the
 *   server's id, and deletes the outbox record it supersedes;
 * - the node's attachment id is real but an **overwrite is queued** for it:
 *   the save just performed is strictly newer than the queued blob, so the
 *   record is deleted after the direct upload succeeds. This is not a silent
 *   discard — the queued content is replaced by a newer save of the same
 *   diagram by the same user, which is what "last save wins" already means
 *   inside one editing session.
 *
 * On a transport failure in an apparently-online session the save reroutes
 * into the queue (when queueing is available) instead of failing: the
 * reachability verdict lags the first dropped request of an outage, and that
 * lag must not cost a drawing.
 */
export async function saveExcalidrawOrQueue(
  input: SaveExcalidrawInput,
): Promise<SaveExcalidrawResult> {
  const attachmentId = input.attachmentId || undefined;
  const queued = attachmentId ? await readUploadRecord(attachmentId) : undefined;
  const idIsPlaceholder = queued?.mode === "create";

  if (!shouldQueueUploadsOffline()) {
    try {
      const attachment = await uploadFile(
        input.file,
        input.pageId,
        idIsPlaceholder ? undefined : attachmentId,
      );
      if (queued) {
        await deleteUploadRecord(queued.attachmentId);
        void publishUploadOutboxState();
      }
      return { queued: false, attrs: excalidrawAttrsFromAttachment(attachment) };
    } catch (error) {
      const failure = classifyUploadFailure(error);
      if (!shouldQueueAfterFailure(failure, shouldQueueUploadsOffline())) {
        throw error;
      }
      // Fall through to the queue: the network died under an optimistic
      // reachability verdict.
    }
  }

  return queueExcalidrawSave(input, attachmentId, idIsPlaceholder);
}

async function queueExcalidrawSave(
  input: SaveExcalidrawInput,
  attachmentId: string | undefined,
  idIsPlaceholder: boolean,
): Promise<SaveExcalidrawResult> {
  const isNew = !attachmentId || idIsPlaceholder;
  const id = attachmentId ?? newPlaceholderAttachmentId();
  const now = Date.now();

  const stored = await enqueueUpload({
    attachmentId: id,
    pageId: input.pageId,
    kind: "excalidraw",
    nodeType: "excalidraw",
    mode: isNew ? "create" : "overwrite",
    blob: input.file,
    fileName: input.file.name,
    mimeType: input.file.type || "image/svg+xml",
    link: resolveDirtyPageLink(input.pageId),
  });

  if (!stored) {
    notifications.show({
      color: "red",
      message: i18n.t(
        "Could not save the drawing on this device — storage is unavailable.",
      ),
    });
    // Throwing keeps the modal open, exactly like a failed upload today.
    throw new Error("offline upload outbox write failed");
  }

  void publishUploadOutboxState();
  notifyQueued("Drawing saved on this device — it will upload when you're back online.");

  return {
    queued: true,
    attrs: isNew
      ? (pendingNodeAttrs("excalidraw", {
          attachmentId: id,
          fileName: input.file.name,
          fileSize: input.file.size,
          mimeType: input.file.type || "image/svg+xml",
          timestamp: now,
        }) as unknown as ExcalidrawNodeAttrs)
      : /**
         * A queued overwrite keeps its id and path but gets a fresh `?t=`
         * cache-buster (review gap #3): the node view re-assigns `el.src`
         * whenever `src` changes, so the in-page preview re-fetches through
         * the service worker — which serves the queued blob — instead of
         * showing the stale bytes until a reload. The attr write is an
         * ordinary offline document edit: it marks the page dirty and syncs
         * the new `?t=` with everything else on reconnect, which is also what
         * a direct online save would have done. The SW matches by attachment
         * id, so the query string never affects which bytes are served.
         */
        {
          src: `${pendingFileSrc(id, input.file.name)}?t=${now}`,
          title: input.file.name,
          size: input.file.size,
          attachmentId: id,
        },
  };
}

/**
 * Queue pasted/dropped files while the server is unreachable.
 *
 * Returns `false` in every session where queueing is off — the call sites then
 * run the upstream upload actions untouched, which is what makes this a
 * two-line intercept per call site. Returns `true` after taking ownership of
 * the files: each one is size-checked (mirroring the upstream validators),
 * written to the outbox, and inserted as a node whose `src` the service worker
 * answers from the queued blob.
 *
 * Enqueue-then-insert, in that order, per file: a node pointing at a blob that
 * failed to store would render as broken *and* replay nothing.
 */
export function queueMediaFilesOffline(
  editor: Editor,
  files: readonly File[],
  pos: number,
  pageId: string,
): boolean {
  if (!shouldQueueUploadsOffline()) return false;
  if (!files.length) return false;

  void (async () => {
    for (const file of files) {
      await queueOneMediaFile(editor, file, pos, pageId);
    }
    void publishUploadOutboxState();
  })();

  return true;
}

async function queueOneMediaFile(
  editor: Editor,
  file: File,
  pos: number,
  pageId: string,
): Promise<void> {
  if (file.size > getFileUploadSizeLimit()) {
    notifications.show({
      color: "red",
      message: i18n.t("File exceeds the {{limit}} attachment limit", {
        limit: formatBytes(getFileUploadSizeLimit()),
      }),
    });
    return;
  }

  const nodeType = mediaNodeTypeForFile(file.type);
  const id = newPlaceholderAttachmentId();

  const stored = await enqueueUpload({
    attachmentId: id,
    pageId,
    kind: "media",
    nodeType,
    mode: "create",
    blob: file,
    fileName: file.name || "file",
    mimeType: file.type || "application/octet-stream",
    link: resolveDirtyPageLink(pageId),
  });

  if (!stored) {
    notifications.show({
      color: "red",
      message: i18n.t(
        "Could not save {{name}} on this device — storage is unavailable.",
        { name: file.name || "the file" },
      ),
    });
    return;
  }

  const dimensions =
    nodeType === "image" ? await probeImageDimensions(file) : undefined;

  const inserted = insertPendingNode(
    editor,
    pos,
    nodeType,
    pendingNodeAttrs(nodeType, {
      attachmentId: id,
      fileName: file.name || "file",
      fileSize: file.size,
      mimeType: file.type || "application/octet-stream",
      dimensions,
    }),
  );

  if (!inserted) {
    // No node means no rewrite target and nothing rendering the blob; the
    // record would replay into an attachment nothing references. Withdraw it —
    // and say plainly that the file was NOT saved, since the blob is gone.
    await deleteUploadRecord(id);
    notifications.show({
      color: "red",
      message: i18n.t(
        "{{name}} was not saved — it could not be inserted into the page.",
        { name: file.name || "The file" },
      ),
    });
    return;
  }

  notifyQueued(
    "Saved on this device — the file will upload when you're back online.",
  );
}

/**
 * Announce that an existing diagram's scene could not be loaded.
 *
 * Lives here so `excalidraw-menu.tsx` keeps its single offline import. The
 * call site matters more than the message: `handleOpen` used to open the
 * modal from its `finally` even when the scene fetch failed, handing the user
 * an **empty editable canvas over an existing diagram** — whose next save (or
 * 60 s autosave) overwrites the real content, queued blob included, with a
 * blank drawing. A failed load must therefore *refuse to open* and say why;
 * the drawing itself is safe where it was (server, outbox, or SW cache).
 */
export function notifyDiagramLoadFailed(): void {
  notifications.show({
    color: "red",
    message: i18n.t(
      "Could not load the diagram — check your connection and try again.",
    ),
  });
}

/** Re-exported so the touched call sites need exactly one import. */
export { shouldQueueUploadsOffline } from "./upload-interception";
