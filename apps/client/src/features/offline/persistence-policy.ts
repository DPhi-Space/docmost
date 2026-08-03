/**
 * What offline persistence is allowed to write, when, and what it may read
 * back.
 *
 * Three decisions, all pure and dependency-free so they can be unit tested
 * exhaustively: which queries may leave memory ({@link shouldDehydrateQuery}),
 * whether a given snapshot is worth writing at all
 * ({@link isSnapshotWorthPersisting}), and which restored entries must be
 * dropped as corrupt before they reach the query cache
 * ({@link sanitizeRestoredClient}). `persistence.ts` is the only caller and
 * does nothing but delegate here.
 *
 * The rule is an **allowlist keyed on `queryKey[0]`** — never a denylist. New
 * query keys appear in this app all the time (search variants, EE settings,
 * billing, member lists); a denylist would silently start persisting each one.
 * With an allowlist a forgotten key simply is not available offline, which is a
 * missing feature rather than a leak.
 */

/**
 * Query key roots persisted to IndexedDB. Everything needed to boot the app,
 * draw the navigation tree, and read a previously visited page.
 *
 * Ordering mirrors the app's dependency chain (identity → workspace → tree →
 * page) rather than the alphabet, so the list reads as "what an offline boot
 * needs, in the order it needs it".
 */
export const PERSISTED_QUERY_KEY_ROOTS = [
  // identity + workspace shell — without these `UserProvider` blanks the app
  "currentUser",
  "workspace",
  "entitlements",
  // navigation
  "spaces",
  "space",
  "root-sidebar-pages",
  "sidebar-pages",
  // page content and its surroundings
  "pages",
  "breadcrumbs",
  "favorites",
  "favorite-ids",
  "recent-changes",
  "comments",
] as const;

export type PersistedQueryKeyRoot = (typeof PERSISTED_QUERY_KEY_ROOTS)[number];

/**
 * Keys that must never be persisted even if someone later widens the allowlist
 * by accident. This constant is **documentation and a test fixture** — it is
 * deliberately not a second runtime gate, because two gates are two places for
 * the policy to drift. The unit tests assert the allowlist rejects every entry
 * here.
 *
 * Reasons, in the order listed:
 * - `collab-token` is a signed JWT. Writing it to IndexedDB would leave a live
 *   credential on disk after the tab closes — strictly worse than today.
 * - `notifications` is registered with `gcTime: 0`; persisting it would
 *   resurrect entries the app deliberately throws away.
 * - the search families take the query string as part of the key, so their key
 *   cardinality is unbounded and the store would grow without limit.
 * - billing/licence/SSO/API-key/invitation/member data is administrative, often
 *   sensitive, and worthless offline.
 */
export const NEVER_PERSISTED_QUERY_KEY_ROOTS = [
  "collab-token",
  "notifications",
  "page-search",
  "search-suggestion",
  "share-search",
  "attachment-search",
  "unified-search",
  "billing",
  "billing-plans",
  "license",
  "sso-provider",
  "sso-providers",
  "api-key-list",
  "invitations",
  "workspaceMembers",
  "spaceMembers",
  "groupMembers",
] as const;

const ALLOWED = new Set<string>(PERSISTED_QUERY_KEY_ROOTS);

/**
 * The persistable half of the decision: does this key's root opt into disk?
 *
 * Non-string roots are rejected. React Query allows any serialisable value at
 * `queryKey[0]`, but every key in this app is rooted in a string literal, so a
 * non-string root is a key shape we have never reviewed.
 */
export function isPersistableQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && ALLOWED.has(root);
}

/** The subset of a React Query `Query` this policy needs to see. */
export interface DehydrationCandidate {
  queryKey: readonly unknown[];
  state: { status: string; data?: unknown };
}

