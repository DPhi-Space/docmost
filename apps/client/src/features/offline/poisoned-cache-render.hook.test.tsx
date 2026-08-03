/**
 * A poisoned cache entry must not crash the hooks that render it.
 *
 * The field incident: a persisted `["recent-changes", …]` entry whose `pages`
 * array held `null` threw in `getNextPageParam` ("can't access property
 * 'meta', e is null") during the first render after restore — a blackscreen on
 * the home route, on every boot, until the store was deleted by hand. The
 * restore-side sanitizer now drops such entries before they reach the cache;
 * the `lastPage?.meta?…` guards in the query hooks are the layer below it,
 * for data poisoned *live* in a running session.
 *
 * Those guards are one-character edits in upstream files — exactly what a
 * "take theirs" rebase resolution reverts silently — so this suite pins them
 * where it matters: the real hooks, mounted over a cache seeded with the real
 * poison shape. Reverting any guard turns its case here into the original
 * TypeError.
 *
 * Scope: the five infinite families on the persistence allowlist. Non-persisted
 * infinite queries keep their upstream (unguarded) callbacks on purpose — they
 * cannot be poisoned by a restore, and the fork keeps upstream deltas minimal.
 */

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/main", () => ({ queryClient: {} }));
vi.mock("@/features/page/services/page-service", () => ({
  createPage: vi.fn(),
  deletePage: vi.fn(),
  getPageById: vi.fn(),
  getSidebarPages: vi.fn(),
  updatePage: vi.fn(),
  movePage: vi.fn(),
  getPageBreadcrumbs: vi.fn(),
  getRecentChanges: vi.fn(),
  getCreatedByPages: vi.fn(),
  getAllSidebarPages: vi.fn(),
  getDeletedPages: vi.fn(),
  restorePage: vi.fn(),
  lockPage: vi.fn(),
}));
vi.mock("@/features/comment/services/comment-service", () => ({
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  getPageComments: vi.fn(),
  updateComment: vi.fn(),
}));
vi.mock("@/features/favorite/services/favorite-service", () => ({
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  getFavorites: vi.fn(),
  getFavoriteIds: vi.fn(),
}));

import {
  useGetRootSidebarPagesQuery,
  useGetSidebarPagesQuery,
  useRecentChangesQuery,
} from "@/features/page/queries/page-query";
import { useCommentsQuery } from "@/features/comment/queries/comment-query";
import { useFavoritesQuery } from "@/features/favorite/queries/favorite-query";

/** The on-disk poison, as JSON hands it back: a null where a page should be. */
const POISONED_DATA = { pages: [null], pageParams: [null] };

function renderWithPoisonedEntry<T>(
  queryKey: readonly unknown[],
  useHook: () => T,
): T {
  const client = new QueryClient({
    // Freeze the cache: no background refetch, so the assertion sees exactly
    // the synchronous render over the seeded data — the moment that crashed.
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, staleTime: Infinity },
    },
  });
  client.setQueryData(queryKey, POISONED_DATA);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(useHook, { wrapper }).result.current;
}

interface InfiniteResultLike {
  isSuccess: boolean;
  hasNextPage: boolean;
}

describe("persisted infinite queries over a poisoned cache entry", () => {
  const cases: Array<[string, readonly unknown[], () => InfiniteResultLike]> = [
    [
      "recent-changes (the field crash)",
      ["recent-changes", undefined],
      () => useRecentChangesQuery(undefined),
    ],
    [
      "root-sidebar-pages",
      ["root-sidebar-pages", "space-1"],
      () => useGetRootSidebarPagesQuery({ spaceId: "space-1" }),
    ],
    [
      "sidebar-pages",
      ["sidebar-pages", { pageId: "page-1" }],
      () => useGetSidebarPagesQuery({ pageId: "page-1" }),
    ],
    ["favorites", ["favorites", undefined, undefined], () => useFavoritesQuery()],
  ];

  it.each(cases)("%s renders instead of throwing", (_name, key, useHook) => {
    const result = renderWithPoisonedEntry(key, useHook);

    expect(result.isSuccess).toBe(true);
    // A null last page must read as "no next page", never as a crash.
    expect(result.hasNextPage).toBe(false);
  });

  // useCommentsQuery aggregates its pages itself (`flatMap((p) => p.items)`),
  // which was a second crash site the getNextPageParam guard alone did not
  // cover — found by this very suite. Null pages must vanish from the
  // aggregation, and an all-null entry must read as "no comments yet".
  it("comments aggregates around the poison instead of throwing", () => {
    const result = renderWithPoisonedEntry(["comments", "page-1"], () =>
      useCommentsQuery({ pageId: "page-1" }),
    );

    expect(result.isError).toBe(false);
    expect(result.data).toBeUndefined();
  });
});
