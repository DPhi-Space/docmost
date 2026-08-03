import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import * as path from "path";
import { excalidrawAssetsPlugin } from "./src/features/offline/build/excalidraw-assets-plugin";
import { serviceWorkerPlugin } from "./src/features/offline/build/service-worker-plugin";

const envPath = path.resolve(process.cwd(), "..", "..");

/**
 * A value that changes with every build, for the offline query-cache buster
 * (`features/offline/persistence.ts`). The package version cannot serve: this
 * fork pins the upstream base, so it reads 0.95.0 on every fork build.
 *
 * Docker builds have no `.git` in their context (see `.dockerignore`), so CI
 * passes the commit SHA in as the `BUILD_ID` build arg; local `vite build`
 * falls back to asking git directly, and "dev" is the last resort.
 */
function resolveBuildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    return (
      execSync("git rev-parse --short HEAD", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || "dev"
    );
  } catch {
    return "dev";
  }
}

export default defineConfig(({ mode }) => {
  const {
    APP_URL,
    FILE_UPLOAD_SIZE_LIMIT,
    FILE_IMPORT_SIZE_LIMIT,
    DRAWIO_URL,
    CLOUD,
    SUBDOMAIN_HOST,
    COLLAB_URL,
    BILLING_TRIAL_DAYS,
    POSTHOG_HOST,
    POSTHOG_KEY,
  } = loadEnv(mode, envPath, "");

  return {
    define: {
      "process.env": {
        APP_URL,
        FILE_UPLOAD_SIZE_LIMIT,
        FILE_IMPORT_SIZE_LIMIT,
        DRAWIO_URL,
        CLOUD,
        SUBDOMAIN_HOST,
        COLLAB_URL,
        BILLING_TRIAL_DAYS,
        POSTHOG_HOST,
        POSTHOG_KEY,
      },
      APP_VERSION: JSON.stringify(process.env.npm_package_version),
      APP_BUILD_ID: JSON.stringify(resolveBuildId()),
    },
    plugins: [
      react(),
      // Copies @excalidraw/excalidraw's fonts into dist/excalidraw/** so the
      // modal works offline; must precede the SW plugin so its generateBundle
      // classification sees them. See features/offline/build.
      excalidrawAssetsPlugin(),
      // Emits dist/sw.js (offline app shell). See features/offline/build.
      serviceWorkerPlugin({ version: process.env.npm_package_version }),
    ],
    optimizeDeps: {
      // @terrastruct/d2's browser build inlines its multi-MB WASM binary
      // (base64) and spins up its Web Worker from a runtime Blob, so it is
      // fully self-contained and needs no external .wasm fetch. Excluding it
      // from dep pre-bundling keeps this heavy, lazily-imported module out of
      // the pre-bundle step (it is loaded on demand via React.lazy).
      exclude: ["@terrastruct/d2"],
    },
    build: {
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              {
                name: "vendor-mantine",
                test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: APP_URL,
          changeOrigin: false,
        },
        "/socket.io": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
        "/collab": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
  };
});
