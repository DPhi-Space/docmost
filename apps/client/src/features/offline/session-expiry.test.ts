import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOfflineDataOnSessionExpiry,
  clearPendingRecovery,
  forgetOfflineDataOwner,
  OFFLINE_DATA_OWNER_KEY,
  PENDING_RECOVERY_KEY,
  readOfflineDataOwnerHint,
  readPendingRecovery,
  rememberOfflineDataOwner,
  type SessionExpiryDeps,
  type StorageLike,
} from "./session-expiry";
import type { ClearOfflineDataDeps } from "./clear-offline-data";
import type { DirtyPageRecord, DirtyPagesRead } from "./dirty-pages";
import type { UploadOutboxRecord } from "./upload-outbox";

function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const record = (pageId: string, title?: string): DirtyPageRecord => ({
  pageId,
  dirtySince: 1,
  updatedAt: 2,
  link: title ? { title, slugId: `${pageId}-slug` } : undefined,
});

const OWNED = { [OFFLINE_DATA_OWNER_KEY]: "user-1" };

const uploadRecord = (attachmentId: string): UploadOutboxRecord => ({
  attachmentId,
  pageId: "page-1",
  kind: "excalidraw",
  nodeType: "excalidraw",
  mode: "overwrite",
  blob: new Blob(["svg"]),
  fileName: "diagram.excalidraw.svg",
  mimeType: "image/svg+xml",
  createdAt: 1,
  updatedAt: 1,
  status: "pending",
});

describe("clearOfflineDataOnSessionExpiry", () => {
  let cleared: Array<ClearOfflineDataDeps | undefined>;
  let stamped: string[];
  let clear: (deps?: ClearOfflineDataDeps) => Promise<void>;
  let stampOwner: (ownerUserId: string) => Promise<boolean>;

  beforeEach(() => {
    cleared = [];
    stamped = [];
    clear = async (deps) => {
      cleared.push(deps);
    };
    stampOwner = async (ownerUserId) => {
      stamped.push(ownerUserId);
      return true;
    };
  });

  const run = (
    storage: StorageLike,
    pending: DirtyPagesRead,
    overrides: SessionExpiryDeps = {},
  ) =>
    clearOfflineDataOnSessionExpiry({
      readDirtyPages: async () => pending,
      readUploadOutbox: async () => ({ readable: true, records: [] }),
      setOfflineDataOwner: stampOwner,
      clearOfflineData: clear,
      storage,
      now: () => 1234,
      ...overrides,
    });

  it("erases everything, exactly like a logout, when nothing is pending", async () => {
    const storage = memoryStorage(OWNED);

    await run(storage, { readable: true, records: [] });

    expect(cleared).toEqual([undefined]);
    expect(stamped).toEqual([]);
    expect(storage.map.get(PENDING_RECOVERY_KEY)).toBeUndefined();
  });

  it("preserves the documents holding unpushed edits, and their registry", async () => {
    // The original defect: this used to delete every `page.*` database,
    // destroying the only copy of the user's work on a mere token expiry.
    const storage = memoryStorage(OWNED);

    await run(storage, {
      readable: true,
      records: [record("p1", "Notes"), record("p2")],
    });

    expect(cleared).toEqual([
      {
        preservePageIds: ["p1", "p2"],
        preserveAllPages: false,
        preserveDirtyPages: true,
        preserveUploadOutbox: false,
      },
    ]);
  });

  it("preserves the upload outbox when it holds queued uploads, even with no dirty page", async () => {
    // An offline re-save of an existing Excalidraw diagram queues an upload
    // without touching the page's Yjs document, so the dirty registry alone
    // cannot answer "is anything pending".
    const storage = memoryStorage(OWNED);

    await run(
      storage,
      { readable: true, records: [] },
      {
        readUploadOutbox: async () => ({
          readable: true,
          records: [uploadRecord("att-1")],
        }),
      },
    );

    expect(cleared).toEqual([
      {
        preservePageIds: [],
        preserveAllPages: false,
        preserveDirtyPages: false,
        preserveUploadOutbox: true,
      },
    ]);
    expect(stamped).toEqual(["user-1"]);
    // The hint survives so a later 401 in the same signed-out window cannot
    // re-run the erase branch against the preserved outbox.
    expect(readOfflineDataOwnerHint(storage)).toBe("user-1");
  });

  it("treats an unreadable outbox as pending work, never as empty", async () => {
    const storage = memoryStorage(OWNED);

    await run(
      storage,
      { readable: true, records: [] },
      { readUploadOutbox: async () => ({ readable: false }) },
    );

    expect(cleared[0]).toMatchObject({ preserveUploadOutbox: true });
  });

  it("refuses to preserve outbox work without a provable owner", async () => {
    const storage = memoryStorage();

    await run(
      storage,
      { readable: true, records: [] },
      {
        readUploadOutbox: async () => ({
          readable: true,
          records: [uploadRecord("att-1")],
        }),
      },
    );

    expect(cleared).toEqual([undefined]);
    expect(stamped).toEqual([]);
  });

  it("refuses to preserve anything when the owner is unknown", async () => {
    // The leak the second round of the audit found: preserved data whose owner
    // was `null` got handed to whoever signed in next. Unattributable data must
    // not survive a session ending, however much work it holds.
    const storage = memoryStorage();

    await run(storage, { readable: true, records: [record("p1", "Notes")] });

    expect(cleared).toEqual([undefined]);
    expect(stamped).toEqual([]);
    expect(readPendingRecovery(storage)).toBeNull();
  });

  it("refuses to preserve when the owner stamp cannot be written", async () => {
    // Data in IndexedDB with no owner record beside it is indistinguishable
    // from a stranger's.
    const storage = memoryStorage(OWNED);

    await run(
      storage,
      { readable: true, records: [record("p1")] },
      { setOfflineDataOwner: async () => false },
    );

    expect(cleared).toEqual([undefined]);
    expect(readPendingRecovery(storage)).toBeNull();
  });

  it("stamps the owner into IndexedDB before erasing anything", async () => {
    // Order matters: a browser that dies mid-cleanup must be left holding data
    // that is attributable rather than anonymous.
    const order: string[] = [];
    const storage = memoryStorage(OWNED);

    await run(
      storage,
      { readable: true, records: [record("p1")] },
      {
        setOfflineDataOwner: async () => {
          order.push("stamp");
          return true;
        },
        clearOfflineData: async () => {
          order.push("clear");
        },
      },
    );

    expect(order).toEqual(["stamp", "clear"]);
  });

  it("preserves everything when the registry cannot be read", async () => {
    // "I cannot tell what is pending" must not resolve to "delete it all" —
    // `listDirtyPages` answering `[]` for an unreadable store is exactly how
    // the original defect destroyed work.
    const storage = memoryStorage(OWNED);

    await run(storage, { readable: false });

    expect(cleared).toEqual([
      {
        preservePageIds: [],
        preserveAllPages: true,
        preserveDirtyPages: true,
        preserveUploadOutbox: false,
      },
    ]);
    expect(stamped).toEqual(["user-1"]);
  });

  it("preserves everything when reading the registry throws outright", async () => {
    const storage = memoryStorage(OWNED);

    await clearOfflineDataOnSessionExpiry({
      readDirtyPages: async () => {
        throw new Error("indexeddb gone");
      },
      setOfflineDataOwner: stampOwner,
      clearOfflineData: clear,
      storage,
    });

    expect(cleared[0]).toMatchObject({ preserveAllPages: true });
  });

  it("announces what it kept, so nothing is preserved in silence", async () => {
    const storage = memoryStorage(OWNED);

    await run(storage, { readable: true, records: [record("p1", "Notes")] });

    expect(readPendingRecovery(storage)).toEqual({
      at: 1234,
      ownerUserId: "user-1",
      pages: [{ pageId: "p1", title: "Notes" }],
    });
  });

  it("drops the owner hint when it erases", async () => {
    const storage = memoryStorage(OWNED);

    await run(storage, { readable: true, records: [] });

    expect(readOfflineDataOwnerHint(storage)).toBeNull();
  });

  it("keeps the owner hint when it preserves", async () => {
    const storage = memoryStorage(OWNED);

    await run(storage, { readable: true, records: [record("p1")] });

    expect(readOfflineDataOwnerHint(storage)).toBe("user-1");
  });

  it("drops a stale notice when the new expiry has nothing to keep", async () => {
    const storage = memoryStorage({
      ...OWNED,
      [PENDING_RECOVERY_KEY]: JSON.stringify({
        at: 1,
        ownerUserId: "user-1",
        pages: [{ pageId: "old" }],
      }),
    });

    await run(storage, { readable: true, records: [] });

    expect(readPendingRecovery(storage)).toBeNull();
  });
});

