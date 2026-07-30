/**
 * What a queued upload looks like *inside the document*: the node attrs a
 * pending upload carries, the attrs it is rewritten to once the server has
 * accepted it, and the insertion command for new media.
 *
 * This is the one module that knows the attr shapes of the five node types, so
 * the knowledge cannot drift between the enqueue path and the rewrite path.
 * The shapes are transcriptions of the upstream upload pipeline — the final
 * `tr.setNodeMarkup` calls in `packages/editor-ext/src/lib/{image,video,pdf,
 * attachment}-upload.ts` and the `updateAttributes` call in
 * `excalidraw-menu.tsx` — not designs of our own.
 *
 * ## Why a pending node carries a REAL-shaped attachment URL
 *
 * A pending node's `src`/`url` is `/api/files/<placeholderId>/<fileName>` —
 * indistinguishable in shape from a real attachment URL. That single decision
 * is what keeps this feature out of the upstream node views: the browser
 * fetches the URL exactly as it would a real one, the service worker's
 * existing `api-file` route intercepts it, and `sw/outbox-serving.ts` answers
 * from the outbox blob. It also survives reload for free — an object URL dies
 * with the document, but the outbox record does not, so the re-derivation the
 * issue asks for ("re-derive from the outbox blob after reload") happens on
 * every render, in one place, for every node type at once.
 *
 * The cost, stated plainly: with no service worker (the dev server, a browser
 * with SW disabled) a pending node renders as a broken image until the upload
 * replays. Production always has the worker; the trade buys zero diffs to four
 * upstream node views.
 */

import type { Editor } from "@tiptap/core";
import {
  pendingFileSrc,
  type PendingNodeType,
  type UploadedAttachmentInfo,
} from "./upload-outbox";

/** Best-effort image dimensions, so a pending image keeps its aspect ratio. */
export interface MediaDimensions {
  width?: number;
  height?: number;
  aspectRatio?: number;
}

export async function probeImageDimensions(
  blob: Blob,
): Promise<MediaDimensions> {
  // `createImageBitmap` is native and needs no dependency; the upstream path
  // uses the `image-dimensions` package, which is not a client dependency.
  try {
    if (typeof createImageBitmap !== "function") return {};
    const bitmap = await createImageBitmap(blob);
    const dims = {
      width: bitmap.width,
      height: bitmap.height,
      aspectRatio: bitmap.height > 0 ? bitmap.width / bitmap.height : undefined,
    };
    bitmap.close?.();
    return dims;
  } catch {
    return {};
  }
}

export interface PendingAttrsInput {
  attachmentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  dimensions?: MediaDimensions;
  /** For Excalidraw only: the `?t=` cache-buster, `Date.now()` in production. */
  timestamp?: number;
}

/** The attrs a node carries while its upload sits in the outbox. */
export function pendingNodeAttrs(
  nodeType: PendingNodeType,
  input: PendingAttrsInput,
): Record<string, unknown> {
  const src = pendingFileSrc(input.attachmentId, input.fileName);
  const dims = input.dimensions ?? {};
  switch (nodeType) {
    case "image":
      return {
        src,
        attachmentId: input.attachmentId,
        size: input.fileSize,
        width: dims.width,
        height: dims.height,
        aspectRatio: dims.aspectRatio,
      };
    case "video":
      return {
        src,
        attachmentId: input.attachmentId,
        title: input.fileName,
        size: input.fileSize,
        width: dims.width,
        height: dims.height,
        aspectRatio: dims.aspectRatio,
      };
    case "pdf":
      return {
        src,
        name: input.fileName,
        attachmentId: input.attachmentId,
        size: input.fileSize,
      };
    case "attachment":
      return {
        url: src,
        name: input.fileName,
        mime: input.mimeType,
        size: input.fileSize,
        attachmentId: input.attachmentId,
      };
    case "excalidraw":
      return {
        src: `${src}?t=${input.timestamp ?? 0}`,
        title: input.fileName,
        size: input.fileSize,
        attachmentId: input.attachmentId,
      };
  }
}

/**
 * The attrs a node is rewritten to once the server has assigned the real
 * attachment. Applied as a *merge* over the node's current attrs (unlike the
 * upstream `setNodeMarkup` full replace), so width/height/align survive.
 */
export function uploadedNodeAttrs(
  nodeType: PendingNodeType,
  uploaded: UploadedAttachmentInfo,
): Record<string, unknown> {
  const src = `/api/files/${uploaded.id}/${uploaded.fileName}`;
  switch (nodeType) {
    case "image":
      return { src, attachmentId: uploaded.id, size: uploaded.fileSize };
    case "video":
      return {
        src,
        attachmentId: uploaded.id,
        title: uploaded.fileName,
        size: uploaded.fileSize,
      };
    case "pdf":
      return {
        src,
        name: uploaded.fileName,
        attachmentId: uploaded.id,
        size: uploaded.fileSize,
      };
    case "attachment":
      return {
        url: src,
        name: uploaded.fileName,
        mime: uploaded.mimeType,
        size: uploaded.fileSize,
        attachmentId: uploaded.id,
      };
    case "excalidraw": {
      const t = uploaded.updatedAt ? new Date(uploaded.updatedAt).getTime() : 0;
      return {
        src: `${src}?t=${t}`,
        title: uploaded.fileName,
        size: uploaded.fileSize,
        attachmentId: uploaded.id,
      };
    }
  }
}

/**
 * Insert a pending node, mirroring the placeholder insertion of the upstream
 * upload actions: an empty text block is replaced, anything else gets the node
 * inserted at `pos`. The position is clamped rather than trusted — a drop
 * coordinate can resolve past the end of a document that changed under it.
 */
export function insertPendingNode(
  editor: Editor,
  pos: number,
  nodeType: PendingNodeType,
  attrs: Record<string, unknown>,
): boolean {
  return editor.commands.command(({ tr, state }) => {
    const type = state.schema.nodes[nodeType];
    if (!type) return false;
    let node;
    try {
      node = type.create(attrs);
    } catch {
      return false;
    }

    const max = tr.doc.content.size;
    const at = Math.min(Math.max(pos, 0), max);
    const { parent } = tr.doc.resolve(at);
    const isEmptyTextBlock = parent.isTextblock && !parent.childCount;

    if (isEmptyTextBlock && at > 0) {
      tr.replaceRangeWith(at - 1, Math.min(at + 1, max), node);
    } else {
      tr.insert(at, node);
    }
    return true;
  });
}
