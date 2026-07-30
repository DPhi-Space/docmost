/**
 * Turning a page id into something a user can click.
 *
 * The dirty registry is written from the phase-2 editor hook, which knows only
 * a `pageId`; the blocked list has to show a title and link to the page. The
 * missing pieces — slug, title, space slug — live in the React Query cache, and
 * the hook cannot reach it: `useQueryClient()` needs a provider the hook's unit
 * tests do not mount, and importing the app's exported client from `main.tsx`
 * would drag `ReactDOM.createRoot` into every test that touches the gate.
 *
 * So the resolver is *installed* rather than imported. `use-offline-resync.ts`
 * mounts inside the provider tree and sets it; everything below degrades to
 * `undefined` when it has not been set, which is exactly the right answer in a
 * unit test and in the window before the app has mounted.
 *
 * Resolving at **record time** rather than at display time is deliberate: the
 * link is then part of the record, so a blocked page stays nameable and
 * reachable even after the query cache has evicted it. A blocked entry can
 * outlive many sessions — it is the only pointer to work that exists on this
 * device alone.
 */

import { buildPageUrl } from "@/features/page/page.utils";
import type { DirtyPageLink, DirtyPageRecord } from "./dirty-pages";

/** The shape this module needs out of `IPage`; structural to keep it testable. */
export interface PageLinkFields {
  slugId?: string;
  title?: string;
  space?: { slug?: string };
}

export type DirtyPageLinkResolver = (pageId: string) => PageLinkFields | undefined;

let resolver: DirtyPageLinkResolver | null = null;

/** Install (or, with `null`, remove) the query-cache lookup. */
export function setDirtyPageLinkResolver(next: DirtyPageLinkResolver | null): void {
  resolver = next;
}

/** Project a page onto the fields the registry stores. */
export function pageLinkFields(page: PageLinkFields | undefined): DirtyPageLink | undefined {
  if (!page) return undefined;
  const link: DirtyPageLink = {
    slugId: page.slugId,
    title: page.title,
    spaceSlug: page.space?.slug,
  };
  return link.slugId || link.title || link.spaceSlug ? link : undefined;
}

/**
 * Best-effort link metadata for a page. Never throws and never blocks: this
 * runs on the editing hot path, once per offline keystroke burst.
 */
export function resolveDirtyPageLink(pageId: string): DirtyPageLink | undefined {
  try {
    return pageLinkFields(resolver?.(pageId));
  } catch {
    return undefined;
  }
}

/**
 * Where "review" sends the user.
 *
 * Without a space slug this falls back to `/p/<slug>`, which `App.tsx` routes
 * through `PageRedirect` — the same URL shape `buildPageUrl` produces for a
 * page whose space is unknown. Without even a slug the page id is used: it is
 * not a working link, but it is a stable identifier the user can search for,
 * and it keeps the entry visible rather than hidden.
 */
export function dirtyPageHref(
  // Structurally just the two fields used, so phase 4's upload records — which
  // capture the same link metadata — can be linked with the same rules.
  record: Pick<DirtyPageRecord, "pageId" | "link">,
): string {
  const slug = record.link?.slugId ?? record.pageId;
  const spaceSlug = record.link?.spaceSlug;
  return spaceSlug
    ? buildPageUrl(spaceSlug, slug, record.link?.title)
    : // `buildPageUrl` branches on `spaceName === undefined` but types it as
      // `string`; this is that documented branch, not a missing value.
      buildPageUrl(undefined as unknown as string, slug, record.link?.title);
}
