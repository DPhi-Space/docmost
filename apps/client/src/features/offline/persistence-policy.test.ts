import { describe, expect, it } from "vitest";
import {
  NEVER_PERSISTED_QUERY_KEY_ROOTS,
  PERSISTED_QUERY_KEY_ROOTS,
  isCorruptInfiniteData,
  isPersistableQueryKey,
  isSnapshotWorthPersisting,
  sanitizeRestoredClient,
  shouldDehydrateQuery,
} from "./persistence-policy";

const success = { status: "success" };

/**
 * The allowlist, written out rather than read from the module.
 *
 * `it.each(PERSISTED_QUERY_KEY_ROOTS)` used to generate a case per entry, which
 * asked an implementation that *is* `new Set(PERSISTED_QUERY_KEY_ROOTS)`
 * whether its own list contains its own list. Thirty-two green tests that no
 * change to the policy could ever turn red. Stating the roots here means adding
 * one — the actual risk, since every added root writes more user data to disk —
 * has to be a deliberate edit in two places.
 */
const EXPECTED_PERSISTED_ROOTS = [
  "currentUser",
  "workspace",
  "entitlements",
  "spaces",
  "space",
  "root-sidebar-pages",
  "sidebar-pages",
  "pages",
  "breadcrumbs",
  "favorites",
  "favorite-ids",
  "recent-changes",
  "comments",
];

describe("the persistence allowlist", () => {
  it("is exactly the thirteen reviewed roots", () => {
    expect([...PERSISTED_QUERY_KEY_ROOTS]).toEqual(EXPECTED_PERSISTED_ROOTS);
  });

  it("persists every root on it and nothing else", () => {
    const persisted = EXPECTED_PERSISTED_ROOTS.filter((root) =>
      isPersistableQueryKey([root]),
    );
    const leaked = NEVER_PERSISTED_QUERY_KEY_ROOTS.filter((root) =>
      isPersistableQueryKey([root]),
    );

    expect(persisted).toEqual(EXPECTED_PERSISTED_ROOTS);
    expect(leaked).toEqual([]);
  });
});

describe("isPersistableQueryKey", () => {
  it("has no overlap between the allow and deny lists", () => {
    const allowed = new Set<string>(PERSISTED_QUERY_KEY_ROOTS);
    const overlap = NEVER_PERSISTED_QUERY_KEY_ROOTS.filter((root) =>
      allowed.has(root),
    );
    expect(overlap).toEqual([]);
  });

  it("keeps the collab JWT off disk, in every key shape it appears in", () => {
    expect(isPersistableQueryKey(["collab-token"])).toBe(false);
    expect(isPersistableQueryKey(["collab-token", "page-id"])).toBe(false);
  });

  // The allowlist is closed: a key nobody has reviewed must not be persisted
  // just because it looks harmless.
  it.each([
    ["bases"],
    ["base-rows"],
    ["page-history"],
    ["page-permissions"],
    ["trash-list"],
    ["templates"],
    ["ai-chats"],
    ["session-list"],
    ["audit-logs"],
    ["shared-page-tree"],
    ["backlinks"],
    ["groups"],
    ["mfa-status"],
  ])("does not persist unreviewed key %s", (root) => {
    expect(isPersistableQueryKey([root])).toBe(false);
  });

  it("matches only the root, so key parameters cannot smuggle a key in", () => {
    expect(isPersistableQueryKey(["page-search", { spaceId: "pages" }])).toBe(
      false,
    );
    expect(isPersistableQueryKey(["unified-search", "pages", {}])).toBe(false);
  });

  it("persists the real key shapes the app builds", () => {
    // page-query.ts writes the same page under both its UUID and its slugId
    expect(isPersistableQueryKey(["pages", "0193f0e5-uuid"])).toBe(true);
    expect(isPersistableQueryKey(["pages", "my-page-abc123"])).toBe(true);
    // comment-query.ts RQ_KEY
    expect(isPersistableQueryKey(["comments", "page-id"])).toBe(true);
    // infinite sidebar query
    expect(isPersistableQueryKey(["sidebar-pages", "space-id", "parent"])).toBe(
      true,
    );
  });

  it("rejects malformed keys instead of throwing", () => {
    expect(isPersistableQueryKey([])).toBe(false);
    expect(isPersistableQueryKey([undefined])).toBe(false);
    expect(isPersistableQueryKey([null])).toBe(false);
    expect(isPersistableQueryKey([{ root: "pages" }])).toBe(false);
    expect(isPersistableQueryKey([["pages"]])).toBe(false);
  });
});

