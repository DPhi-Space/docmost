/**
 * The persister's wiring, not its policy — same rationale as
 * `production-wiring.test.ts`: the policy suites inject their dependencies and
 * are therefore blind to whether `persistence.ts` actually connects them. The
 * two hookups pinned here are the ones the poisoned-cache incident added: the
 * composite buster and the restore-side sanitizer.
 */

import { describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (): Promise<string | null> => null),
  setItem: vi.fn(async () => {}),
  removeItem: vi.fn(async () => {}),
}));

// `persisted-store` opens IndexedDB at import time, which jsdom does not have.
vi.mock("./persisted-store", () => ({
  QUERY_CACHE_KEY: "react-query",
  queryCacheStorage: storage,
}));

import { offlinePersistOptions } from "./persistence";
import { shouldDehydrateQuery } from "./persistence-policy";

describe("offlinePersistOptions", () => {
  it("busts on the build id, not the package version alone", () => {
    // Under vitest neither define exists, so both halves read "dev" — what is
    // pinned is the composite shape. A buster equal to the bare package
    // version is the never-rotating configuration that let a poisoned store
    // survive every deploy (the fork's version is 0.95.0 on all of them).
    expect(offlinePersistOptions.buster).toBe("dev+dev");
  });

  it("hands dehydration to the policy module", () => {
    expect(offlinePersistOptions.dehydrateOptions.shouldDehydrateQuery).toBe(
      shouldDehydrateQuery,
    );
  });

  it("drops a poisoned infinite entry while restoring from disk", async () => {
    // The exact on-disk shape from the field incident: JSON froze an
    // undefined page to null inside a successful ["recent-changes", …] entry.
    const poisoned = {
      queryKey: ["recent-changes", null],
      queryHash: '["recent-changes",null]',
      state: {
        status: "success",
        data: { pages: [null], pageParams: [null] },
      },
    };
    const good = {
      queryKey: ["currentUser"],
      queryHash: '["currentUser"]',
      state: { status: "success", data: { id: "u1" } },
    };
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        buster: "dev+dev",
        timestamp: 1,
        clientState: { mutations: [], queries: [good, poisoned] },
      }),
    );

    const restored = await offlinePersistOptions.persister.restoreClient();

    expect(restored?.clientState.queries).toEqual([good]);
  });
});
