/**
 * Docmost service worker (phase 1a: app shell only).
 *
 * Built separately from the app bundle by `../build/service-worker-plugin.ts`
 * and emitted as `dist/sw.js` (classic script, IIFE). All decision logic lives
 * in the pure modules imported below so it can be unit tested; this file is the
 * event plumbing.
 *
 * Scope of this worker: assets, locales, `GET /api/files/*` and navigations.
 * It never intercepts non-GET requests, never intercepts `/collab` or
 * `/socket.io`, and never precaches or serves a build-time `index.html`.
 */

import {
  CACHED_AT_HEADER,
  FILE_MAX_AGE_MS,
  FILE_TIMEOUT_MS,
  MAX_ASSET_ENTRIES,
  MAX_FILE_ENTRIES,
  MAX_LOCALE_ENTRIES,
  NAVIGATION_TIMEOUT_MS,
  SHELL_CACHE_KEY,
  cacheNames,
  cachesToDelete,
  isCacheableAsset,
  isCacheableResponse,
  isExpired,
  keysToEvict,
} from "./cache-policy";
import { RouteKind, resolveRoute } from "./routes";
import {
  outboxCandidateIdFromPath,
  outboxResponseHeaders,
} from "./outbox-serving";
import { readUploadRecord } from "../upload-outbox";
import type { PrecacheManifest } from "../build/precache-manifest";

/** Injected at build time by the service-worker plugin. */
declare const __SW_PRECACHE_MANIFEST__: PrecacheManifest;
declare const __SW_BUILD_ID__: string;

/* -------------------------------------------------------------------------- */
/* Minimal service-worker ambient types                                       */
/* The client tsconfig uses lib DOM, which cannot be combined with lib         */
/* WebWorker in the same program, so the handful of globals we need are        */
/* declared locally instead of pulling in a conflicting lib.                   */
/* -------------------------------------------------------------------------- */

interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface SwMessageEvent extends SwExtendableEvent {
  readonly data: unknown;
}

interface SwGlobalScope {
  readonly location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(
    type: "install" | "activate",
    listener: (event: SwExtendableEvent) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: SwFetchEvent) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: SwMessageEvent) => void,
  ): void;
}

const sw = self as unknown as SwGlobalScope;

