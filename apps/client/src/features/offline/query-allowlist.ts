/**
 * Which React Query entries are allowed to leave memory and land on disk.
 *
 * This is the whole security and size policy of offline persistence, kept pure
 * and dependency-free so it can be unit tested exhaustively. `persistence.ts`
 * is the only caller; it does nothing but hand each query to
 * {@link shouldDehydrateQuery}.
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
  state: { status: string };
}

/**
 * The predicate handed to `dehydrateOptions.shouldDehydrateQuery`.
 *
 * Two conditions, both required:
 * 1. the query succeeded — persisting a pending or errored entry would restore
 *    a broken query on the next boot, which is exactly the state offline mode
 *    exists to avoid;
 * 2. its key root is on the allowlist.
 */
export function shouldDehydrateQuery(query: DehydrationCandidate): boolean {
  if (query.state.status !== "success") return false;
  return isPersistableQueryKey(query.queryKey);
}
