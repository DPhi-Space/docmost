import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  clearOfflineData,
  pageDatabaseNames,
  pageDatabaseNamesFromQueryCache,
  runtimeCachesToDelete,
} from "./clear-offline-data";

// `persisted-store` opens a real IndexedDB connection at import time (idb-keyval
// `createStore`), which jsdom has no implementation for. The defaults it
// supplies are injected explicitly in every test below, so stubbing the module
// keeps this suite about the orchestration rather than about IndexedDB.
vi.mock("./persisted-store", () => ({
  deletePersistedQueryCache: vi.fn(async () => {}),
  stopPersistingQueryCache: vi.fn(),
}));

describe("pageDatabaseNames", () => {
  it("selects y-indexeddb page documents and nothing else", () => {
    expect(
      pageDatabaseNames([
        "page.0193f0e5",
        "page.abc",
        "docmost-offline",
        "pages",
        "keyval-store",
        "page.",
        "my.page.thing",
      ]),
    ).toEqual(["page.0193f0e5", "page.abc"]);
  });

  it("is empty for an empty database list", () => {
    expect(pageDatabaseNames([])).toEqual([]);
  });
});

describe("pageDatabaseNamesFromQueryCache", () => {
  const client = (keys: readonly unknown[][]) => ({
    clear: vi.fn(),
    getQueryCache: () => ({ getAll: () => keys.map((queryKey) => ({ queryKey })) }),
  });

  it("derives one name per page id, deduplicated", () => {
    expect(
      pageDatabaseNamesFromQueryCache(
        client([
          ["pages", "uuid-1"],
          ["pages", "slug-1"],
          ["pages", "uuid-1"],
        ]),
      ),
    ).toEqual(["page.uuid-1", "page.slug-1"]);
  });

  it("ignores other roots and malformed ids", () => {
    expect(
      pageDatabaseNamesFromQueryCache(
        client([
          ["comments", "uuid-1"],
          ["pages"],
          ["pages", ""],
          ["pages", 42],
          ["pages", { id: "x" }],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("runtimeCachesToDelete", () => {
  it("drops runtime caches and keeps precaches", () => {
    expect(
      runtimeCachesToDelete([
        "docmost-offline-precache-0.95.0-abc123",
        "docmost-offline-shell-v1",
        "docmost-offline-assets-v1",
        "docmost-offline-locales-v1",
        "docmost-offline-files-v1",
      ]),
    ).toEqual([
      "docmost-offline-shell-v1",
      "docmost-offline-assets-v1",
      "docmost-offline-locales-v1",
      "docmost-offline-files-v1",
    ]);
  });

  it("never touches a cache this feature does not own", () => {
    expect(
      runtimeCachesToDelete(["workbox-precache", "some-other-app", "v1"]),
    ).toEqual([]);
  });
});

/** Minimal `IDBFactory` double whose delete requests succeed on a microtask. */
function fakeIndexedDB(options: {
  databases?: string[] | null;
  blockedNames?: string[];
}) {
  const deleted: string[] = [];
  const factory: Record<string, unknown> = {
    deleteDatabase(name: string) {
      deleted.push(name);
      const request: Record<string, unknown> = {
        onsuccess: null,
        onerror: null,
      };
      if (!options.blockedNames?.includes(name)) {
        queueMicrotask(() => (request.onsuccess as (() => void) | null)?.());
      }
      return request;
    },
  };
  if (options.databases !== null) {
    factory.databases = async () =>
      (options.databases ?? []).map((name) => ({ name, version: 1 }));
  }
  return { factory: factory as unknown as IDBFactory, deleted };
}

function fakeCaches(names: string[]) {
  const deleted: string[] = [];
  const storage = {
    keys: async () => names,
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  } as unknown as CacheStorage;
  return { storage, deleted };
}

function fakeQueryClient(keys: readonly unknown[][] = []) {
  return {
    clear: vi.fn(),
    getQueryCache: () => ({ getAll: () => keys.map((queryKey) => ({ queryKey })) }),
  };
}

describe("clearOfflineData", () => {
  let deletePersistedQueryCache: Mock<() => Promise<void>>;
  let stopPersistingQueryCache: Mock<() => void>;
  let clearPageSyncMarkers: Mock<() => Promise<void>>;
  let clearDirtyPages: Mock<() => Promise<void>>;
  let clearPageSyncMarkersExcept: Mock<(keep: readonly string[]) => Promise<void>>;
  let forgetOwnerHint: Mock<() => void>;

  beforeEach(() => {
    deletePersistedQueryCache = vi.fn<() => Promise<void>>(async () => {});
    stopPersistingQueryCache = vi.fn<() => void>();
    clearPageSyncMarkers = vi.fn<() => Promise<void>>(async () => {});
    clearDirtyPages = vi.fn<() => Promise<void>>(async () => {});
    clearPageSyncMarkersExcept = vi.fn<(keep: readonly string[]) => Promise<void>>(
      async () => {},
    );
    forgetOwnerHint = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const run = (overrides = {}) =>
    clearOfflineData({
      deletePersistedQueryCache,
      stopPersistingQueryCache,
      clearPageSyncMarkers,
      clearDirtyPages,
      clearPageSyncMarkersExcept,
      forgetOwnerHint,
      ...overrides,
    });

  it("stops persistence before erasing, so a throttled write cannot restore it", async () => {
    const order: string[] = [];
    stopPersistingQueryCache.mockImplementation(() => order.push("stop"));
    deletePersistedQueryCache.mockImplementation(async () => {
      order.push("delete");
    });

    await run({ indexedDB: null, caches: null });

    expect(order).toEqual(["stop", "delete"]);
  });

  it("deletes only page databases from the enumerated list", async () => {
    const { factory, deleted } = fakeIndexedDB({
      databases: ["page.a", "page.b", "docmost-offline", "unrelated"],
    });

    await run({ indexedDB: factory, caches: null });

    expect(deleted).toEqual(["page.a", "page.b"]);
  });

  it("falls back to query-cache-derived names when databases() is unavailable", async () => {
    const { factory, deleted } = fakeIndexedDB({ databases: null });
    const queryClient = fakeQueryClient([
      ["pages", "uuid-1"],
      ["pages", "slug-1"],
      ["comments", "uuid-1"],
    ]);

    await run({ indexedDB: factory, caches: null, queryClient });

    expect(deleted.sort()).toEqual(["page.slug-1", "page.uuid-1"]);
  });

  it("deletes nothing by fallback when there is no query client to derive from", async () => {
    const { factory, deleted } = fakeIndexedDB({ databases: null });

    await run({ indexedDB: factory, caches: null });

    expect(deleted).toEqual([]);
  });

  it("deletes runtime caches and keeps the precache", async () => {
    const { storage, deleted } = fakeCaches([
      "docmost-offline-precache-1.0.0-a",
      "docmost-offline-files-v1",
      "docmost-offline-shell-v1",
      "other-app-cache",
    ]);

    await run({ indexedDB: null, caches: storage });

    expect(deleted).toEqual([
      "docmost-offline-files-v1",
      "docmost-offline-shell-v1",
    ]);
  });

  it("clears the in-memory cache after reading the page ids out of it", async () => {
    const { factory, deleted } = fakeIndexedDB({ databases: null });
    const queryClient = fakeQueryClient([["pages", "uuid-1"]]);

    await run({ indexedDB: factory, caches: null, queryClient });

    // Clearing first would have emptied the cache the fallback reads from.
    expect(deleted).toEqual(["page.uuid-1"]);
    expect(queryClient.clear).toHaveBeenCalledOnce();
  });

  it("clears the phase-2 page sync markers", async () => {
    // Left behind, they would tell the next user of this browser which pages
    // the previous one was allowed to sync — and hand them an offline editor.
    await run({ indexedDB: null, caches: null });

    expect(clearPageSyncMarkers).toHaveBeenCalledOnce();
  });

  it("keeps the page databases named for preservation, and only those", async () => {
    // The 401 path (`session-expiry.ts`). These databases can hold the only
    // copy of the user's work; every other one is a cache and still goes.
    const { factory, deleted } = fakeIndexedDB({
      databases: ["page.keep", "page.drop", "docmost-offline"],
    });

    await run({
      indexedDB: factory,
      caches: null,
      preservePageIds: ["keep"],
      preserveDirtyPages: true,
    });

    expect(deleted).toEqual(["page.drop"]);
  });

  it("narrows the sync markers to exactly the preserved pages", async () => {
    // A marker whose document has just been deleted is the "marker without
    // content" state the gate refuses to act on; the two move together.
    const { factory } = fakeIndexedDB({ databases: ["page.keep"] });

    await run({
      indexedDB: factory,
      caches: null,
      preservePageIds: ["keep"],
      preserveDirtyPages: true,
    });

    expect(clearPageSyncMarkersExcept).toHaveBeenCalledWith(["keep"]);
    expect(clearPageSyncMarkers).not.toHaveBeenCalled();
    expect(clearDirtyPages).not.toHaveBeenCalled();
  });

  it("deletes every page database when nothing is named", async () => {
    // The explicit-logout path, unchanged.
    const { factory, deleted } = fakeIndexedDB({
      databases: ["page.a", "page.b"],
    });

    await run({ indexedDB: factory, caches: null });

    expect(deleted).toEqual(["page.a", "page.b"]);
    expect(clearPageSyncMarkers).toHaveBeenCalledOnce();
    expect(clearDirtyPages).toHaveBeenCalledOnce();
  });

  it("still erases the runtime caches and the query cache while preserving", async () => {
    // Preservation is narrow: only what is needed to recover the edits.
    const { factory } = fakeIndexedDB({ databases: ["page.keep"] });
    const { storage, deleted } = fakeCaches(["docmost-offline-files-v1"]);
    const queryClient = fakeQueryClient();

    await run({
      indexedDB: factory,
      caches: storage,
      queryClient,
      preservePageIds: ["keep"],
      preserveDirtyPages: true,
    });

    expect(deleted).toEqual(["docmost-offline-files-v1"]);
    expect(deletePersistedQueryCache).toHaveBeenCalledOnce();
    expect(queryClient.clear).toHaveBeenCalledOnce();
  });

  it("forgets the owner hint, so a shared machine keeps no stable identifier", async () => {
    await run({ indexedDB: null, caches: null });

    expect(forgetOwnerHint).toHaveBeenCalledOnce();
  });

  it("keeps the owner hint when it is preserving data that needs it", async () => {
    // Session expiry re-reads the hint on the *next* 401 and stamps the store
    // from it; dropping it here would make the preserved data unattributable
    // and therefore erasable.
    const { factory } = fakeIndexedDB({ databases: ["page.keep"] });

    await run({
      indexedDB: factory,
      caches: null,
      preservePageIds: ["keep"],
      preserveDirtyPages: true,
    });

    expect(forgetOwnerHint).not.toHaveBeenCalled();
  });

  it("clears the phase-3 dirty-page registry and its blocked list", async () => {
    // It names the pages the previous user edited offline — titles and space
    // slugs included — and would aim the next session's background sync at
    // them.
    await run({ indexedDB: null, caches: null });

    expect(clearDirtyPages).toHaveBeenCalledOnce();
  });

  it("still erases everything else when the dirty registry cannot be cleared", async () => {
    clearDirtyPages.mockRejectedValue(new Error("blocked"));
    const queryClient = fakeQueryClient();

    await expect(
      run({ indexedDB: null, caches: null, queryClient }),
    ).resolves.toBeUndefined();

    expect(deletePersistedQueryCache).toHaveBeenCalledOnce();
    expect(clearPageSyncMarkers).toHaveBeenCalledOnce();
    expect(queryClient.clear).toHaveBeenCalledOnce();
  });

  it("clears the dirty registry even when the sync markers fail", async () => {
    clearPageSyncMarkers.mockRejectedValue(new Error("blocked"));

    await expect(run({ indexedDB: null, caches: null })).resolves.toBeUndefined();

    expect(clearDirtyPages).toHaveBeenCalledOnce();
  });

  it("clears the sync markers even when the query cache deletion fails", async () => {
    deletePersistedQueryCache.mockRejectedValue(new Error("quota"));

    await expect(run({ indexedDB: null, caches: null })).resolves.toBeUndefined();

    expect(clearPageSyncMarkers).toHaveBeenCalledOnce();
  });

  it("still erases everything else when the sync markers cannot be cleared", async () => {
    clearPageSyncMarkers.mockRejectedValue(new Error("blocked"));
    const { storage, deleted } = fakeCaches(["docmost-offline-files-v1"]);
    const queryClient = fakeQueryClient();

    await expect(
      run({ indexedDB: null, caches: storage, queryClient }),
    ).resolves.toBeUndefined();

    expect(deletePersistedQueryCache).toHaveBeenCalledOnce();
    expect(deleted).toEqual(["docmost-offline-files-v1"]);
    expect(queryClient.clear).toHaveBeenCalledOnce();
  });

  it("tolerates a browser with neither IndexedDB nor Cache Storage", async () => {
    await expect(
      run({ indexedDB: undefined, caches: undefined }),
    ).resolves.toBeUndefined();
  });

  it("still erases the other stores when one step throws", async () => {
    deletePersistedQueryCache.mockRejectedValue(new Error("quota"));
    const { storage, deleted } = fakeCaches(["docmost-offline-files-v1"]);
    const queryClient = fakeQueryClient();

    await expect(
      run({ indexedDB: null, caches: storage, queryClient }),
    ).resolves.toBeUndefined();
    expect(deleted).toEqual(["docmost-offline-files-v1"]);
    expect(queryClient.clear).toHaveBeenCalledOnce();
  });

  it("does not hang on a blocked database deletion", async () => {
    vi.useFakeTimers();
    const { factory, deleted } = fakeIndexedDB({
      databases: ["page.open"],
      blockedNames: ["page.open"],
    });

    const pending = run({
      indexedDB: factory,
      caches: null,
      deleteTimeoutMs: 2_000,
    });
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await pending;
    // The request was issued; the browser completes it once the tab navigates.
    expect(deleted).toEqual(["page.open"]);
  });
});