const MANIFEST: PrecacheManifest = __SW_PRECACHE_MANIFEST__;
const BUILD_ID: string = __SW_BUILD_ID__;
const NAMES = cacheNames(BUILD_ID);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function fetchWithTimeout(
  request: Request,
  timeoutMs: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(request),
      new Promise<Response>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("sw: network timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Stores a copy stamped with the time it was cached, without buffering it. */
async function putStamped(
  cache: Cache,
  key: RequestInfo,
  response: Response,
): Promise<void> {
  const copy = response.clone();
  const headers = new Headers(copy.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  await cache.put(
    key,
    new Response(copy.body, {
      status: copy.status,
      statusText: copy.statusText,
      headers,
    }),
  );
}

async function trim(cache: Cache, max: number): Promise<void> {
  const keys = await cache.keys();
  for (const key of keysToEvict(keys, max)) {
    await cache.delete(key);
  }
}

function offlineFallbackResponse(): Response {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><title>Offline</title>" +
      "<body style=\"font-family:system-ui;padding:2rem\">" +
      "<h1>You are offline</h1>" +
      "<p>This page has not been opened on this device yet, so there is nothing cached to show. " +
      "Reconnect and try again.</p>",
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

/* -------------------------------------------------------------------------- */
/* install / activate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Required. A failure here fails install, and the worker never activates.
 *
 * The default HTTP cache mode is used deliberately (rather than
 * `cache: "reload"`): every precached URL is either content-hashed or served
 * with `max-age=0` + ETag by the static server, so the browser cache is always
 * safe here — and forcing a reload would re-download the ~4.6 MB shell that the
 * page just finished loading.
 */
async function precacheCore(): Promise<void> {
  const cache = await caches.open(NAMES.precache);
  await cache.addAll(MANIFEST.core);
}

/**
 * Best effort, and deliberately never awaited by `activate`: functional events
 * are not dispatched to a worker until activation completes, so pulling ~10 MB
 * of diagram renderers inside the activate handler would stall every fetch. It
 * is kicked off from the first handled fetch instead, where `waitUntil` keeps
 * the worker alive without blocking anything.
 */
const WARM_FAILURE_LIMIT = 3;

/** @returns false if it gave up early (almost always: the device is offline). */
async function warmOptional(): Promise<boolean> {
  const cache = await caches.open(NAMES.precache);
  let consecutiveFailures = 0;

  for (const url of MANIFEST.optional) {
    try {
      if (await cache.match(url)) continue;
      const response = await fetch(url);
      if (isCacheableAsset(response)) {
        await cache.put(url, response);
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
    } catch {
      // Offline, quota exceeded, or the asset moved: the runtime CacheFirst
      // route will pick it up the next time it is genuinely needed.
      consecutiveFailures += 1;
    }

    if (consecutiveFailures >= WARM_FAILURE_LIMIT) return false;
  }

  return true;
}

let optionalWarming: Promise<void> | null = null;

function ensureOptionalWarmed(): Promise<void> {
  if (!optionalWarming) {
    optionalWarming = warmOptional()
      .catch(() => false)
      .then((completed) => {
        // Do not memoize a give-up: retry on the next request instead of
        // leaving the diagram renderers permanently uncached.
        if (!completed) optionalWarming = null;
      });
  }
  return optionalWarming;
}

async function pruneCaches(): Promise<void> {
  const existing = await caches.keys();
  await Promise.all(
    cachesToDelete(existing, NAMES).map((name) => caches.delete(name)),
  );

  // Age-prune the file cache; size bounds are enforced on write.
  const files = await caches.open(NAMES.files);
  const now = Date.now();
  for (const key of await files.keys()) {
    const cached = await files.match(key);
    if (
      cached &&
      isExpired(cached.headers.get(CACHED_AT_HEADER), now, FILE_MAX_AGE_MS)
    ) {
      await files.delete(key);
    }
  }
}

sw.addEventListener("install", (event) => {
  // No skipWaiting(): an updated worker waits until the user accepts the
  // in-app prompt, so an editor tab is never reloaded out from under someone.
  event.waitUntil(precacheCore());
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await pruneCaches();
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event) => {
  if (
    typeof event.data === "object" &&
    event.data !== null &&
    (event.data as { type?: unknown }).type === "SKIP_WAITING"
  ) {
    event.waitUntil(sw.skipWaiting());
  }
});

/* -------------------------------------------------------------------------- */
/* Strategies                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * NetworkFirst with a short timeout, falling back to the last HTML the server
 * actually served. The build-time `index.html` is never used: the server
 * injects `window.CONFIG` into the served document at boot, so only a document
 * we received over the wire is safe to replay.
 */
async function handleNavigation(request: Request): Promise<Response> {
  const cache = await caches.open(NAMES.shell);

  const network = fetch(request)
    .then(async (response) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (
        isCacheableResponse(response) &&
        !response.redirected &&
        contentType.includes("text/html")
      ) {
        await putStamped(cache, SHELL_CACHE_KEY, response);
      }
      return response;
    })
    .catch(() => undefined);

  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), NAVIGATION_TIMEOUT_MS),
  );

  const fast = await Promise.race([network, timeout]);
  if (fast) return fast;

  // Either slow or failed. Prefer the cached shell so the app boots now; the
  // in-flight request above still refreshes the cache when it lands.
  const cached = await cache.match(SHELL_CACHE_KEY);
  if (cached) return cached;

  const settled = await network;
  return settled ?? offlineFallbackResponse();
}

/**
 * Keeps the worker alive for a background cache write without holding up the
 * response it was cloned from (`event.waitUntil`). `cache.put` consumes its
 * body as the download arrives, so awaiting it on the response path delays
 * first byte by the full download time — a large image would render
 * all-at-once at the end instead of progressively.
 */
type ExtendLifetime = (work: Promise<unknown>) => void;

/**
 * CacheFirst. Every URL routed here is content-hashed (or a versioned shell
 * file), so a hit is by definition current. `isCacheableAsset` rather than
 * `isCacheableResponse`: the SPA catch-all answers 200 HTML for a chunk a
 * newer deploy has deleted, and this cache is treated as immutable.
 */
async function handleAsset(
  request: Request,
  extendLifetime: ExtendLifetime,
): Promise<Response> {
  const precache = await caches.open(NAMES.precache);
  const precached = await precache.match(request, { ignoreSearch: true });
  if (precached) return precached;

  const runtime = await caches.open(NAMES.assets);
  const cached = await runtime.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheableAsset(response)) {
    const copy = response.clone();
    extendLifetime(
      (async () => {
        await runtime.put(request, copy);
        await trim(runtime, MAX_ASSET_ENTRIES);
      })(),
    );
  }
  return response;
}

