/**
 * Rewriting a pending node to its real attachment — the step that closes a
 * `create` upload's loop. Until it runs, the document points at a placeholder
 * id only this browser's outbox can answer; after it, the node is an ordinary
 * attachment reference every client can render.
 *
 * ## Deferral over ephemeral providers — the issue's explicit preference
 *
 * A rewrite is a document edit, and phase 4 makes document edits **only
 * through a live page editor**. When the page is open, the rewrite happens
 * immediately; when it is not, it waits for the next time the page opens in
 * this tab. Issue #21 names this "the simplest correct option" and it keeps
 * the fork's core promise: no code here constructs a provider session or
 * transforms a ydoc outside the editor. The cost, stated plainly in AGENTS.md:
 * until the owner of the queued upload reopens the page here, other clients
 * see the placeholder URL as a broken attachment.
 *
 * ## How the editor is reached without touching `page-editor.tsx`
 *
 * `page-editor.tsx` already publishes its live editor into `pageEditorAtom`
 * (upstream behaviour — the comment sidebar and title editor read it), and the
 * app mounts no jotai `Provider`, so the default store carries it. Reading the
 * atom from here costs zero lines in any upstream file.
 *
 * ## When "the node is gone" may be believed
 *
 * Declaring the node deleted deletes the record, and with it the only renderer
 * of the placeholder URL — so a false "gone" bricks the node forever. Three
 * guards make the verdict trustworthy: the open-page claim must name the
 * record's page, the editor instance must agree it is showing that page
 * (`editor.storage.pageId`), and the document must not be in its initial-empty
 * state — a freshly mounted editor holds one empty paragraph until y-indexeddb
 * replays, and "empty" must read as *not loaded yet*, never as *deleted*.
 */

import { getDefaultStore } from "jotai";
import type { Editor } from "@tiptap/core";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import { uploadedNodeAttrs } from "./pending-media";
import { getOpenPage, subscribeOpenPage } from "./open-page-registry";
import {
  deleteUploadRecord,
  listUploadRecords,
  uploadsAwaitingRewrite,
  type UploadOutboxRecord,
} from "./upload-outbox";

export type RewriteOutcome =
  /** The node now carries the real attachment attrs. */
  | "rewritten"
  /** The page is on screen and loaded, and no node references the record. */
  | "node-gone"
  /** No trustworthy editor for this page right now; try again later. */
  | "unavailable";

/** The document slice the emptiness check needs; structural for tests. */
interface DocLike {
  childCount: number;
  firstChild: { isTextblock: boolean; content: { size: number } } | null;
}

/**
 * The initial-empty document a just-mounted editor holds before y-indexeddb
 * replays: exactly one empty text block. A page whose only content is the
 * pending node itself does not match (its child is not a text block), so this
 * cannot misread a media-only page as unloaded.
 */
export function isInitialEmptyDoc(doc: DocLike): boolean {
  if (doc.childCount === 0) return true;
  return (
    doc.childCount === 1 &&
    doc.firstChild !== null &&
    doc.firstChild.isTextblock &&
    doc.firstChild.content.size === 0
  );
}

/** The editor surface the rewrite uses; structural so tests need no tiptap. */
export interface RewriteEditor {
  isDestroyed: boolean;
  storage: { pageId?: string };
  state: { doc: DocLike };
  commands: {
    command(fn: (props: { tr: RewriteTr }) => boolean): boolean;
  };
}

interface RewriteTr {
  doc: {
    descendants(
      visitor: (
        node: {
          type: { name: string };
          attrs: Record<string, unknown>;
        },
        pos: number,
      ) => boolean | void,
    ): void;
  };
  setNodeMarkup(
    pos: number,
    type: undefined,
    attrs: Record<string, unknown>,
  ): unknown;
}

/**
 * Rewrite every node referencing the record's placeholder id (a pending node
 * can be duplicated by copy/paste) to the uploaded attachment, merging over
 * the node's current attrs so width/align survive.
 */
