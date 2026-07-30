/**
 * Point Excalidraw at the self-hosted font assets.
 *
 * `@excalidraw/excalidraw` reads `window.EXCALIDRAW_ASSET_PATH` when it builds
 * font URLs; unset, it loads from its CDN — which means fonts break offline
 * and every deployment leaks requests to a third party. The build copies the
 * package's fonts to `/excalidraw/` (`build/excalidraw-assets-plugin.ts`);
 * this sets the global to match.
 *
 * Must run before the lazily-imported Excalidraw chunk evaluates. It is called
 * from `register.ts`, which `main.tsx` already imports for its side effects,
 * so the wiring costs zero lines in any upstream file.
 *
 * Excalidraw appends its CDN URL as a *fallback* after this path, so an
 * environment without the copied assets (the Vite dev server) degrades to
 * exactly the previous behaviour instead of broken fonts.
 */

export const EXCALIDRAW_ASSET_PATH = "/excalidraw/";

export function installExcalidrawAssetPath(): void {
  if (typeof window === "undefined") return;
  const target = window as Window & { EXCALIDRAW_ASSET_PATH?: unknown };
  // Never clobber an explicit override (e.g. set from the console while
  // debugging font resolution).
  if (target.EXCALIDRAW_ASSET_PATH !== undefined) return;
  target.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}
