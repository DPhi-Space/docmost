import { beforeEach, describe, expect, it } from "vitest";
import {
  blockedUploads,
  clearUploadOutbox,
  deleteUploadRecord,
  enqueueUpload,
  isUploadOutboxRecord,
  listUploadRecords,
  markUploadBlocked,
  markUploadUploaded,
  newPlaceholderAttachmentId,
  pendingFileSrc,
  readUploadOutbox,
  readUploadRecord,
  selectUploadsToReplay,
  uploadsAwaitingRewrite,
  type EnqueueUploadInput,
  type UploadOutboxBackend,
  type UploadOutboxRecord,
} from "./upload-outbox";

function memoryBackend(): UploadOutboxBackend & {
  map: Map<string, UploadOutboxRecord>;
} {
  const map = new Map<string, UploadOutboxRecord>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    del: async (key) => void map.delete(key),
    entries: async () => [...map.entries()],
    clear: async () => map.clear(),
  };
}

function failingBackend(): UploadOutboxBackend {
  const boom = async () => {
    throw new Error("quota");
  };
  return {
    get: boom as UploadOutboxBackend["get"],
    set: boom as UploadOutboxBackend["set"],
    del: boom,
    entries: boom as UploadOutboxBackend["entries"],
    clear: boom,
  };
}

function blob(text = "svg"): Blob {
  return new Blob([text], { type: "image/svg+xml" });
}

function input(overrides: Partial<EnqueueUploadInput> = {}): EnqueueUploadInput {
  return {
    attachmentId: "att-1",
    pageId: "page-1",
    kind: "excalidraw",
    nodeType: "excalidraw",
    mode: "overwrite",
    blob: blob(),
    fileName: "diagram.excalidraw.svg",
    mimeType: "image/svg+xml",
    ...overrides,
  };
}

