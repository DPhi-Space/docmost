import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isInitialEmptyDoc,
  rewritePendingNode,
  settleDeferredRewrites,
  startPendingRewriteWatcher,
  REWRITE_ATTEMPT_DELAYS_MS,
  type RewriteEditor,
} from "./pending-node-rewrite";
import type { UploadOutboxRecord } from "./upload-outbox";

function record(extra: Partial<UploadOutboxRecord> = {}): UploadOutboxRecord {
  return {
    attachmentId: "placeholder-id",
    pageId: "page-1",
    kind: "media",
    nodeType: "image",
    mode: "create",
    blob: new Blob(["x"]),
    fileName: "a.png",
    mimeType: "image/png",
    createdAt: 1,
    updatedAt: 1,
    status: "uploaded",
    uploaded: {
      id: "server-id",
      fileName: "a.png",
      fileSize: 1,
      mimeType: "image/png",
    },
    ...extra,
  };
}

interface FakeNode {
  type: { name: string };
  attrs: Record<string, unknown>;
}

/** A minimal editor whose command sees a doc of flat nodes. */
function fakeEditor(nodes: FakeNode[]): RewriteEditor & {
  markups: Array<{ pos: number; attrs: Record<string, unknown> }>;
} {
  const markups: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  return {
    isDestroyed: false,
    storage: { pageId: "page-1" },
    state: {
      doc: {
        childCount: nodes.length,
        firstChild: null,
      },
    },
    commands: {
      command(fn) {
        return fn({
          tr: {
            doc: {
              descendants(visitor) {
                nodes.forEach((node, index) => visitor(node, index * 2));
              },
            },
            setNodeMarkup(pos, _type, attrs) {
              markups.push({ pos, attrs });
              return undefined;
            },
          },
        });
      },
    },
    markups,
  };
}

describe("isInitialEmptyDoc", () => {
  it("reads one empty text block as not-yet-loaded", () => {
    expect(
      isInitialEmptyDoc({
        childCount: 1,
        firstChild: { isTextblock: true, content: { size: 0 } },
      }),
    ).toBe(true);
    expect(isInitialEmptyDoc({ childCount: 0, firstChild: null })).toBe(true);
  });

  it("reads a media-only page as loaded — its child is not a text block", () => {
    expect(
      isInitialEmptyDoc({
        childCount: 1,
        firstChild: { isTextblock: false, content: { size: 0 } },
      }),
    ).toBe(false);
  });

  it("reads any real content as loaded", () => {
    expect(
      isInitialEmptyDoc({
        childCount: 1,
        firstChild: { isTextblock: true, content: { size: 3 } },
      }),
    ).toBe(false);
    expect(
      isInitialEmptyDoc({
        childCount: 2,
        firstChild: { isTextblock: true, content: { size: 0 } },
      }),
    ).toBe(false);
  });
});

describe("rewritePendingNode", () => {
  it("rewrites every node carrying the placeholder id, merging over its attrs", () => {
    const editor = fakeEditor([
      {
        type: { name: "image" },
        attrs: { attachmentId: "placeholder-id", width: 300, align: "center" },
      },
      { type: { name: "image" }, attrs: { attachmentId: "other" } },
      // A copied duplicate of the pending node.
      {
        type: { name: "image" },
        attrs: { attachmentId: "placeholder-id", width: 120 },
      },
    ]);

    const outcome = rewritePendingNode(editor, record());

    expect(outcome).toBe("rewritten");
    expect(editor.markups).toHaveLength(2);
    // Descending order so earlier rewrites cannot shift later positions.
    expect(editor.markups.map((m) => m.pos)).toEqual([4, 0]);
    expect(editor.markups[1].attrs).toMatchObject({
      attachmentId: "server-id",
      src: "/api/files/server-id/a.png",
      width: 300,
      align: "center",
    });
  });

  it("only touches nodes of the record's type", () => {
    const editor = fakeEditor([
      { type: { name: "video" }, attrs: { attachmentId: "placeholder-id" } },
    ]);

    expect(rewritePendingNode(editor, record())).toBe("node-gone");
    expect(editor.markups).toHaveLength(0);
  });

  it("reports node-gone when nothing references the record", () => {
    const editor = fakeEditor([]);
    expect(rewritePendingNode(editor, record())).toBe("node-gone");
  });

  it("reports unavailable when the editor throws", () => {
    const editor = fakeEditor([]);
    editor.commands.command = () => {
      throw new Error("editor destroyed mid-call");
    };
    expect(rewritePendingNode(editor, record())).toBe("unavailable");
  });

  it("reports unavailable for a record with no uploaded attachment", () => {
    const editor = fakeEditor([]);
    expect(
      rewritePendingNode(editor, record({ uploaded: undefined })),
    ).toBe("unavailable");
  });
});

describe("settleDeferredRewrites", () => {
  it("deletes records whose rewrite landed or whose node is gone, keeps the rest", async () => {
    const deleted: string[] = [];
    const outcomes: Record<string, "rewritten" | "node-gone" | "unavailable"> = {
      a: "rewritten",
      b: "node-gone",
      c: "unavailable",
    };

    const settled = await settleDeferredRewrites({
      listUploadRecords: async () => [
        record({ attachmentId: "a" }),
        record({ attachmentId: "b" }),
        record({ attachmentId: "c" }),
        // Still pending: not awaiting a rewrite at all.
        record({ attachmentId: "d", status: "pending", uploaded: undefined }),
      ],
      deleteUploadRecord: async (id) => void deleted.push(id),
      attempt: (r) => outcomes[r.attachmentId],
    });

    expect(settled).toBe(2);
    expect(deleted.sort()).toEqual(["a", "b"]);
  });
});

describe("startPendingRewriteWatcher", () => {
  let listeners: Array<(pageId: string | null) => void>;
  let timers: Array<{ fn: () => void; ms: number }>;

  beforeEach(() => {
    listeners = [];
    timers = [];
  });

  const subscribe = (listener: (pageId: string | null) => void) => {
    listeners.push(listener);
    return () => {};
  };

  it("schedules spaced attempts when a page opens", () => {
    const settle = vi.fn(async () => 0);
    startPendingRewriteWatcher({
      subscribe,
      settle,
      setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
      clearTimer: () => {},
    });

    listeners[0]("page-1");

    expect(timers.map((t) => t.ms)).toEqual(REWRITE_ATTEMPT_DELAYS_MS);
    timers[0].fn();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("cancels scheduled attempts when the page closes", () => {
    const cleared: number[] = [];
    startPendingRewriteWatcher({
      subscribe,
      settle: async () => 0,
      setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
      clearTimer: (handle) => void cleared.push(handle),
    });

    listeners[0]("page-1");
    listeners[0](null);

    expect(cleared).toHaveLength(REWRITE_ATTEMPT_DELAYS_MS.length);
  });

  it("stops listening and cancels timers on teardown", () => {
    const cleared: number[] = [];
    let unsubscribed = false;
    const stop = startPendingRewriteWatcher({
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          unsubscribed = true;
        };
      },
      settle: async () => 0,
      setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
      clearTimer: (handle) => void cleared.push(handle),
    });

    listeners[0]("page-1");
    stop();

    expect(unsubscribed).toBe(true);
    expect(cleared).toHaveLength(REWRITE_ATTEMPT_DELAYS_MS.length);
  });
});
