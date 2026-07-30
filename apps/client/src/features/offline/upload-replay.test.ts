import { beforeEach, describe, expect, it } from "vitest";
import {
  replayUploadPass,
  type UploadReplayDeps,
  type UploadReplaySummary,
} from "./upload-replay";
import type { RewriteOutcome } from "./pending-node-rewrite";
import type {
  UploadOutboxRecord,
  UploadedAttachmentInfo,
} from "./upload-outbox";

function record(
  attachmentId: string,
  extra: Partial<UploadOutboxRecord> = {},
): UploadOutboxRecord {
  return {
    attachmentId,
    pageId: "page-1",
    kind: "media",
    nodeType: "image",
    mode: "create",
    blob: new Blob(["x"], { type: "image/png" }),
    fileName: "a.png",
    mimeType: "image/png",
    createdAt: 1,
    updatedAt: 1,
    status: "pending",
    ...extra,
  };
}

interface Harness {
  deps: UploadReplayDeps;
  store: Map<string, UploadOutboxRecord>;
  uploads: Array<{ fileName: string; pageId: string; attachmentId?: string }>;
  published: Array<readonly UploadOutboxRecord[]>;
  rewrites: string[];
}

function harness(
  records: UploadOutboxRecord[],
  options: {
    uploadResult?: (r: {
      attachmentId?: string;
    }) => Promise<UploadedAttachmentInfo>;
    rewriteOutcome?: RewriteOutcome;
    isOnline?: () => boolean;
  } = {},
): Harness {
  const store = new Map(records.map((r) => [r.attachmentId, r]));
  const uploads: Harness["uploads"] = [];
  const published: Harness["published"] = [];
  const rewrites: string[] = [];

  const deps: UploadReplayDeps = {
    listUploadRecords: async () => [...store.values()],
    readUploadRecord: async (id) => store.get(id),
    markUploadUploaded: async (id, uploaded, asOf) => {
      const existing = store.get(id);
      if (!existing || existing.updatedAt > asOf) return;
      store.set(id, { ...existing, status: "uploaded", uploaded, blocked: undefined });
    },
    markUploadBlocked: async (id, reason) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, blocked: { reason, at: 9 } });
    },
    deleteUploadRecord: async (id) => void store.delete(id),
    upload: async (file, pageId, attachmentId) => {
      uploads.push({ fileName: file.name, pageId, attachmentId });
      if (options.uploadResult) return options.uploadResult({ attachmentId });
      return {
        id: "server-id",
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      };
    },
    attemptRewrite: (r) => {
      rewrites.push(r.attachmentId);
      return options.rewriteOutcome ?? "unavailable";
    },
    isOnline: options.isOnline ?? (() => true),
    publish: (records) => void published.push(records),
    log: () => {},
  };

  return { deps, store, uploads, published, rewrites };
}