/** StaleWhileRevalidate: i18next re-fetches these on every boot. */
async function handleLocale(request: Request): Promise<Response> {
  const cache = await caches.open(NAMES.locales);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (isCacheableAsset(response)) {
        await cache.put(request, response.clone());
        await trim(cache, MAX_LOCALE_ENTRIES);
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    return cached;
  }
  return (await network) ?? Response.error();
}

/**
 * NetworkFirst so freshness intent is honoured (the Excalidraw scene fetch uses
 * `cache: "no-store"`), with a bounded offline fallback so previously viewed
 * images and attachments still render.
 */
async function handleApiFile(
  request: Request,
  extendLifetime: ExtendLifetime,
): Promise<Response> {
  // Upload outbox first (phase 4): a queued upload's node points at a URL the
  // server does not know yet — or, for a queued Excalidraw overwrite, one the
  // server would answer with the *stale previous version*. The outbox blob is
  // the truth for these ids until the replay lands and the record is deleted;
  // see `outbox-serving.ts`. Everything else misses this lookup and proceeds
  // exactly as before. Never cached: the record's deletion must be the end of
  // the URL.
  try {
    const candidateId = outboxCandidateIdFromPath(
      new URL(request.url, sw.location.origin).pathname,
    );
    if (candidateId) {
      const record = await readUploadRecord(candidateId);
      if (record) {
        return new Response(record.blob, {
          status: 200,
          headers: outboxResponseHeaders(record),
        });
      }
    }
  } catch {
    // An unreadable outbox must degrade to normal file handling, not break
    // every attachment fetch.
  }

  const cache = await caches.open(NAMES.files);
  try {
    const response = await fetchWithTimeout(request, FILE_TIMEOUT_MS);
    if (isCacheableResponse(response)) {
      // `putStamped` clones synchronously, before the caller starts consuming
      // the body it was handed.
      const stamped = putStamped(cache, request, response);
      extendLifetime(
        (async () => {
          await stamped;
          await trim(cache, MAX_FILE_ENTRIES);
        })(),
      );
    }
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    throw new Error("sw: file unavailable offline");
  }
}

const HANDLERS: Record<
  Exclude<RouteKind, "passthrough">,
  (request: Request, extendLifetime: ExtendLifetime) => Promise<Response>
> = {
  navigation: handleNavigation,
  asset: handleAsset,
  locale: handleLocale,
  "api-file": handleApiFile,
};

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  const kind = resolveRoute(
    {
      method: request.method,
      url: request.url,
      mode: request.mode,
      destination: request.destination,
      hasRangeHeader: request.headers.has("range"),
    },
    sw.location.origin,
  );

  if (kind === "passthrough") return;

  // First handled request of this worker's life: start the best-effort warm-up.
  if (optionalWarming === null) event.waitUntil(ensureOptionalWarmed());

  event.respondWith(HANDLERS[kind](request, (work) => event.waitUntil(work)));
});
