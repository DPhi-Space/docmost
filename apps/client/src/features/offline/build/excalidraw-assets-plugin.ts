/**
 * Vite plugin that self-hosts the Excalidraw font assets.
 *
 * `@excalidraw/excalidraw` 0.18 resolves its fonts against
 * `window.EXCALIDRAW_ASSET_PATH`, falling back to its CDN when the global is
 * unset — which it was, everywhere in this client, so every deployment loaded
 * fonts from a third-party CDN and the offline Excalidraw modal fell back to
 * system fonts (issue #21). This plugin copies the package's `dist/prod/fonts`
 * tree into the build as `excalidraw/fonts/**`, and `excalidraw-assets.ts`
 * points the global at `/excalidraw/` at runtime.
 *
 * **Build-time copy, not committed binaries**: the fonts come from the exact
 * installed package version on every build, so a dependency bump can never
 * leave stale font files behind in the repo.
 *
 * Emitted via `emitFile` with explicit `fileName`s (no hashing — the package's
 * own files are largely content-hashed already, and the runtime URL must be
 * predictable for `EXCALIDRAW_ASSET_PATH`). Emitting them as bundle assets,
 * rather than copying to `outDir` on the side, is what lets the service-worker
 * plugin's `generateBundle` classification see them: the Latin families
 * (~0.5 MB) join the *optional* precache warm-up, while the 12 MB Xiaolai CJK
 * family stays runtime-cached only — see `precache-manifest.ts`, which owns
 * that split and keeps it out of the required `core` set that gates worker
 * activation.
 *
 * The dev server is untouched (`apply: "build"`): Excalidraw's URL resolver
 * appends its CDN fallback after our path, so a dev session simply falls
 * through to the CDN exactly as before.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const PLUGIN_NAME = "docmost:excalidraw-assets";

/** Where the assets land in the bundle, and the URL prefix they serve from. */
export const EXCALIDRAW_ASSET_DIR = "excalidraw";

function fontsSourceDir(root: string): string | null {
  try {
    // Resolved from the *main entry*, not `<pkg>/package.json`: the package's
    // `exports` map does not expose its package.json, so that resolve throws
    // `ERR_PACKAGE_PATH_NOT_EXPORTED`. The production entry is
    // `dist/prod/index.js`, and the fonts ship beside it in `dist/prod/fonts`.
    const require = createRequire(path.join(root, "package.json"));
    const mainEntry = require.resolve("@excalidraw/excalidraw");
    const fonts = path.join(path.dirname(mainEntry), "fonts");
    return fs.existsSync(fonts) ? fonts : null;
  } catch {
    return null;
  }
}

function walkFiles(dir: string, prefix = ""): Array<{ rel: string; abs: string }> {
  const found: Array<{ rel: string; abs: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...walkFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      found.push({ rel, abs: path.join(dir, entry.name) });
    }
  }
  return found;
}

export function excalidrawAssetsPlugin(): Plugin {
  let root = process.cwd();

  return {
    name: PLUGIN_NAME,
    apply: "build",

    configResolved(config) {
      root = config.root;
    },

    buildStart() {
      const fonts = fontsSourceDir(root);
      if (!fonts) {
        // Loud, not fatal: the app still works via the CDN fallback, but the
        // offline modal silently losing its fonts is worth a warning.
        this.warn(
          `${PLUGIN_NAME}: @excalidraw/excalidraw font assets not found; ` +
            `Excalidraw will load fonts from its CDN and render with system ` +
            `fonts offline`,
        );
        return;
      }

      let emitted = 0;
      for (const file of walkFiles(fonts)) {
        this.emitFile({
          type: "asset",
          fileName: `${EXCALIDRAW_ASSET_DIR}/fonts/${file.rel}`,
          source: fs.readFileSync(file.abs),
        });
        emitted += 1;
      }
      this.info?.(`${PLUGIN_NAME}: emitted ${emitted} self-hosted font files`);
    },
  };
}