describe("readPendingRecovery", () => {
  it("is null with nothing stored", () => {
    expect(readPendingRecovery(memoryStorage())).toBeNull();
  });

  it("survives a corrupt record rather than breaking the login page", () => {
    expect(
      readPendingRecovery(memoryStorage({ [PENDING_RECOVERY_KEY]: "{oops" })),
    ).toBeNull();
  });

  it("ignores a record that names no pages", () => {
    expect(
      readPendingRecovery(
        memoryStorage({
          [PENDING_RECOVERY_KEY]: JSON.stringify({ at: 1, pages: [] }),
        }),
      ),
    ).toBeNull();
  });

  it("tolerates storage that throws", () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readPendingRecovery(hostile)).toBeNull();
  });
});

describe("the offline data owner hint", () => {
  it("round-trips the id", () => {
    const storage = memoryStorage();
    rememberOfflineDataOwner("user-9", storage);
    expect(readOfflineDataOwnerHint(storage)).toBe("user-9");
  });

  it("does not record an absent id over a known one", () => {
    const storage = memoryStorage({ [OFFLINE_DATA_OWNER_KEY]: "user-9" });
    rememberOfflineDataOwner(undefined, storage);
    expect(readOfflineDataOwnerHint(storage)).toBe("user-9");
  });

  it("is forgettable, so a shared machine keeps no stable identifier", () => {
    const storage = memoryStorage({ [OFFLINE_DATA_OWNER_KEY]: "user-9" });

    forgetOfflineDataOwner(storage);

    expect(readOfflineDataOwnerHint(storage)).toBeNull();
  });
});

describe("clearPendingRecovery", () => {
  it("removes the notice", () => {
    const storage = memoryStorage({ [PENDING_RECOVERY_KEY]: "{}" });
    clearPendingRecovery(storage);
    expect(storage.map.has(PENDING_RECOVERY_KEY)).toBe(false);
  });
});
