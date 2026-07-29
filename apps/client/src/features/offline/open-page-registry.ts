/**
 * Which collaboration document the editor currently owns.
 *
 * This is the whole of the coordination between phase 2 and phase 3, and it
 * exists to guarantee one thing: **two `HocuspocusProvider`s are never attached
 * to the same `documentName` at once.** Two providers on one document would
 * mean two `IndexeddbPersistence` instances writing the same `page.<pageId>`
 * database and two sync handshakes racing each other — squarely inside the
 * class of failure the fork's version pin exists to avoid.
 *
 * It is a claim, not a lock, because the two sides are not peers. `PageEditor`
 * must always win: the user navigating to a page cannot be made to wait for a
 * background task. So the editor claims unconditionally, and the resync manager
 * both checks before starting a page and keeps checking while it runs, standing
 * down the moment the editor takes the same document.
 *
 * Module scope is the right home: exactly one `PageEditor` is mounted at a
 * time, and the manager is a per-tab singleton. Cross-*tab* exclusion is a
 * different problem with a different answer (`navigator.locks`, see
 * `resync-manager.ts`) — this file is only about one document.
 */

let openPageId: string | null = null;

/**
 * The editor has taken this document.
 *
 * Always succeeds. A resync in flight for the same page discovers this on its
 * next poll and aborts, leaving the registry entry in place so the page is
 * picked up again later — by the editor's own provider, most likely.
 */
export function claimOpenPage(pageId: string): void {
  openPageId = pageId;
}

/**
 * The editor has let this document go.
 *
 * Releases only if the claim is still ours. `PageEditor` is not remounted
 * across navigation, so React runs the *new* page's effect before the previous
 * page's cleanup in some orderings; an unconditional clear would then wipe a
 * claim that had already been re-made for the page now on screen.
 */
export function releaseOpenPage(pageId: string): void {
  if (openPageId === pageId) openPageId = null;
}

export function getOpenPage(): string | null {
  return openPageId;
}

/** Test seam: module state has to be resettable between cases. */
export function resetOpenPageForTests(): void {
  openPageId = null;
}
