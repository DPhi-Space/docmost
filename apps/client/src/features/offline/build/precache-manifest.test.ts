import { describe, it, expect } from "vitest";
import {
  BundleEntryInfo,
  OPTIONAL_MODULE_MARKERS,
  buildPrecacheManifest,
  isPrecachableFile,
  isPublicPrecachableFile,
  unmatchedOptionalMarkers,
} from "./precache-manifest";

const chunk = (
  fileName: string,
  extra: Partial<BundleEntryInfo> = {},
): BundleEntryInfo => ({
  fileName,
  type: "chunk",
  imports: [],
  moduleIds: [],
  importedCss: [],
  ...extra,
});

const asset = (fileName: string): BundleEntryInfo => ({
  fileName,
  type: "asset",
});

/** Mirrors the real rolldown output shape closely enough to be meaningful. */
const realisticBundle: BundleEntryInfo[] = [
  chunk("assets/index-CmTnhK4F.js", {
    isEntry: true,
    imports: ["assets/rolldown-runtime-aKtaBQYM.js", "assets/vendor-mantine-Cxq.js"],
    moduleIds: ["/repo/apps/client/src/main.tsx"],
    importedCss: ["assets/index-V9vAIF2h.css"],
  }),
  chunk("assets/rolldown-runtime-aKtaBQYM.js"),
  // The app's own lazy wrappers. They contain no node_modules/mermaid or
  // @terrastruct/d2 module of their own, so nothing marks them directly — but
  // without them the library chunks below are unreachable offline.
  chunk("assets/mermaid-view-D4yDZMas.js", {
    imports: ["assets/chunk-Z5NKEFVG-CaRJOzfK.js"],
    moduleIds: ["/repo/apps/client/src/features/editor/components/code-block/mermaid-view.tsx"],
  }),
  chunk("assets/d2-view-B5KpaUio.js", {
    moduleIds: ["/repo/apps/client/src/features/editor/components/code-block/d2-view.tsx"],
  }),
  chunk("assets/vendor-mantine-Cxq.js", {
    moduleIds: ["/repo/node_modules/@mantine/core/index.js"],
    importedCss: ["assets/vendor-mantine-CCV.css"],
  }),
  // Lazy: reachable only through dynamic import, so not in the entry closure.
  chunk("assets/chunk-Z5NKEFVG-CaRJOzfK.js", {
    imports: ["assets/mermaid-shared-AAA.js"],
    moduleIds: ["/repo/node_modules/mermaid/dist/mermaid.core.mjs"],
  }),
  chunk("assets/mermaid-shared-AAA.js", { moduleIds: ["/repo/node_modules/dagre/index.js"] }),
  chunk("assets/browser-D2tXIcaq.js", {
    moduleIds: ["/repo/node_modules/@terrastruct/d2/dist/browser.js"],
  }),
  chunk("assets/excalidraw-utils-B4z5z.js", {
    moduleIds: ["/repo/node_modules/@excalidraw/excalidraw/index.js"],
    importedCss: ["assets/excalidraw-utils-HOYK6HrD.css"],
  }),
  asset("assets/index-V9vAIF2h.css"),
  asset("assets/vendor-mantine-CCV.css"),
  asset("assets/excalidraw-utils-HOYK6HrD.css"),
  asset("assets/KaTeX_Main-Regular-B22Nviop.woff2"),
  asset("assets/KaTeX_Main-Regular-Dr94JaBh.woff"),
  asset("assets/KaTeX_Main-Regular-ypZvNtVU.ttf"),
];

const publicFiles = [
  "manifest.json",
  "vite.svg",
  "icons/app-icon-192x192.png",
  "icons/favicon-32x32.png",
  "locales/en-US/translation.json",
  "locales/de-DE/translation.json",
];

describe("isPrecachableFile", () => {
  it("never precaches HTML", () => {
    // The server injects window.CONFIG into the served index.html at boot and
    // keeps the pristine copy alongside it; both are unusable from dist.
    expect(isPrecachableFile("index.html")).toBe(false);
    expect(isPrecachableFile("index-template.html")).toBe(false);
    expect(isPrecachableFile("Index.HTML")).toBe(false);
  });

  it("never precaches sourcemaps", () => {
    expect(isPrecachableFile("assets/index-abc.js.map")).toBe(false);
  });

  it("allows normal build output", () => {
    expect(isPrecachableFile("assets/index-abc.js")).toBe(true);
    expect(isPrecachableFile("assets/index-abc.css")).toBe(true);
  });
});

describe("isPublicPrecachableFile", () => {
  it("includes the web manifest and icons", () => {
    expect(isPublicPrecachableFile("manifest.json")).toBe(true);
    expect(isPublicPrecachableFile("icons/app-icon-192x192.png")).toBe(true);
  });

  it("excludes locales, which are stale-while-revalidate at runtime", () => {
    expect(isPublicPrecachableFile("locales/en-US/translation.json")).toBe(false);
  });

  it("excludes HTML placed in the public dir", () => {
    expect(isPublicPrecachableFile("icons/foo.html")).toBe(false);
  });
});

