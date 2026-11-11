/**
 * The entire surface `features/editor/page-editor.tsx` imports from this
 * feature — one module, so the patch to the collaboration-adjacent file is a
 * single import statement.
 *
 * That file is upstream's collaboration editor (Hocuspocus v4, shared
 * `collab-socket.ts`). Its diff has to stay small enough to re-apply by hand
 * whenever upstream rewrites it again, and re-applying is much easier when
 * there is exactly one thing to re-import.
 *
 * Nothing else should import from here — the individual modules are the public
 * interface for everything inside `features/offline/`.
 */

export { isCollabTokenExpired } from "./collab-auth";
export { reportPageUnavailable } from "./offline-edit-state";
export {
  useEditorOfflineEditGate,
  useMountCollabRoomOffline,
} from "./offline-edit-gate";