export function rewritePendingNode(
  editor: RewriteEditor,
  record: UploadOutboxRecord,
): RewriteOutcome {
  const uploaded = record.uploaded;
  if (!uploaded) return "unavailable";

  try {
    let found = false;
    editor.commands.command(({ tr }) => {
      const targets: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
      tr.doc.descendants((node, pos) => {
        if (node.type.name !== record.nodeType) return;
        if (node.attrs.attachmentId !== record.attachmentId) return;
        targets.push({ pos, attrs: node.attrs });
      });
      if (targets.length === 0) return false;
      found = true;
      // Descending positions so earlier rewrites cannot shift later targets.
      for (const target of targets.sort((a, b) => b.pos - a.pos)) {
        const next: Record<string, unknown> = {
          ...target.attrs,
          ...uploadedNodeAttrs(record.nodeType, uploaded),
        };
        /**
         * An Excalidraw node with no `src` is one the user has created but
         * never explicitly saved — the modal's 30 s autosave uploads content
         * and records only the attachment id, and the node keeps rendering as
         * the "double-click to edit" card until Save & Exit sets `src`
         * (upstream's `updateSrc=false` path). Introducing `src` here would
         * flip the node into its image view, which recreates the node view —
         * and if the modal is open mid-draw, tears it down. Rewrite the id
         * and leave `src` in whatever state the user's actions put it.
         */
        if (record.nodeType === "excalidraw" && !target.attrs.src) {
          delete next.src;
        }
        tr.setNodeMarkup(target.pos, undefined, next);
      }
      return true;
    });
    return found ? "rewritten" : "node-gone";
  } catch {
    return "unavailable";
  }
}

function liveEditorForPage(pageId: string): RewriteEditor | null {
  if (getOpenPage() !== pageId) return null;
  let editor: Editor | null;
  try {
    editor = getDefaultStore().get(pageEditorAtom);
  } catch {
    return null;
  }
  if (!editor || editor.isDestroyed) return null;
  const candidate = editor as unknown as RewriteEditor;
  // The atom can briefly hold the previous page's editor across navigation;
  // the instance itself must agree about which page it is showing.
  if (candidate.storage?.pageId !== pageId) return null;
  if (isInitialEmptyDoc(candidate.state.doc)) return null;
  return candidate;
}

/**
 * Try the rewrite against the page's live editor, if there is one worth
 * trusting. Pure lookup + `rewritePendingNode`; deciding what to do with the
 * outcome is the caller's job.
 */
export function attemptPendingRewrite(
  record: UploadOutboxRecord,
): RewriteOutcome {
  const editor = liveEditorForPage(record.pageId);
  if (!editor) return "unavailable";
  return rewritePendingNode(editor, record);
}

/**
 * Settle every rewrite that can be settled right now: `rewritten` and
 * `node-gone` both delete the record — in the first case the document no
 * longer references the placeholder; in the second the user deleted the node,
 * and the uploaded attachment simply goes unreferenced, exactly as if they had
 * deleted an image moments after inserting it online.
 */
export async function settleDeferredRewrites(
  deps: {
    listUploadRecords?: typeof listUploadRecords;
    deleteUploadRecord?: typeof deleteUploadRecord;
    attempt?: typeof attemptPendingRewrite;
  } = {},
): Promise<number> {
  const {
    listUploadRecords: list = listUploadRecords,
    deleteUploadRecord: remove = deleteUploadRecord,
    attempt = attemptPendingRewrite,
  } = deps;

  let settled = 0;
  for (const record of uploadsAwaitingRewrite(await list())) {
    const outcome = attempt(record);
    if (outcome === "rewritten" || outcome === "node-gone") {
      await remove(record.attachmentId);
      settled += 1;
    }
  }
  return settled;
}

/** Delays after a page opens before each rewrite attempt (y-indexeddb replay
 * and the editor's first real render land within the first few seconds). */
export const REWRITE_ATTEMPT_DELAYS_MS = [1_000, 3_000, 8_000, 15_000];

/**
 * Watch for pages opening and run the deferred rewrites for them.
 *
 * A few spaced attempts rather than one: the claim is made before the editor
 * has replayed its local document, so the first attempt commonly finds the
 * initial-empty doc and reports `unavailable`. Attempts stop early once
 * nothing for that page remains.
 *
 * Created and torn down alongside the resync manager (`use-offline-resync.ts`)
 * so the switch's "off means no listeners" promise holds.
 */
export function startPendingRewriteWatcher(
  deps: {
    subscribe?: typeof subscribeOpenPage;
    settle?: () => Promise<number>;
    onSettled?: (count: number) => void;
    setTimer?: (fn: () => void, ms: number) => number;
    clearTimer?: (handle: number) => void;
  } = {},
): () => void {
  const {
    subscribe = subscribeOpenPage,
    settle = settleDeferredRewrites,
    onSettled,
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimer = (handle) => globalThis.clearTimeout(handle),
  } = deps;

  let timers: number[] = [];

  const cancelAll = () => {
    for (const timer of timers) clearTimer(timer);
    timers = [];
  };

  const unsubscribe = subscribe((pageId) => {
    cancelAll();
    if (!pageId) return;
    for (const delay of REWRITE_ATTEMPT_DELAYS_MS) {
      timers.push(
        setTimer(() => {
          void settle().then((count) => {
            if (count > 0) onSettled?.(count);
          });
        }, delay),
      );
    }
  });

  return () => {
    cancelAll();
    unsubscribe();
  };
}