describe("buildPrecacheManifest", () => {
  const manifest = buildPrecacheManifest(realisticBundle, publicFiles);

  it("never emits an HTML url in either bucket", () => {
    const all = [...manifest.core, ...manifest.optional];
    expect(all.filter((url) => url.endsWith(".html"))).toEqual([]);
  });

  it("precaches the entry chunk and its static import closure", () => {
    expect(manifest.core).toContain("/assets/index-CmTnhK4F.js");
    expect(manifest.core).toContain("/assets/rolldown-runtime-aKtaBQYM.js");
    expect(manifest.core).toContain("/assets/vendor-mantine-Cxq.js");
  });

  it("precaches the CSS of core chunks only", () => {
    expect(manifest.core).toContain("/assets/index-V9vAIF2h.css");
    expect(manifest.core).toContain("/assets/vendor-mantine-CCV.css");
    expect(manifest.core).not.toContain("/assets/excalidraw-utils-HOYK6HrD.css");
  });

  it("puts mermaid and D2 chunks in the best-effort bucket, not the required one", () => {
    expect(manifest.optional).toContain("/assets/chunk-Z5NKEFVG-CaRJOzfK.js");
    expect(manifest.optional).toContain("/assets/browser-D2tXIcaq.js");
    expect(manifest.core).not.toContain("/assets/browser-D2tXIcaq.js");
  });

  it("pulls a heavy chunk's own static dependencies along with it", () => {
    expect(manifest.optional).toContain("/assets/mermaid-shared-AAA.js");
  });

  it("precaches the lazy wrappers that reach the heavy chunks", () => {
    // Regression: caching mermaid.core but not the mermaid-view chunk that
    // imports it makes the library unreachable — the dynamic import fails
    // offline with "Failed to fetch dynamically imported module". Observed in
    // a real offline browser run before this rule existed.
    expect(manifest.optional).toContain("/assets/mermaid-view-D4yDZMas.js");
    expect(manifest.optional).toContain("/assets/d2-view-B5KpaUio.js");
  });

  it("does not drag unrelated lazy features in with the diagram renderers", () => {
    // Excalidraw shares vendor chunks with mermaid. It must stay out of the
    // manifest and be left to the runtime CacheFirst route.
    expect(manifest.optional).not.toContain("/assets/excalidraw-utils-B4z5z.js");
    expect(manifest.optional).not.toContain("/assets/excalidraw-utils-HOYK6HrD.css");
    expect(manifest.optional).not.toContain("/assets/index-CmTnhK4F.js");
  });

  it("leaves other lazy chunks to the runtime cache", () => {
    const all = [...manifest.core, ...manifest.optional];
    expect(all).not.toContain("/assets/excalidraw-utils-B4z5z.js");
  });

  it("precaches woff2 fonts but leaves woff/ttf fallbacks to runtime", () => {
    expect(manifest.core).toContain("/assets/KaTeX_Main-Regular-B22Nviop.woff2");
    expect(manifest.core).not.toContain("/assets/KaTeX_Main-Regular-Dr94JaBh.woff");
    expect(manifest.core).not.toContain("/assets/KaTeX_Main-Regular-ypZvNtVU.ttf");
  });

  it("precaches the web manifest and icons, but not locales", () => {
    expect(manifest.core).toContain("/manifest.json");
    expect(manifest.core).toContain("/icons/app-icon-192x192.png");
    expect(manifest.core).not.toContain("/locales/en-US/translation.json");
  });

  it("keeps the two buckets disjoint and sorted", () => {
    const overlap = manifest.core.filter((url) =>
      manifest.optional.includes(url),
    );
    expect(overlap).toEqual([]);
    expect(manifest.core).toEqual([...manifest.core].sort());
    expect(manifest.optional).toEqual([...manifest.optional].sort());
  });

  it("falls back to precaching every stylesheet when chunk CSS metadata is missing", () => {
    const withoutCssMetadata = realisticBundle.map((entry) =>
      entry.type === "chunk" ? { ...entry, importedCss: [] } : entry,
    );
    const fallback = buildPrecacheManifest(withoutCssMetadata, publicFiles);
    expect(fallback.core).toContain("/assets/index-V9vAIF2h.css");
    expect(fallback.core).toContain("/assets/vendor-mantine-CCV.css");
    expect(fallback.core).toContain("/assets/excalidraw-utils-HOYK6HrD.css");
  });

  it("normalizes windows-style module ids when matching heavy dependencies", () => {
    const windowsBundle: BundleEntryInfo[] = [
      chunk("assets/entry.js", { isEntry: true }),
      chunk("assets/d2.js", {
        moduleIds: ["C:\\repo\\node_modules\\@terrastruct\\d2\\dist\\browser.js"],
      }),
    ];
    expect(buildPrecacheManifest(windowsBundle).optional).toContain(
      "/assets/d2.js",
    );
  });

  it("tolerates an empty bundle", () => {
    expect(buildPrecacheManifest([], [])).toEqual({ core: [], optional: [] });
  });
});

describe("unmatchedOptionalMarkers", () => {
  it("reports nothing when every marker is present in the bundle", () => {
    expect(unmatchedOptionalMarkers(realisticBundle)).toEqual([]);
  });

  it("reports a wrapper whose source file was moved or renamed", () => {
    // The wrapper markers are source paths. If a diagram view is relocated the
    // manifest would silently lose it, so the build plugin warns on this.
    const renamed = realisticBundle.map((e) =>
      e.fileName === "assets/mermaid-view-D4yDZMas.js"
        ? { ...e, moduleIds: ["/repo/apps/client/src/features/editor/components/diagrams/mermaid.tsx"] }
        : e,
    );
    expect(unmatchedOptionalMarkers(renamed)).toEqual([
      "/src/features/editor/components/code-block/mermaid-view",
    ]);
  });

  it("reports every marker for an empty bundle", () => {
    expect(unmatchedOptionalMarkers([])).toEqual(OPTIONAL_MODULE_MARKERS);
  });
});
