import { beforeEach, describe, expect, it } from "vitest";
import {
  purgeCachedAttachment,
  replayUploadPass,
  type CacheStorageLike,
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
  uploads: Array<{
    fileName: string;
    fileSize: number;
    pageId: string;
    attachmentId?: string;
  }>;
  published: Array<readonly UploadOutboxRecord[]>;
  rewrites: string[];
  purged: string[];
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
  const purged: string[] = [];

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
      uploads.push({ fileName: file.name, fileSize: file.size, pageId, attachmentId });
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
    purgeCachedFile: async (attachmentId) => void purged.push(attachmentId),
    isOnline: options.isOnline ?? (() => true),
    publish: (records) => void published.push(records),
    log: () => {},
  };

  return { deps, store, uploads, published, rewrites, purged };
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

  it("purges the SW files cache when an overwrite is deleted without a rewrite (F3)", async () => {
    // The cache can hold the diagram's PRE-save bytes under the node's URL;
    // with the record gone, an offline reopen would be handed a stale scene as
    // an editable base whose next save clobbers the user's own newer version.
    const h = harness(
      [record("real-id", { mode: "overwrite", kind: "excalidraw" })],
      { rewriteOutcome: "unavailable" },
    );

    await replayUploadPass(true, h.deps);

    expect(h.purged).toEqual(["real-id"]);
    expect(h.store.has("real-id")).toBe(false);
  });

  it("purges the SW files cache on the rewritten-overwrite path too", async () => {
    const h = harness(
      [record("real-id", { mode: "overwrite", kind: "excalidraw" })],
      { rewriteOutcome: "rewritten" },
    );

    await replayUploadPass(true, h.deps);

    expect(h.purged).toEqual(["real-id"]);
  });

  it("does not purge for create records — their placeholder URL was never network-cached", async () => {
    const h = harness([record("p1", { mode: "create" })], {
      rewriteOutcome: "rewritten",
    });

    await replayUploadPass(true, h.deps);

    expect(h.purged).toEqual([]);
  });

  it("skips a record deleted between the snapshot and its turn (F5)", async () => {
    // The user saved the same diagram directly online mid-pass; the online
    // repair path withdrew the record. Uploading the snapshot's blob would
    // replay OLD bytes over their newer server version.
    const h = harness([
      record("a", { createdAt: 1 }),
      record("b", { createdAt: 2, mode: "overwrite" }),
    ]);
    const original = h.deps.upload;
    h.deps.upload = async (file, pageId, attachmentId) => {
      // While "a" uploads, "b" is settled elsewhere and deleted.
      h.store.delete("b");
      return original(file, pageId, attachmentId);
    };

    const summary = await replayUploadPass(true, h.deps);

    expect(h.uploads.map((u) => u.fileName)).toEqual(["a.png"]);
    expect(summary).toMatchObject({ uploaded: 1, blocked: 0, deferred: 0 });
  });

  it("uploads the FRESH blob when a record was re-saved before its turn (F5)", async () => {
    const h = harness([
      record("a", { createdAt: 1 }),
      record("b", { createdAt: 2, blob: new Blob(["old"]), updatedAt: 2 }),
    ]);
    const original = h.deps.upload;
    h.deps.upload = async (file, pageId, attachmentId) => {
      if (h.store.get("b")?.updatedAt === 2) {
        // While "a" uploads, the user re-saves "b" with a bigger blob.
        h.store.set("b", {
          ...h.store.get("b")!,
          blob: new Blob(["much-newer-content"]),
          updatedAt: 99,
        });
      }
      return original(file, pageId, attachmentId);
    };

    const summary = await replayUploadPass(true, h.deps);

    // The second upload carried the fresh 18-byte blob, not the stale 3-byte
    // one, and — because asOf was re-read too — the record settles as
    // uploaded rather than looping as a phantom re-save.
    expect(h.uploads.map((u) => u.fileSize)).toEqual([1, 18]);
    expect(summary.uploaded).toBe(2);
    expect(h.store.get("b")?.status).toBe("uploaded");
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

describe("purgeCachedAttachment", () => {
  function fakeCacheStorage(urls: string[]): CacheStorageLike & {
    deleted: string[];
    opened: string[];
  } {
    const deleted: string[] = [];
    const opened: string[] = [];
    return {
      deleted,
      opened,
      open: async (name) => {
        opened.push(name);
        return {
          keys: async () => urls.map((url) => ({ url })),
          delete: async (request: { url: string }) => {
            deleted.push(request.url);
            return true;
          },
        };
      },
    };
  }

  // Server ids are uuid7; the path matcher requires a hex-shaped id, so the
  // fixtures use one (a non-hex id like "real-id" is correctly not matched).
  const ID = "01912345-6789-7abc-8def-0123456789ab";

  it("deletes every cached variant of the attachment's URL, query strings included", async () => {
    const storage = fakeCacheStorage([
      `https://docs.example.com/api/files/${ID}/diagram.excalidraw.svg?t=111`,
      `https://docs.example.com/api/files/${ID}/diagram.excalidraw.svg?t=222`,
      "https://docs.example.com/api/files/01919999-0000-7000-8000-000000000000/photo.png",
    ]);

    await purgeCachedAttachment(ID, storage);

    expect(storage.opened).toEqual(["docmost-offline-files-v1"]);
    expect(storage.deleted).toEqual([
      `https://docs.example.com/api/files/${ID}/diagram.excalidraw.svg?t=111`,
      `https://docs.example.com/api/files/${ID}/diagram.excalidraw.svg?t=222`,
    ]);
  });

  it("survives a missing or throwing Cache Storage", async () => {
    await expect(purgeCachedAttachment("real-id", null)).resolves.toBeUndefined();
    await expect(
      purgeCachedAttachment("real-id", {
        open: async () => {
          throw new Error("blocked");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
