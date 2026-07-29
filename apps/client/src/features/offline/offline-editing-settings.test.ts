import { describe, expect, it, vi } from "vitest";
import {
  isOfflineEditingEnabled,
  OFFLINE_EDITING_STORAGE_KEY,
  setOfflineEditingEnabled,
  type StorageLike,
} from "./offline-editing-settings";

function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error("access denied");
  },
  setItem: () => {
    throw new Error("access denied");
  },
  removeItem: () => {
    throw new Error("access denied");
  },
};

describe("isOfflineEditingEnabled", () => {
  it("is off when nothing has been stored", () => {
    expect(isOfflineEditingEnabled(memoryStorage())).toBe(false);
  });

  it("is on only for the exact string 'true'", () => {
    expect(
      isOfflineEditingEnabled(
        memoryStorage({ [OFFLINE_EDITING_STORAGE_KEY]: "true" }),
      ),
    ).toBe(true);

    for (const value of ["1", "TRUE", "yes", "false", "", "{}"]) {
      expect(
        isOfflineEditingEnabled(
          memoryStorage({ [OFFLINE_EDITING_STORAGE_KEY]: value }),
        ),
      ).toBe(false);
    }
  });

  it("is off when there is no storage at all", () => {
    expect(isOfflineEditingEnabled(null)).toBe(false);
  });

  it("is off when storage access throws", () => {
    expect(isOfflineEditingEnabled(throwingStorage)).toBe(false);
  });
});

describe("setOfflineEditingEnabled", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();

    setOfflineEditingEnabled(true, storage);
    expect(isOfflineEditingEnabled(storage)).toBe(true);

    setOfflineEditingEnabled(false, storage);
    expect(isOfflineEditingEnabled(storage)).toBe(false);
  });

  it("removes the key rather than storing 'false'", () => {
    const storage = memoryStorage({ [OFFLINE_EDITING_STORAGE_KEY]: "true" });

    setOfflineEditingEnabled(false, storage);

    expect(storage.map.has(OFFLINE_EDITING_STORAGE_KEY)).toBe(false);
  });

  it("notifies same-tab listeners, which the storage event does not", () => {
    const storage = memoryStorage();
    const listener = vi.fn();
    window.addEventListener("docmost:offline-editing-changed", listener);

    setOfflineEditingEnabled(true, storage);

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("docmost:offline-editing-changed", listener);
  });

  it("still notifies when the write itself fails", () => {
    const listener = vi.fn();
    window.addEventListener("docmost:offline-editing-changed", listener);

    expect(() => setOfflineEditingEnabled(true, throwingStorage)).not.toThrow();

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("docmost:offline-editing-changed", listener);
  });
});