describe("replayUploadPass", () => {
  it("uploads oldest first and marks records uploaded", async () => {
    const h = harness([
      record("b", { createdAt: 2, fileName: "b.png" }),
      record("a", { createdAt: 1, fileName: "a.png" }),
    ]);

    const summary = await replayUploadPass(true, h.deps);

    expect(h.uploads.map((u) => u.fileName)).toEqual(["a.png", "b.png"]);
    expect(summary).toMatchObject({ attempted: 2, uploaded: 2, deferred: 0 });
  });

  it("sends the attachment id only for overwrites — placeholders never reach the server", async () => {
    const h = harness([
      record("real-id", { mode: "overwrite", kind: "excalidraw" }),
      record("placeholder-id", { mode: "create" }),
    ]);

    await replayUploadPass(true, h.deps);

    expect(h.uploads.map((u) => u.attachmentId).sort()).toEqual([
      "real-id",
      undefined,
    ].sort());
  });

  it("keeps a create record after upload when the page is not open (deferred rewrite)", async () => {
    const h = harness([record("p1", { mode: "create" })], {
      rewriteOutcome: "unavailable",
    });

    await replayUploadPass(true, h.deps);

    const kept = h.store.get("p1");
    expect(kept?.status).toBe("uploaded");
    expect(kept?.uploaded?.id).toBe("server-id");
  });

  it("deletes a create record once the rewrite lands", async () => {
    const h = harness([record("p1", { mode: "create" })], {
      rewriteOutcome: "rewritten",
    });

    await replayUploadPass(true, h.deps);

    expect(h.store.has("p1")).toBe(false);
  });

  it("deletes an overwrite record even without a rewrite — the node already points at the real id", async () => {
    const h = harness(
      [record("real-id", { mode: "overwrite", kind: "excalidraw" })],
      { rewriteOutcome: "unavailable" },
    );

    await replayUploadPass(true, h.deps);

    expect(h.store.has("real-id")).toBe(false);
  });

  it("marks a refused upload blocked and keeps the blob", async () => {
    const h = harness([record("p1")], {
      uploadResult: async () => {
        const error = new Error("forbidden") as Error & {
          response: { status: number };
        };
        error.response = { status: 403 };
        throw error;
      },
    });

    const summary = await replayUploadPass(true, h.deps);

    expect(summary.blocked).toBe(1);
    expect(h.store.get("p1")).toMatchObject({
      status: "pending",
      blocked: { reason: "no-access" },
    });
  });

  it("defers on transport failures without marking anything", async () => {
    const h = harness([record("p1")], {
      uploadResult: async () => {
        throw new Error("network down");
      },
    });

    const summary = await replayUploadPass(true, h.deps);

    expect(summary.deferred).toBe(1);
    expect(h.store.get("p1")?.blocked).toBeUndefined();
  });

  it("skips blocked records on periodic passes and retries them on trigger passes", async () => {
    const blocked = record("p1", {
      blocked: { reason: "no-access", at: 1 },
    });

    const periodic = harness([blocked]);
    await replayUploadPass(false, periodic.deps);
    expect(periodic.uploads).toHaveLength(0);

    const triggered = harness([blocked]);
    await replayUploadPass(true, triggered.deps);
    expect(triggered.uploads).toHaveLength(1);
  });

  it("stops when connectivity dies mid-pass and defers the remainder", async () => {
    let calls = 0;
    const h = harness(
      [record("a", { createdAt: 1 }), record("b", { createdAt: 2 })],
      { isOnline: () => calls++ < 1 },
    );

    const summary = await replayUploadPass(true, h.deps);

    expect(h.uploads).toHaveLength(1);
    expect(summary.deferred).toBe(1);
  });

  it("treats a record re-saved mid-upload as still pending", async () => {
    // The user saved again while the old blob was in flight; the newer blob
    // must be replayed, not marked done.
    const h = harness([record("p1", { updatedAt: 1 })]);
    const original = h.deps.upload;
    h.deps.upload = async (file, pageId, attachmentId) => {
      const existing = h.store.get("p1")!;
      h.store.set("p1", {
        ...existing,
        blob: new Blob(["newer"]),
        updatedAt: 99,
      });
      return original(file, pageId, attachmentId);
    };

    const summary = await replayUploadPass(true, h.deps);

    expect(summary.deferred).toBe(1);
    expect(h.store.get("p1")?.status).toBe("pending");
  });

  it("settles rewrites for already-uploaded records before uploading anything", async () => {
    const h = harness(
      [
        record("done", {
          status: "uploaded",
          uploaded: {
            id: "server-id",
            fileName: "a.png",
            fileSize: 1,
            mimeType: "image/png",
          },
        }),
      ],
      { rewriteOutcome: "node-gone" },
    );

    await replayUploadPass(true, h.deps);

    // The node was deleted by the user; the attachment on the server simply
    // goes unreferenced and the record has nothing left to do.
    expect(h.store.has("done")).toBe(false);
    expect(h.uploads).toHaveLength(0);
  });

  it("publishes the outbox state after the pass", async () => {
    const h = harness([record("p1")]);

    await replayUploadPass(true, h.deps);

    expect(h.published.length).toBe(1);
  });

  it("returns an empty summary for an empty outbox without publishing churn", async () => {
    const h = harness([]);

    const summary: UploadReplaySummary = await replayUploadPass(true, h.deps);

    expect(summary).toEqual({
      attempted: 0,
      uploaded: 0,
      blocked: 0,
      deferred: 0,
    });
    expect(h.published).toHaveLength(0);
  });
});
