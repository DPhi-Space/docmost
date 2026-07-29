/**
 * The entire surface `features/editor/page-editor.tsx` imports from this
 * feature — one module, so the patch to the collaboration-adjacent file is a
 * single import statement.
 *
 * That file is the one upstream rewrote in the Hocuspocus v4 / collab-socket
 * work that produced the data-loss regression this fork is pinned away from
 * (AGENTS.md, docmost#2353). Its diff has to stay small enough to re-apply by
 * hand if the base ever moves past that rewrite, and re-applying is much easier
 * when there is exactly one thing to re-import.
 *
 * Nothing else should import from here — the individual modules are the public
 * interface for everything inside `features/offline/`.
 */

export { isCollabTokenExpired } from "./collab-auth";
export { reportPageUnavailable } from "./offline-edit-state";
export { useOfflineEditGate } from "./offline-edit-gate";
