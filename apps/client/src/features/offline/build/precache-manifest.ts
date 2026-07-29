/**
 * Pure classification of a finished Vite/rolldown bundle into a service-worker
 * precache manifest.
 *
 * This module is deliberately free of node and browser APIs so it can be unit
 * tested and so the same code can run inside the build plugin.
 *
 * Two buckets, on purpose:
 *
 *  - `core`      required. Fetched during the service worker `install` event;
 *                if any of these fail, install fails and the worker never
 *                activates. Keep this to the app shell.
 *  - `optional`  best effort. Warmed after activation; failures are swallowed.
 *                This is where the very large self-hosted diagram renderers
 *                (mermaid, D2) go — the D2 chunk alone inlines a multi-MB
 *                base64 WASM binary, and an all-or-nothing precache of that
 *                size is a reliable way to end up with no offline support at
 *                all on a flaky connection.
 *
 * The single hard invariant: **no HTML is ever precached**. The server rewrites
 * `client/dist/index.html` at boot to inject `window.CONFIG` (and keeps the
 * pristine copy as `index-template.html` in the same directory), so a
 * build-time HTML file is config-less and unusable. Navigations are handled at
 * runtime instead — see `../sw/routes.ts`.
 */

export type BundleEntryType = "chunk" | "asset";

export interface BundleEntryInfo {
  /** Path relative to the build outDir, e.g. `assets/index-CmTnhK4F.js`. */
  fileName: string;
  type: BundleEntryType;
  /** True for the html/js entry points of the build. */
  isEntry?: boolean;
  /** Statically imported chunk file names (NOT dynamic imports). */
  imports?: string[];
  /** Absolute module ids that were rolled into this chunk. */
  moduleIds?: string[];
  /** CSS files Vite associates with this chunk. */
  importedCss?: string[];
}

export interface PrecacheManifest {
  core: string[];
  optional: string[];
}

/**
 * Module-id markers that make a chunk "heavy but worth having offline".
 * Matching on module ids rather than on file names is deliberate: under
 * rolldown these land in opaque content-hashed chunks (`chunk-Z5NKEFVG-*.js`,
 * `browser-D2tXIcaq.js`) whose names carry no hint of their contents.
 */
export const OPTIONAL_MODULE_MARKERS = [
  // The libraries themselves.
  "/node_modules/mermaid/",
  "/node_modules/@terrastruct/d2/",
  // ...and our own lazy wrappers that import them. These are tiny chunks with
  // no library module of their own, so nothing else marks them — but without
  // them the libraries are cached and unreachable: the dynamic import fails
  // offline with "Failed to fetch dynamically imported module". Observed for
  // real in an offline browser run; see the Offline/PWA section of AGENTS.md.
  //
  // Naming these explicitly beats walking the import graph backwards from the
  // libraries: mermaid shares vendor chunks with Excalidraw, so a reverse walk
  // sweeps in unrelated lazy features (measured: 54 entries -> 122, dragging in
  // Excalidraw and every one of its locale chunks).
  "/src/features/editor/components/code-block/mermaid-view",
  "/src/features/editor/components/code-block/d2-view",
];

/** Public-dir files worth precaching. Locales are deliberately absent — they
 * are fetched at runtime by i18next-http-backend and are stale-while-revalidate. */
export const PUBLIC_PRECACHE_PATTERNS: RegExp[] = [
  /^icons\/.+\.(png|svg|ico)$/,
  /^manifest\.json$/,
];

/** Assets always worth having in the shell. `.woff`/`.ttf` fallbacks are left
 * to the runtime cache; every browser we support picks the woff2. */
const CORE_ASSET_EXTENSIONS = [".woff2"];

/**
 * The one hard rule. Also drops sourcemaps, which are useless offline and
 * needlessly large.
 */
export function isPrecachableFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return !lower.endsWith(".html") && !lower.endsWith(".map");
}

