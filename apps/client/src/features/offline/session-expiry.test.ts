import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineDataOnSessionExpiry,
  clearPendingRecovery,
  OFFLINE_DATA_OWNER_KEY,
  PENDING_RECOVERY_KEY,
  readOfflineDataOwner,
  readPendingRecovery,
  reconcilePendingRecovery,
  rememberOfflineDataOwner,
  type StorageLike,
} from "./session-expiry";
import type { ClearOfflineDataDeps } from "./clear-offline-data";
import type { DirtyPageRecord } from "./dirty-pages";

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

describe("clearOfflineDataOnSessionExpiry", () => {
  let calls: Array<ClearOfflineDataDeps | undefined>;
  let clear: (deps?: ClearOfflineDataDeps) => Promise<void>;

  beforeEach(() => {
    calls = [];
    clear = async (deps) => {
      calls.push(deps);
    };
  });

  it("erases everything, exactly like a logout, when nothing is pending", async () => {
    const storage = memoryStorage();

    await clearOfflineDataOnSessionExpiry({
      listDirtyPages: async () => [],
      clearOfflineData: clear,
      storage,
    });

    expect(calls).toEqual([undefined]);
    expect(storage.map.get(PENDING_RECOVERY_KEY)).toBeUndefined();
  });

  it("preserves the documents holding unpushed edits, and their registry", async () => {
    // The defect: this used to delete every `page.*` database, destroying the
    // only copy of the user's work on a mere token expiry.
    const storage = memoryStorage();

    await clearOfflineDataOnSessionExpiry({
      listDirtyPages: async () => [record("p1", "Notes"), record("p2")],
      clearOfflineData: clear,
      storage,
    });

    expect(calls).toEqual([
      { preservePageIds: ["p1", "p2"], preserveDirtyPages: true },
    ]);
  });

  it("announces what it kept, so nothing is preserved in silence", async () => {
    const storage = memoryStorage({ [OFFLINE_DATA_OWNER_KEY]: "user-1" });

    await clearOfflineDataOnSessionExpiry({
      listDirtyPages: async () => [record("p1", "Notes")],
      clearOfflineData: clear,
      storage,
      now: () => 1234,
    });

    expect(readPendingRecovery(storage)).toEqual({
      at: 1234,
      ownerUserId: "user-1",
      pages: [{ pageId: "p1", title: "Notes" }],
    });
  });

  it("still preserves when the owner was never recorded", async () => {
    const storage = memoryStorage();

    await clearOfflineDataOnSessionExpiry({
      listDirtyPages: async () => [record("p1")],
      clearOfflineData: clear,
      storage,
    });

    expect(calls[0]).toMatchObject({ preservePageIds: ["p1"] });
    expect(readPendingRecovery(storage)?.ownerUserId).toBeNull();
  });

  it("falls back to the full erase when the registry cannot be read", async () => {
    // An unreadable registry means no evidence of pending work. Preserving
    // documents we cannot justify keeping would be the privacy regression #18
    // closed, for no benefit.
    const storage = memoryStorage();

    await clearOfflineDataOnSessionExpiry({
      listDirtyPages: async () => {
        throw new Error("indexeddb gone");
      },
      clearOfflineData: clear,
      storage,
    });

    expect(calls).toEqual([undefined]);
  });

  it("drops a stale notice when the new expiry has nothing to keep", async () => {
    const storage = memoryStorage({
      [PENDING_RECOVERY_KEY]: JSON.stringify({
        at: 1,
        ownerUserId: null,
        pages: [{ pageId: "old" }],
      }),
    });

    await clearOfflineDataOnSessionExpiry({
      listDirtyPages: async () => [],
      clearOfflineData: clear,
      storage,
    });

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

describe("offline data owner", () => {
  it("round-trips the id", () => {
    const storage = memoryStorage();
    rememberOfflineDataOwner("user-9", storage);
    expect(readOfflineDataOwner(storage)).toBe("user-9");
  });

  it("does not record an absent id over a known one", () => {
    const storage = memoryStorage({ [OFFLINE_DATA_OWNER_KEY]: "user-9" });
    rememberOfflineDataOwner(undefined, storage);
    expect(readOfflineDataOwner(storage)).toBe("user-9");
  });
});

describe("reconcilePendingRecovery", () => {
  const notice = (ownerUserId: string | null) =>
    memoryStorage({
      [PENDING_RECOVERY_KEY]: JSON.stringify({
        at: 1,
        ownerUserId,
        pages: [{ pageId: "p1" }],
      }),
    });

  it("does nothing when no session ever expired", async () => {
    const cleared: unknown[] = [];
    await expect(
      reconcilePendingRecovery("user-1", {
        storage: memoryStorage(),
        clearOfflineData: async (d) => void cleared.push(d),
      }),
    ).resolves.toBe("none");
    expect(cleared).toEqual([]);
  });

  it("keeps the work when the same user signs back in", async () => {
    const storage = notice("user-1");
    const cleared: unknown[] = [];

    await expect(
      reconcilePendingRecovery("user-1", {
        storage,
        clearOfflineData: async (d) => void cleared.push(d),
      }),
    ).resolves.toBe("kept");

    expect(cleared).toEqual([]);
    // The notice is consumed: the resync manager takes it from here.
    expect(readPendingRecovery(storage)).toBeNull();
  });

  it("erases everything when a different account signs in", async () => {
    // #18's shared-machine case, decided at the moment it becomes knowable
    // rather than guessed at 401 time.
    const storage = notice("user-1");
    const cleared: unknown[] = [];

    await expect(
      reconcilePendingRecovery("user-2", {
        storage,
        clearOfflineData: async (d) => void cleared.push(d),
      }),
    ).resolves.toBe("discarded");

    expect(cleared).toEqual([undefined]);
    expect(readPendingRecovery(storage)).toBeNull();
  });

  it("keeps the work when the owner was never recorded", async () => {
    // Destroying a user's only copy on a guess is the defect this module
    // exists to undo; an unknown owner is read as the same user.
    const storage = notice(null);
    const cleared: unknown[] = [];

    await expect(
      reconcilePendingRecovery("user-2", {
        storage,
        clearOfflineData: async (d) => void cleared.push(d),
      }),
    ).resolves.toBe("kept");

    expect(cleared).toEqual([]);
  });

  it("keeps the work when the signing-in user cannot be identified", async () => {
    const storage = notice("user-1");
    const cleared: unknown[] = [];

    await expect(
      reconcilePendingRecovery(undefined, {
        storage,
        clearOfflineData: async (d) => void cleared.push(d),
      }),
    ).resolves.toBe("kept");

    expect(cleared).toEqual([]);
  });
});

describe("clearPendingRecovery", () => {
  it("removes the notice", () => {
    const storage = memoryStorage({ [PENDING_RECOVERY_KEY]: "{}" });
    clearPendingRecovery(storage);
    expect(storage.map.has(PENDING_RECOVERY_KEY)).toBe(false);
  });
});
