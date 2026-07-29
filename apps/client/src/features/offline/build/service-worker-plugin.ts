/**
 * Vite plugin that emits `dist/sw.js`.
 *
 * Why hand-rolled instead of `vite-plugin-pwa`: see the "Offline/PWA" section of
 * AGENTS.md. Short version — workbox precaching is all-or-nothing over a
 * filename glob, which for this app is ~20 MB dominated by the D2 WASM chunk,
 * and a single failed request there means the worker never activates. This
 * plugin instead classifies the *module graph* (see `precache-manifest.ts`) and
 * splits the result into a small required set and a best-effort set.
 *
 * Mechanically it does two things after the app bundle is complete:
 *   1. `generateBundle` — classify the emitted chunks/assets into a manifest.
 *   2. `closeBundle`    — run a second, isolated Vite build that compiles
 *                         `sw/sw.ts` into a classic IIFE at the dist root, with
 *                         the manifest inlined via `define`.
 *
 * `sw.js` must land at the dist ROOT: the server registers `@fastify/static`
 * with `wildcard: false`, which enumerates the directory once at boot, so a
 * nested or late-appearing file falls through to the SPA catch-all and is
 * served as `text/html` — which browsers reject for a worker script.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { build } from "vite";
import {
  BundleEntryInfo,
  PrecacheManifest,
  buildPrecacheManifest,
} from "./precache-manifest";

const PLUGIN_NAME = "docmost:service-worker";
const SW_ENTRY = "src/features/offline/sw/sw.ts";
const SW_OUTPUT = "sw.js";

/** Public-dir files, relative to publicDir, using forward slashes. */
function listPublicFiles(publicDir: string): string[] {
  if (!publicDir || !fs.existsSync(publicDir)) return [];

  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        found.push(relative);
      }
    }
  };
  walk(publicDir, "");
  return found;
}

function computeBuildId(version: string, manifest: PrecacheManifest): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 12);
  return `${version || "0"}-${digest}`;
}

export interface ServiceWorkerPluginOptions {
  /** App version baked into the cache name; changing it busts the precache. */
  version?: string;
}

export function serviceWorkerPlugin(
  options: ServiceWorkerPluginOptions = {},
): Plugin {
  let root = process.cwd();
  let outDir = "dist";
  let publicDir = "";
  let manifest: PrecacheManifest = { core: [], optional: [] };

  return {
    name: PLUGIN_NAME,
    // Dev has no build output to precache and a stale worker would shadow HMR.
    apply: "build",
    enforce: "post",

    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
      publicDir = config.publicDir;
    },

    generateBundle(_outputOptions, bundle) {
      const entries: BundleEntryInfo[] = Object.values(bundle).map((item) => {
        if (item.type === "chunk") {
          const chunk = item as typeof item & {
            moduleIds?: string[];
            viteMetadata?: { importedCss?: Set<string> };
          };
          return {
            fileName: chunk.fileName,
            type: "chunk" as const,
            isEntry: chunk.isEntry,
            imports: chunk.imports ?? [],
            moduleIds: chunk.moduleIds ?? Object.keys(chunk.modules ?? {}),
            importedCss: [...(chunk.viteMetadata?.importedCss ?? [])],
          };
        }
        return { fileName: item.fileName, type: "asset" as const };
      });

      manifest = buildPrecacheManifest(entries, listPublicFiles(publicDir));
    },

    async closeBundle() {
      const buildId = computeBuildId(options.version ?? "", manifest);

      // A second, self-contained build. `configFile: false` keeps it from
      // re-entering this plugin (which would recurse), and `emptyOutDir: false`
      // keeps it from wiping the app bundle we just classified.
      await build({
        root,
        configFile: false,
        logLevel: "warn",
        publicDir: false,
        define: {
          __SW_PRECACHE_MANIFEST__: `(${JSON.stringify(manifest)})`,
          __SW_BUILD_ID__: JSON.stringify(buildId),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          minify: true,
          target: "es2020",
          reportCompressedSize: false,
          rollupOptions: {
            input: path.resolve(root, SW_ENTRY),
            output: {
              format: "iife",
              entryFileNames: SW_OUTPUT,
              // Any stray chunk would be unreachable from a classic worker.
              chunkFileNames: SW_OUTPUT.replace(/\.js$/, "-[hash].js"),
            },
          },
        },
      });

      const emitted = path.join(outDir, SW_OUTPUT);
      if (!fs.existsSync(emitted)) {
        throw new Error(
          `${PLUGIN_NAME}: expected ${SW_OUTPUT} at the dist root, but it was not emitted`,
        );
      }

      this.info?.(
        `${PLUGIN_NAME}: ${SW_OUTPUT} built (${manifest.core.length} core + ${manifest.optional.length} optional precache entries, build id ${buildId})`,
      );
    },
  };
}
