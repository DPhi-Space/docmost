import { describe, expect, it, vi } from "vitest";
import {
  clearPageSyncMarkers,
  hasPageRemoteSynced,
  markPageRemoteSynced,
  type SyncMarkerBackend,
} from "./sync-markers";

/** A real map behind the interface, so set/get/clear semantics are exercised. */
function memoryBackend(seed: Record<string, number> = {}) {
  const map = new Map<string, number>(Object.entries(seed));
  const backend: SyncMarkerBackend = {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    clear: async () => {
      map.clear();
    },
  };
  return { backend, map };
}

function throwingBackend(): SyncMarkerBackend {
  return {
    get: async () => {
      throw new Error("IndexedDB unavailable");
    },
    set: async () => {
      throw new Error("quota exceeded");
    },
    clear: async () => {
      throw new Error("blocked");
    },
  };
}

describe("markPageRemoteSynced", () => {
  it("records a timestamp for the page", async () => {
    const { backend, map } = memoryBackend();

    await markPageRemoteSynced("page-1", backend);

    expect(map.get("page-1")).toBeTypeOf("number");
  });

  it("marks only the page it was given", async () => {
    const { backend, map } = memoryBackend();

    await markPageRemoteSynced("page-1", backend);

    expect([...map.keys()]).toEqual(["page-1"]);
  });

  it("does not rewrite an existing marker", async () => {
    const { backend, map } = memoryBackend({ "page-1": 1_000 });
    const set = vi.spyOn(backend, "set");

    await markPageRemoteSynced("page-1", backend);

    expect(set).not.toHaveBeenCalled();
    expect(map.get("page-1")).toBe(1_000);
  });

  it("swallows a failing store rather than breaking the editor", async () => {
    await expect(
      markPageRemoteSynced("page-1", throwingBackend()),
    ).resolves.toBeUndefined();
  });
});

describe("hasPageRemoteSynced", () => {
  it("is true only for a page that carries a marker", async () => {
    const { backend } = memoryBackend({ "page-1": 1_000 });

    await expect(hasPageRemoteSynced("page-1", backend)).resolves.toBe(true);
    await expect(hasPageRemoteSynced("page-2", backend)).resolves.toBe(false);
  });

  it("treats a marker written at epoch zero as present", async () => {
    // A falsy timestamp must not read as "never synced".
    const { backend } = memoryBackend({ "page-1": 0 });

    await expect(hasPageRemoteSynced("page-1", backend)).resolves.toBe(true);
  });

  it("fails closed when the store cannot be read", async () => {
    await expect(hasPageRemoteSynced("page-1", throwingBackend())).resolves.toBe(
      false,
    );
  });
});

describe("clearPageSyncMarkers", () => {
  it("removes every marker", async () => {
    const { backend, map } = memoryBackend({ a: 1, b: 2 });

    await clearPageSyncMarkers(backend);

    expect(map.size).toBe(0);
    await expect(hasPageRemoteSynced("a", backend)).resolves.toBe(false);
  });

  it("never rejects, so it cannot hold up a logout redirect", async () => {
    await expect(
      clearPageSyncMarkers(throwingBackend()),
    ).resolves.toBeUndefined();
  });
});