describe("enqueueUpload", () => {
  let backend: ReturnType<typeof memoryBackend>;
  beforeEach(() => {
    backend = memoryBackend();
  });

  it("stores a pending record with both timestamps", async () => {
    expect(await enqueueUpload(input(), backend, 1_000)).toBe(true);

    expect(backend.map.get("att-1")).toMatchObject({
      attachmentId: "att-1",
      pageId: "page-1",
      status: "pending",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("replaces the blob but keeps createdAt, mode and nodeType on a re-save", async () => {
    await enqueueUpload(input(), backend, 1_000);
    const newerBlob = blob("v2");
    await enqueueUpload(
      input({ blob: newerBlob, mode: "create", nodeType: "image" }),
      backend,
      5_000,
    );

    const record = backend.map.get("att-1")!;
    expect(record.createdAt).toBe(1_000);
    expect(record.updatedAt).toBe(5_000);
    // Identity fields survive: the first enqueue decided what this record is.
    expect(record.mode).toBe("overwrite");
    expect(record.nodeType).toBe("excalidraw");
    expect(record.blob).toBe(newerBlob);
  });

  it("clears a blocked mark on re-save — the refusal was about the old body", async () => {
    await enqueueUpload(input(), backend, 1_000);
    await markUploadBlocked("att-1", "rejected", backend, 2_000);
    await enqueueUpload(input({ blob: blob("smaller") }), backend, 3_000);

    expect(backend.map.get("att-1")!.blocked).toBeUndefined();
  });

  it("resets an uploaded record to pending — the new blob supersedes it", async () => {
    await enqueueUpload(input(), backend, 1_000);
    await markUploadUploaded(
      "att-1",
      { id: "real", fileName: "f.svg", fileSize: 1, mimeType: "image/svg+xml" },
      1_000,
      backend,
    );
    await enqueueUpload(input({ blob: blob("v2") }), backend, 5_000);

    expect(backend.map.get("att-1")!.status).toBe("pending");
  });

  it("reports failure so the caller can tell the user the save did not land", async () => {
    expect(await enqueueUpload(input(), failingBackend())).toBe(false);
  });
});

describe("markUploadUploaded", () => {
  let backend: ReturnType<typeof memoryBackend>;
  beforeEach(() => {
    backend = memoryBackend();
  });

  it("keeps the blob and records the server attachment", async () => {
    await enqueueUpload(input(), backend, 1_000);
    await markUploadUploaded(
      "att-1",
      { id: "real", fileName: "f.svg", fileSize: 9, mimeType: "image/svg+xml" },
      1_000,
      backend,
    );

    const record = backend.map.get("att-1")!;
    expect(record.status).toBe("uploaded");
    expect(record.uploaded?.id).toBe("real");
    expect(record.blob).toBeDefined();
  });

  it("refuses when a newer save replaced the blob mid-upload", async () => {
    await enqueueUpload(input(), backend, 1_000);
    // The replay read the record at t=1000, then the user saved again at
    // t=2000. Marking uploaded now would discard the newer save.
    await enqueueUpload(input({ blob: blob("newer") }), backend, 2_000);
    await markUploadUploaded(
      "att-1",
      { id: "real", fileName: "f.svg", fileSize: 9, mimeType: "image/svg+xml" },
      1_000,
      backend,
    );

    expect(backend.map.get("att-1")!.status).toBe("pending");
  });

  it("no-ops on a record deleted in the meantime", async () => {
    await markUploadUploaded(
      "att-1",
      { id: "real", fileName: "f.svg", fileSize: 9, mimeType: "image/svg+xml" },
      1_000,
      backend,
    );
    expect(backend.map.size).toBe(0);
  });
});

describe("markUploadBlocked", () => {
  it("marks and keeps the record", async () => {
    const backend = memoryBackend();
    await enqueueUpload(input(), backend, 1_000);
    await markUploadBlocked("att-1", "no-access", backend, 2_000);

    expect(backend.map.get("att-1")).toMatchObject({
      status: "pending",
      blocked: { reason: "no-access", at: 2_000 },
    });
  });

  it("no-ops when the entry is gone", async () => {
    const backend = memoryBackend();
    await markUploadBlocked("att-1", "no-access", backend, 2_000);
    expect(backend.map.size).toBe(0);
  });
});

describe("readUploadOutbox / listUploadRecords", () => {
  it("distinguishes an unreadable store from an empty one", async () => {
    expect(await readUploadOutbox(failingBackend())).toEqual({
      readable: false,
    });
    expect(await readUploadOutbox(memoryBackend())).toEqual({
      readable: true,
      records: [],
    });
  });

  it("filters malformed rows out of listings", async () => {
    const backend = memoryBackend();
    await enqueueUpload(input(), backend, 1_000);
    backend.map.set("junk", { half: "written" } as unknown as UploadOutboxRecord);

    expect(await listUploadRecords(backend)).toHaveLength(1);
  });

  it("lists nothing from an unreadable store (session expiry uses readUploadOutbox)", async () => {
    expect(await listUploadRecords(failingBackend())).toEqual([]);
  });
});

describe("selectUploadsToReplay", () => {
  const record = (
    id: string,
    createdAt: number,
    extra: Partial<UploadOutboxRecord> = {},
  ): UploadOutboxRecord => ({
    attachmentId: id,
    pageId: "page-1",
    kind: "media",
    nodeType: "image",
    mode: "create",
    blob: blob(),
    fileName: "a.png",
    mimeType: "image/png",
    createdAt,
    updatedAt: createdAt,
    status: "pending",
    ...extra,
  });

  it("orders by createdAt and excludes uploaded records", () => {
    const records = [
      record("b", 2_000),
      record("a", 1_000),
      record("c", 3_000, { status: "uploaded" }),
    ];
    expect(
      selectUploadsToReplay(records, { includeBlocked: true }).map(
        (r) => r.attachmentId,
      ),
    ).toEqual(["a", "b"]);
  });

  it("skips blocked entries on periodic passes but keeps them on trigger passes", () => {
    const records = [
      record("a", 1_000, { blocked: { reason: "no-access", at: 1 } }),
      record("b", 2_000),
    ];
    expect(
      selectUploadsToReplay(records, { includeBlocked: false }).map(
        (r) => r.attachmentId,
      ),
    ).toEqual(["b"]);
    expect(
      selectUploadsToReplay(records, { includeBlocked: true }).map(
        (r) => r.attachmentId,
      ),
    ).toEqual(["a", "b"]);
  });

  it("never removes anything: blocked entries stay listable", () => {
    const records = [
      record("a", 1_000, { blocked: { reason: "rejected", at: 1 } }),
    ];
    expect(blockedUploads(records)).toHaveLength(1);
  });
});

describe("uploadsAwaitingRewrite", () => {
  it("selects only uploaded records that carry the server attachment", () => {
    const base: UploadOutboxRecord = {
      attachmentId: "a",
      pageId: "p",
      kind: "media",
      nodeType: "image",
      mode: "create",
      blob: blob(),
      fileName: "a.png",
      mimeType: "image/png",
      createdAt: 1,
      updatedAt: 1,
      status: "uploaded",
      uploaded: { id: "r", fileName: "a.png", fileSize: 1, mimeType: "image/png" },
    };
    expect(uploadsAwaitingRewrite([base])).toHaveLength(1);
    expect(
      uploadsAwaitingRewrite([{ ...base, status: "pending" }]),
    ).toHaveLength(0);
    expect(
      uploadsAwaitingRewrite([{ ...base, uploaded: undefined }]),
    ).toHaveLength(0);
  });
});

describe("pendingFileSrc", () => {
  it("is shaped exactly like a real attachment URL", () => {
    expect(pendingFileSrc("11111111-2222-4333-8444-555555555555", "a b.png")).toBe(
      "/api/files/11111111-2222-4333-8444-555555555555/a%20b.png",
    );
  });
});

describe("newPlaceholderAttachmentId", () => {
  it("produces a UUID shape that ATTACHMENT_URL_RE-style matchers accept", () => {
    const id = newPlaceholderAttachmentId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("deleteUploadRecord / clearUploadOutbox", () => {
  it("delete and clear are best-effort and never throw", async () => {
    await expect(deleteUploadRecord("x", failingBackend())).resolves.toBeUndefined();
    await expect(clearUploadOutbox(failingBackend())).resolves.toBeUndefined();
  });

  it("readUploadRecord filters malformed rows", async () => {
    const backend = memoryBackend();
    backend.map.set("junk", { half: "written" } as unknown as UploadOutboxRecord);
    expect(await readUploadRecord("junk", backend)).toBeUndefined();
  });
});

describe("isUploadOutboxRecord", () => {
  it("requires the identifying fields", () => {
    expect(isUploadOutboxRecord(null)).toBe(false);
    expect(isUploadOutboxRecord({})).toBe(false);
    expect(
      isUploadOutboxRecord({
        attachmentId: "a",
        pageId: "p",
        fileName: "f",
      }),
    ).toBe(true);
  });
});