describe("shouldDehydrateQuery", () => {
  it("persists a successful allowlisted query", () => {
    expect(
      shouldDehydrateQuery({ queryKey: ["currentUser"], state: success }),
    ).toBe(true);
  });

  it.each(["pending", "error"])("does not persist a %s query", (status) => {
    expect(
      shouldDehydrateQuery({ queryKey: ["currentUser"], state: { status } }),
    ).toBe(false);
  });

  it("does not persist a successful denied query", () => {
    expect(
      shouldDehydrateQuery({ queryKey: ["notifications"], state: success }),
    ).toBe(false);
    expect(
      shouldDehydrateQuery({ queryKey: ["collab-token"], state: success }),
    ).toBe(false);
  });

  it("rejects every denied key even when it succeeded", () => {
    const persisted = NEVER_PERSISTED_QUERY_KEY_ROOTS.filter((root) =>
      shouldDehydrateQuery({ queryKey: [root, "x"], state: success }),
    );
    expect(persisted).toEqual([]);
  });

  // The field incident: a proxy answered `POST /pages/recent` with 200 + HTML,
  // the envelope unwrap produced `undefined`, and React Query committed it as
  // a page while still reporting success. Persisting that entry crashed every
  // later boot ("can't access property 'meta', e is null" on the home route).
  it("does not persist a successful infinite query holding a corrupt page", () => {
    expect(
      shouldDehydrateQuery({
        queryKey: ["recent-changes", undefined],
        state: {
          status: "success",
          data: { pages: [undefined], pageParams: [undefined] },
        },
      }),
    ).toBe(false);
  });

  it("persists a successful infinite query whose pages are all real", () => {
    expect(
      shouldDehydrateQuery({
        queryKey: ["recent-changes", undefined],
        state: {
          status: "success",
          data: { pages: [{ items: [], meta: {} }], pageParams: [undefined] },
        },
      }),
    ).toBe(true);
  });
});

describe("isCorruptInfiniteData", () => {
  it.each([
    ["a null page (the JSON round trip of undefined)", [null]],
    ["an undefined page (committed live before serialization)", [undefined]],
    ["an HTML body stored as a page", ["<!doctype html><html>…"]],
    ["a corrupt page after valid ones", [{ items: [], meta: {} }, null]],
  ])("flags %s", (_name, pages) => {
    expect(isCorruptInfiniteData({ pages, pageParams: [undefined] })).toBe(true);
  });

  it("accepts well-formed infinite data, including zero pages", () => {
    expect(
      isCorruptInfiniteData({
        pages: [{ items: [], meta: { hasNextPage: false } }],
        pageParams: [undefined],
      }),
    ).toBe(false);
    expect(isCorruptInfiniteData({ pages: [], pageParams: [] })).toBe(false);
  });

  // Plain queries are none of this policy's business, whatever their shape.
  it.each([
    ["a plain object payload", { items: [], meta: {} }],
    ["an array payload (breadcrumbs)", [{ id: "p1" }]],
    ["a payload with a non-array pages field", { pages: "not-an-array" }],
    ["undefined data", undefined],
    ["null data", null],
    ["a string payload", "hello"],
  ])("ignores %s", (_name, data) => {
    expect(isCorruptInfiniteData(data)).toBe(false);
  });
});

describe("sanitizeRestoredClient", () => {
  const entry = (root: string, data: unknown) => ({
    queryKey: [root],
    queryHash: `["${root}"]`,
    state: { status: "success", data },
  });

  it("drops exactly the poisoned entries and keeps the rest", () => {
    const good = entry("currentUser", { id: "u1" });
    const alsoGood = entry("comments", {
      pages: [{ items: [], meta: {} }],
      pageParams: [null],
    });
    const poisoned = entry("recent-changes", {
      pages: [null],
      pageParams: [null],
    });

    const client = {
      buster: "0.95.0",
      timestamp: 123,
      clientState: { mutations: [], queries: [good, poisoned, alsoGood] },
    };

    expect(sanitizeRestoredClient(client)).toEqual({
      buster: "0.95.0",
      timestamp: 123,
      clientState: { mutations: [], queries: [good, alsoGood] },
    });
  });

  it("returns a clean client unchanged in content", () => {
    const client = {
      buster: "b",
      timestamp: 1,
      clientState: { mutations: [], queries: [entry("currentUser", {})] },
    };
    expect(sanitizeRestoredClient(client)).toEqual(client);
  });

  // The input is whatever JSON.parse produced from disk; a malformed store
  // must degrade, never throw inside the restore path.
  it.each([
    ["null", null],
    ["a string", "garbage"],
    ["an object with no clientState", { buster: "b" }],
    ["a clientState with no queries array", { clientState: { queries: "x" } }],
  ])("passes %s through untouched", (_name, input) => {
    expect(sanitizeRestoredClient(input)).toBe(input);
  });

  it("tolerates query entries with missing state", () => {
    const bare = { queryKey: ["x"] };
    const client = {
      clientState: { mutations: [], queries: [bare] },
    };
    expect(sanitizeRestoredClient(client)).toEqual(client);
  });
});

describe("isSnapshotWorthPersisting", () => {
  const snapshot = (keys: readonly unknown[][]) => ({
    clientState: { queries: keys.map((queryKey) => ({ queryKey })) },
  });

  it("accepts a snapshot from a booted, authenticated session", () => {
    expect(
      isSnapshotWorthPersisting(
        snapshot([
          ["currentUser"],
          ["space", "s1"],
          ["pages", "abc"],
        ]),
      ),
    ).toBe(true);
  });

  it("refuses a snapshot taken before the app finished booting", () => {
    expect(isSnapshotWorthPersisting(snapshot([]))).toBe(false);
  });

  // The exact shape observed in a browser when the server was unreachable: the
  // user query had errored out, leaving a handful of stale page entries that
  // would have replaced a complete offline cache.
  it("refuses a snapshot whose user query failed", () => {
    expect(
      isSnapshotWorthPersisting(
        snapshot([
          ["space", "s1"],
          ["pages", "uuid-1"],
          ["pages", "slug-1"],
        ]),
      ),
    ).toBe(false);
  });

  it("does not mistake another key for the user query", () => {
    expect(
      isSnapshotWorthPersisting(snapshot([["currentUserSomethingElse"]])),
    ).toBe(false);
  });
});