/**
 * Infinite-query data whose `pages` array holds something that is not a page.
 *
 * React Query validates only the *top-level* fetch result against `undefined`;
 * for an infinite query that result is the `{ pages, pageParams }` wrapper, so
 * a queryFn that resolves `undefined` or `null` for one page (observed in
 * production when a reverse proxy answered an `/api` POST with 200 + HTML)
 * commits that value into `pages` and still reports success. Persisting it is
 * what turned a one-off bad fetch into a crash on every boot: the JSON round
 * trip freezes `undefined` into `null`, and the restored entry throws in
 * `getNextPageParam` during first render — before the post-restore
 * invalidation can refetch and heal it. Seen in the field as a black screen on
 * the home route from a poisoned `["recent-changes", …]` entry.
 *
 * Every page this app fetches is an object (`IPagination`), so any non-object
 * entry is corruption, not data. Plain queries (no `pages` array) pass
 * through untouched.
 */
export function isCorruptInfiniteData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const pages = (data as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return false;
  return pages.some((page) => typeof page !== "object" || page === null);
}

/**
 * The predicate handed to `dehydrateOptions.shouldDehydrateQuery`.
 *
 * Three conditions, all required:
 * 1. the query succeeded — persisting a pending or errored entry would restore
 *    a broken query on the next boot, which is exactly the state offline mode
 *    exists to avoid;
 * 2. its data is not corrupt ({@link isCorruptInfiniteData}) — a poisoned
 *    entry written once would otherwise crash every later boot;
 * 3. its key root is on the allowlist.
 */
export function shouldDehydrateQuery(query: DehydrationCandidate): boolean {
  if (query.state.status !== "success") return false;
  if (isCorruptInfiniteData(query.state.data)) return false;
  return isPersistableQueryKey(query.queryKey);
}

/**
 * The subset of a dehydrated `PersistedClient` the restore-side filter needs.
 * Structural rather than imported so this module stays dependency-free.
 */
interface RestoredClientLike {
  clientState: {
    queries: Array<{ state?: { data?: unknown } }>;
  };
}

function isRestoredClientLike(value: unknown): value is RestoredClientLike {
  return Array.isArray(
    (value as Partial<RestoredClientLike> | null)?.clientState?.queries,
  );
}

/**
 * Drop corrupt entries from a client read back off disk.
 *
 * The dehydrate-side check above protects stores written by builds that have
 * it; this is what heals stores poisoned *before* it existed (the buster used
 * to never change between fork builds, so those stores were never going to be
 * discarded on their own). Dropping the whole query rather than the bad page
 * keeps `pages` and `pageParams` aligned; the cost is one refetch of an entry
 * that could not be rendered anyway.
 *
 * Typed `unknown → unknown` because the input is whatever `JSON.parse`
 * produced from the store — the caller owns the claim that the result is a
 * `PersistedClient`. A malformed store must degrade to "restore nothing
 * extra", never to a throw inside the restore path.
 */
export function sanitizeRestoredClient(client: unknown): unknown {
  if (!isRestoredClientLike(client)) return client;
  return {
    ...client,
    clientState: {
      ...client.clientState,
      queries: client.clientState.queries.filter(
        (query) => !isCorruptInfiniteData(query?.state?.data),
      ),
    },
  };
}

/**
 * Whether a dehydrated snapshot may overwrite the one already on disk.
 *
 * Persistence replaces the store wholesale, and only successful queries are
 * dehydrated — so a session that cannot reach the server produces a snapshot
 * with most of its entries missing, and writing it *erases* a good offline
 * cache. Observed in a browser before this guard existed: one reload against an
 * unreachable server left the store with three page entries and no user, so the
 * next offline boot rendered nothing.
 *
 * `currentUser` is the tell. Every authenticated app load fetches it, it is on
 * the allowlist, and it is absent from a snapshot in exactly two situations:
 * the app has not finished booting, or `/users/me` is failing. In both, what is
 * already on disk is better than what is in memory.
 *
 * This deliberately does not try to be a general "is the new state at least as
 * good as the old" comparison: that needs the previous store read back on every
 * throttled write, and the cheap test catches the failure that actually occurs.
 */
export function isSnapshotWorthPersisting(snapshot: {
  clientState: { queries: ReadonlyArray<{ queryKey: readonly unknown[] }> };
}): boolean {
  return snapshot.clientState.queries.some(
    (query) => query.queryKey[0] === "currentUser",
  );
}
