import { beforeEach, describe, expect, it } from "vitest";
import {
  blockedPages,
  clearDirtyPage,
  clearDirtyPages,
  listDirtyPages,
  markDirtyPageBlocked,
  recordDirtyPage,
  selectPagesToResync,
  type DirtyPageBackend,
  type DirtyPageRecord,
} from "./dirty-pages";

function memoryBackend(): DirtyPageBackend & { map: Map<string, DirtyPageRecord> } {
  const map = new Map<string, DirtyPageRecord>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    del: async (key) => void map.delete(key),
    entries: async () => [...map.entries()],
    clear: async () => map.clear(),
  };
}

function failingBackend(): DirtyPageBackend {
  const boom = async () => {
    throw new Error("quota");
  };
  return {
    get: boom as DirtyPageBackend["get"],
    set: boom as DirtyPageBackend["set"],
    del: boom,
    entries: boom as DirtyPageBackend["entries"],
    clear: boom,
  };
}

describe("recordDirtyPage", () => {
  let backend: ReturnType<typeof memoryBackend>;
  beforeEach(() => {
    backend = memoryBackend();
  });

  it("stores the page with both timestamps on the first edit", async () => {
    await recordDirtyPage("page-1", undefined, backend, 1_000);

    expect(backend.map.get("page-1")).toEqual({
      pageId: "page-1",
      dirtySince: 1_000,
      updatedAt: 1_000,
      link: undefined,
    });
  });

  it("keeps the original dirtySince across later edits", async () => {
    await recordDirtyPage("page-1", undefined, backend, 1_000);
    await recordDirtyPage("page-1", undefined, backend, 5_000);

    expect(backend.map.get("page-1")).toMatchObject({
      dirtySince: 1_000,
      updatedAt: 5_000,
    });
  });

  it("keeps a blocked mark when the user edits the page again", async () => {
    // Typing more does not make a locked page writable. The mark is the
    // server's last answer and only a *push* may clear it.
    await recordDirtyPage("page-1", undefined, backend, 1_000);
    await markDirtyPageBlocked("page-1", "not-accepted", backend, 2_000);

    await recordDirtyPage("page-1", undefined, backend, 3_000);

    expect(backend.map.get("page-1")?.blocked).toEqual({
      reason: "not-accepted",
      at: 2_000,
    });
  });

  it("keeps a previously captured link when a later edit knows nothing", async () => {
    await recordDirtyPage("page-1", { slugId: "abc", title: "Notes" }, backend, 1);
    await recordDirtyPage("page-1", undefined, backend, 2);

    expect(backend.map.get("page-1")?.link).toEqual({
      slugId: "abc",
      title: "Notes",
    });
  });

  it("upgrades the link when a later edit knows more", async () => {
    await recordDirtyPage("page-1", undefined, backend, 1);
    await recordDirtyPage(
      "page-1",
      { slugId: "abc", title: "Notes", spaceSlug: "eng" },
      backend,
      2,
    );

    expect(backend.map.get("page-1")?.link).toEqual({
      slugId: "abc",
      title: "Notes",
      spaceSlug: "eng",
    });
  });

  it("reports a refused write instead of swallowing it", async () => {
    // A page that could not be registered is a page a later session expiry
    // will not know to preserve, so the caller is told rather than left to
    // assume the edit is tracked.
    await expect(
      recordDirtyPage("page-1", undefined, failingBackend()),
    ).resolves.toBe(false);
  });

  it("reports success on a store that accepts the write", async () => {
    await expect(recordDirtyPage("page-1", undefined, backend)).resolves.toBe(
      true,
    );
  });
});

describe("markDirtyPageBlocked", () => {
  it("does not resurrect an entry another tab has already pushed", async () => {
    const backend = memoryBackend();

    await markDirtyPageBlocked("gone", "no-access", backend, 1);

    expect(backend.map.size).toBe(0);
  });

  it("records the reason and the time", async () => {
    const backend = memoryBackend();
    await recordDirtyPage("page-1", undefined, backend, 1);

    await markDirtyPageBlocked("page-1", "no-access", backend, 42);

    expect(backend.map.get("page-1")?.blocked).toEqual({
      reason: "no-access",
      at: 42,
    });
  });
});

describe("listDirtyPages", () => {
  it("answers with an empty list rather than throwing", async () => {
    await expect(listDirtyPages(failingBackend())).resolves.toEqual([]);
  });

  it("drops records that are not shaped like a dirty page", async () => {
    const backend = memoryBackend();
    await recordDirtyPage("page-1", undefined, backend, 1);
    backend.map.set("junk", { nope: true } as unknown as DirtyPageRecord);

    expect(await listDirtyPages(backend)).toHaveLength(1);
  });
});

describe("clearDirtyPage / clearDirtyPages", () => {
  it("removes one entry and then all of them", async () => {
    const backend = memoryBackend();
    await recordDirtyPage("a", undefined, backend, 1);
    await recordDirtyPage("b", undefined, backend, 2);

    await clearDirtyPage("a", backend);
    expect(backend.map.size).toBe(1);

    await clearDirtyPages(backend);
    expect(backend.map.size).toBe(0);
  });

  it("never throws when the store is unusable", async () => {
    await expect(clearDirtyPage("a", failingBackend())).resolves.toBeUndefined();
    await expect(clearDirtyPages(failingBackend())).resolves.toBeUndefined();
  });
});

describe("selectPagesToResync", () => {
  const record = (
    pageId: string,
    dirtySince: number,
    blocked?: DirtyPageRecord["blocked"],
  ): DirtyPageRecord => ({ pageId, dirtySince, updatedAt: dirtySince, blocked });

  const all = [
    record("c", 30),
    record("a", 10),
    record("locked", 20, { reason: "not-accepted", at: 25 }),
  ];

  it("never returns the page the editor currently owns", () => {
    // The one rule that keeps two providers off the same `documentName`.
    const selected = selectPagesToResync(all, {
      openPageId: "a",
      includeBlocked: true,
    });

    expect(selected.map((r) => r.pageId)).toEqual(["locked", "c"]);
  });

  it("orders by the age of the oldest unpushed edit", () => {
    const selected = selectPagesToResync(all, {
      openPageId: null,
      includeBlocked: true,
    });

    expect(selected.map((r) => r.pageId)).toEqual(["a", "locked", "c"]);
  });

  it("excludes blocked entries from a periodic pass without removing them", () => {
    const selected = selectPagesToResync(all, {
      openPageId: null,
      includeBlocked: false,
    });

    expect(selected.map((r) => r.pageId)).toEqual(["a", "c"]);
    expect(all).toHaveLength(3);
  });

  it("is empty rather than undefined for an empty registry", () => {
    expect(
      selectPagesToResync([], { openPageId: null, includeBlocked: true }),
    ).toEqual([]);
  });
});

describe("blockedPages", () => {
  it("selects only marked entries, oldest first", () => {
    const records: DirtyPageRecord[] = [
      { pageId: "b", dirtySince: 20, updatedAt: 20, blocked: { reason: "no-access", at: 21 } },
      { pageId: "clean", dirtySince: 5, updatedAt: 5 },
      { pageId: "a", dirtySince: 10, updatedAt: 10, blocked: { reason: "not-accepted", at: 11 } },
    ];

    expect(blockedPages(records).map((r) => r.pageId)).toEqual(["a", "b"]);
  });
});