export function isPublicPrecachableFile(fileName: string): boolean {
  const normalized = fileName.replace(/^\/+/, "");
  return (
    isPrecachableFile(normalized) &&
    PUBLIC_PRECACHE_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function toUrl(fileName: string): string {
  return "/" + fileName.replace(/^\/+/, "");
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

function isOptionalModuleId(id: string): boolean {
  const normalized = normalizeModuleId(id);
  return OPTIONAL_MODULE_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Walks the *static* import graph from `seeds`. Dynamic imports are excluded on
 * purpose: they are the lazy chunks, which the runtime CacheFirst route picks
 * up once they have actually been used.
 */
function staticImportClosure(
  seeds: string[],
  byFileName: Map<string, BundleEntryInfo>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];

  while (stack.length > 0) {
    const fileName = stack.pop() as string;
    if (seen.has(fileName)) continue;
    const entry = byFileName.get(fileName);
    if (!entry || entry.type !== "chunk") continue;
    seen.add(fileName);
    for (const imported of entry.imports ?? []) stack.push(imported);
  }

  return seen;
}

/**
 * Markers that matched no module in the bundle.
 *
 * The wrapper markers are source paths, so renaming or moving a diagram view
 * would silently drop it from the manifest and quietly break offline diagram
 * rendering. The build plugin warns on anything reported here.
 */
export function unmatchedOptionalMarkers(entries: BundleEntryInfo[]): string[] {
  const ids = entries.flatMap((entry) =>
    (entry.moduleIds ?? []).map(normalizeModuleId),
  );
  return OPTIONAL_MODULE_MARKERS.filter(
    (marker) => !ids.some((id) => id.includes(marker)),
  );
}

function cssOf(
  fileNames: Iterable<string>,
  byFileName: Map<string, BundleEntryInfo>,
): string[] {
  const css: string[] = [];
  for (const fileName of fileNames) {
    for (const sheet of byFileName.get(fileName)?.importedCss ?? []) {
      css.push(sheet);
    }
  }
  return css;
}

export function buildPrecacheManifest(
  entries: BundleEntryInfo[],
  publicFiles: string[] = [],
): PrecacheManifest {
  const byFileName = new Map(entries.map((entry) => [entry.fileName, entry]));
  const chunks = entries.filter((entry) => entry.type === "chunk");

  const coreChunks = staticImportClosure(
    chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName),
    byFileName,
  );

  const optionalSeeds = chunks
    .filter((chunk) => !coreChunks.has(chunk.fileName))
    .filter((chunk) => (chunk.moduleIds ?? []).some(isOptionalModuleId))
    .map((chunk) => chunk.fileName);

  const optionalChunks = new Set(
    [...staticImportClosure(optionalSeeds, byFileName)].filter(
      (fileName) => !coreChunks.has(fileName),
    ),
  );

  const core = new Set<string>(coreChunks);
  const coreCss = cssOf(coreChunks, byFileName);
  const optionalCss = cssOf(optionalChunks, byFileName);

  if (coreCss.length === 0 && optionalCss.length === 0) {
    // Vite's per-chunk CSS metadata was unavailable (a bundler-version change
    // would do it). Failing open on stylesheets is far better than shipping an
    // unstyled offline shell, so precache every emitted stylesheet.
    for (const entry of entries) {
      if (entry.type === "asset" && entry.fileName.endsWith(".css")) {
        core.add(entry.fileName);
      }
    }
  } else {
    for (const sheet of coreCss) core.add(sheet);
  }

  for (const entry of entries) {
    if (
      entry.type === "asset" &&
      CORE_ASSET_EXTENSIONS.some((ext) => entry.fileName.endsWith(ext))
    ) {
      core.add(entry.fileName);
    }
  }

  const coreUrls = new Set(
    [...core].filter(isPrecachableFile).map(toUrl),
  );
  for (const fileName of publicFiles) {
    if (isPublicPrecachableFile(fileName)) coreUrls.add(toUrl(fileName));
  }

  const optionalUrls = new Set<string>();
  for (const fileName of optionalChunks) {
    if (isPrecachableFile(fileName)) optionalUrls.add(toUrl(fileName));
  }
  for (const sheet of optionalCss) {
    if (isPrecachableFile(sheet)) optionalUrls.add(toUrl(sheet));
  }
  for (const url of coreUrls) optionalUrls.delete(url);

  return {
    core: [...coreUrls].sort(),
    optional: [...optionalUrls].sort(),
  };
}
