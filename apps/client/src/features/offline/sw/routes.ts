/**
 * Pure request -> caching-strategy classification for the service worker.
 *
 * Kept free of service-worker globals so the decision table is unit testable;
 * `sw.ts` adapts a real `FetchEvent` into `RoutableRequest` and dispatches.
 */

export type RouteKind =
  | "navigation"
  | "asset"
  | "locale"
  | "api-file"
  | "passthrough";

export interface RoutableRequest {
  method: string;
  url: string;
  /** `Request.mode`, used to detect top-level navigations. */
  mode?: string;
  /** `Request.destination`, a more reliable navigation signal where present. */
  destination?: string;
  /** True when the request carries a `Range` header (media seeking). */
  hasRangeHeader?: boolean;
}

/**
 * Real-time transports. These are WebSocket upgrades, which never reach a
 * service worker `fetch` handler in the first place — the entries exist so the
 * exclusion is explicit and testable rather than incidental. Both the collab
 * server and socket.io run websocket-transport-only in this deployment.
 */
export const REALTIME_PATH_PREFIXES = ["/collab", "/socket.io"];

export const LOCALE_PATH_PREFIX = "/locales/";
export const FILE_API_PATH_PREFIX = "/api/files/";
export const API_PATH_PREFIX = "/api/";
export const ASSET_PATH_PREFIX = "/assets/";

/** Public-dir paths served as part of the shell. */
const SHELL_ASSET_PATHS = ["/manifest.json", "/vite.svg"];
const SHELL_ASSET_PREFIXES = ["/icons/"];

export function isNavigationRequest(request: RoutableRequest): boolean {
  return request.mode === "navigate" || request.destination === "document";
}

export function isRealtimePath(pathname: string): boolean {
  return REALTIME_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function isShellAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith(ASSET_PATH_PREFIX) ||
    SHELL_ASSET_PATHS.includes(pathname) ||
    SHELL_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * @param origin the worker's own origin (`self.location.origin`).
 * @returns `"passthrough"` means: do not call `respondWith`, let the network
 *          handle it exactly as if no service worker were installed.
 */
export function resolveRoute(
  request: RoutableRequest,
  origin: string,
): RouteKind {
  // Never touch mutations. Not "do not cache" — do not intercept at all.
  if (request.method.toUpperCase() !== "GET") return "passthrough";

  // Range requests would otherwise be answered from a full cached body or, if
  // stored, poison the cache with a 206.
  if (request.hasRangeHeader) return "passthrough";

  let url: URL;
  try {
    url = new URL(request.url, origin);
  } catch {
    return "passthrough";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "passthrough";

  // Cross-origin (PostHog, drawio embeds, Excalidraw CDN fonts, ...) is left
  // entirely alone: opaque responses are not useful and hide failures.
  if (url.origin !== origin) return "passthrough";

  if (isRealtimePath(url.pathname)) return "passthrough";

  if (isNavigationRequest(request)) return "navigation";

  if (url.pathname.startsWith(LOCALE_PATH_PREFIX)) return "locale";

  if (url.pathname.startsWith(FILE_API_PATH_PREFIX)) return "api-file";

  // Every other API call passes through untouched: no stale reads, and phase 1b
  // owns offline data via the persisted React Query cache instead.
  if (url.pathname.startsWith(API_PATH_PREFIX)) return "passthrough";

  if (isShellAssetPath(url.pathname)) return "asset";

  return "passthrough";
}
