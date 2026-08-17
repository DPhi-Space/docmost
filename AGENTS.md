# Fork maintenance guide (Sawii00/docmost)

This repo is a **fork** of [`docmost/docmost`](https://github.com/docmost/docmost) with a
small stack of features added on top of a **pinned upstream release tag**. Read this before
touching the git base, the lockfile, CI, or the collaboration/editor code.

## ⚠️ The one rule: base on release TAGS, never upstream `main`

The fork's `main` = an upstream **release tag** (currently `v0.95.0`) + our feature commits,
rebased on top. **Do not rebase onto `upstream/main`.**

Why: unreleased upstream `main` shipped a client-side collaboration **data-loss regression** —
pages wipe their content to empty on navigation/reload (the client overwrites good server
content with an empty Yjs doc). It came in with the Hocuspocus **v4 collab upgrade**
(`upstream a55057db`, PR docmost#2351) and the shared-socket refcount it introduced
(`collab-socket.ts`). Tracked upstream as **docmost#2353**; the accepted fix there is
"pin to release v0.95.0." We did exactly that via rebase. If you move the base to a commit
that reintroduces `a55057db` / `collab-socket.ts` before upstream fixes it, the data loss
returns. Verify with the reproduction below after any base change.

## Our feature commits (the fork's delta)

On top of the `v0.95.0` base:

- `feat: custom slugs for shared public pages (#4)` — public-share routing + slug migration
- `feat: D2 diagram rendering (#5)` — client-only, `d2` code-block language (schema-neutral)
- `local docker compose` — `docker-compose.local.yml` for local build/run
- `feat: enable API keys / REST API (#6)` — native (non-EE) api-key backend
- `feat: unlock natively-implemented EE feature flags (#8)` — flips license flags whose
  enforcement already ships natively (see `license-check.service.ts` `FORK_ENABLED_FEATURES`)
- `fix: D2 diagram rendering — serialize shared instance + readable compile errors (#7)`
- `ci: publish fork image to GHCR` — `.github/workflows/fork-image.yml`
- `feat: native read-only MCP server (#10)` — native (non-EE) space-scoped MCP backend
  (`core/mcp`) served at top-level `/mcp`, authenticated with a workspace API key (reuses
  `JwtAuthGuard`). Read-only tools only; every space-touching tool enforces space membership via
  `SpaceAbilityFactory` before calling the backing service. Unlocks `Feature.MCP` in
  `FORK_ENABLED_FEATURES`. Does not touch the collaboration/persistence path.
- `feat: MCP page writes (#15)` — adds `create_page` / `update_page` / `delete_page` to the same
  module (see **MCP write surface** below). Also does not touch collaboration/persistence.
- `feat(offline): service worker + PWA app shell (#17)`, `persist React Query cache (#18)`,
  `allow editing offline on previously-synced pages (#19)` and `background sync of offline edits
  on reconnect (#20)` — see **Offline/PWA** below. #17/#18/#20 touch nothing on the
  collaboration path; **#19 is the fork's one deliberate exception**, a 24-line patch to
  `page-editor.tsx` that must be re-implemented by hand if the base ever moves past upstream's
  collab rewrite. #20 adds *no further* lines to that patch.
- `fix(offline): detect offline by reachability, not navigator.onLine` — the whole of #18–#20
  turned on `navigator.onLine`, which reports `true` with no network at all whenever a VPN
  interface is up, so offline editing did not work on a real deployment. See **Detecting offline**
  below. Still zero `apps/server/` changes and *no further* lines in `page-editor.tsx`.
- `feat(offline): attachment upload outbox (#21)` — Excalidraw saves and pasted/dropped media
  while the server is unreachable, replayed through the #20 manager; plus self-hosted Excalidraw
  fonts and `navigator.storage.persist()`. See **Attachment upload outbox** below. Zero
  `apps/server/` changes, zero further lines in `page-editor.tsx`; the client call-site delta is
  three files (both Excalidraw components and the paste/drop handler), each importing exactly one
  `features/offline` module.
- `spike: vim keybindings (#26)` — client-only modal editing in the page editor, off by default
  behind a user preference (see **Vim keybindings** below). Server delta is one DTO field and one
  `updatePreference` branch.
- `feat: native personal spaces` — the two endpoints the shipped client already calls
  (`core/personal-space`), letting a MEMBER own exactly one space (see **Personal spaces** below).
  Unlocks `Feature.PERSONAL_SPACES` in `FORK_ENABLED_FEATURES`. No client changes, no schema
  changes, no permission-model changes.
- `fix(diagrams): report save failures and repair dangling attachment ids` — see **Dangling
  diagram attachments** below. Client-only; the upstream-file delta is `drawio-menu.tsx` and
  `excalidraw-menu.tsx`, plus one new shared module and its test.
- other commits not mentioned here

With the single, documented exception of #19's 24-line gate patch, none of these touch the
collaboration/persistence/page-load path — that's what keeps upstream adoption low-conflict.

## Dangling diagram attachments (drawio + Excalidraw)

A diagram node stores a *pointer* (`attachmentId` + `src`), not the drawing, and **both node types
overwrite that attachment in place on save** — which is what makes a dangling pointer fatal for
them and merely cosmetic for images and other read-only attachments (those just render broken).
`ATTACHMENT_NODE_TYPES` covers both, so everything below applies to drawio and Excalidraw alike.
Two upstream paths leave that pointer aimed at nothing, and upstream reports neither:

- **Copying a page to another space** mints a new attachment id for every diagram, rewrites the
  node to it, then copies the files in a best-effort loop whose per-attachment failures are only
  written to the server log (`page.service.ts`, `//TODO: best to handle this in a queue`); it also
  silently **skips** any attachment whose row `pageId` differs from the source page. Either way
  the copy points at an id that was never created ⇒ the overwrite answers **404 `Existing
  attachment to overwrite not found`**.
- **Copy-pasting a diagram node between pages** leaves the node referencing an attachment owned by
  the other page ⇒ **400 `File attachment does not match`**.

Note the storage drivers' `copy()` is a **silent no-op when the source is missing**
(`if (await this.exists(from))` with no else), so a third shape exists — row present, bytes absent.
That one reads 404 but saves fine, and re-saving repairs it on its own.

Reported as: *"I get this when trying to update a drawio diagram"*, with only a bare 404 in the
console, because `saveData(...).catch(() => {})` discarded the error at both call sites — the modal
just sat there and the 60 s autosave retried in silence forever. Excalidraw had the identical
disease with even less feedback (`handleSaveAndExit`'s `catch {}` kept the modal open and said
nothing); it is immune only on the **load** side, which #21 already fixed. Its save path does not
accidentally cover it either: `classifyUploadFailure` maps 404 to `no-access` and
`shouldQueueAfterFailure` rethrows anything that is not a transport failure — correct, but it
means a permanently unsaveable diagram.

Three changes, all in the client:

1. **A failed save is reported and keeps the modal open** (`close()` only on success), so the
   drawing is never discarded. Autosave announces the first failure of a session and then stays
   quiet; an explicit save always reports.
2. **A dangling pointer repairs itself**: `isMissingOverwriteTarget`
   (`features/attachments/attachment-repair.ts` — its own module, shared by both menus and
   testable without mounting an embed) matches those two server messages *narrowly* and re-uploads
   as a **new** attachment, re-pointing the node. Nothing is destroyed, the repair is idempotent,
   and every other refusal — size limit, `Error processing file upload.`, the fork's page lock,
   any transport failure — still fails loudly instead of quietly forking a second attachment.
   For Excalidraw the repair lives in `saveExcalidrawOrQueue`'s online branch, beside the two
   outbox repairs it already performs, and is checked **before** the queue fallback while
   remaining inert for a transport failure (no `response` ⇒ no repair ⇒ the save queues under its
   existing id, pinned by test). A superseded queued record is deleted after a repair: its id
   names an attachment that does not exist, so replaying it could only 404 forever.
3. **A failed scene load refuses to open the modal** (drawio only — Excalidraw got this in #21).
   `fetch`
   rejects only on transport failure, so a 404 resolved and `blob()` turned the JSON error body
   into a valid-looking "scene"; the response status is now checked. Opening from `finally` handed
   the user an empty canvas over a real diagram, whose next save or 60 s autosave would overwrite
   it with a blank one. The `FileReader` is awaited too — `open()` used to run first, mounting the
   embed with the *previous* diagram's XML.

Not fixed here, deliberately: the server-side copy loop still fails silently, and existing dangling
pointers stay dangling until someone saves that diagram. Fixing the loop means editing upstream
server code this fork otherwise leaves alone.

## MCP write surface (`core/mcp`, issue #15)

The MCP server exposes nine read tools plus three write tools: `create_page`, `update_page`
(append / prepend / replace, **append is the default**) and `delete_page` (trash only —
permanent deletion is never exposed over MCP). They reuse `PageService.create/update/removePage`;
no new content handling exists in the MCP module.

**Two switches, not one.** `settings.ai.mcp` turns the endpoint on; `settings.ai.mcpWrite`
(new, defaults to **off**, so existing workspaces stay read-only after upgrade with no
migration) turns the write tools on. Both live under the same settings namespace, are written
by `WorkspaceService.updateWorkspace` via `updateAiSettings`, and are licence-gated on the same
`Feature.MCP`. The client switch pair is in `apps/client/src/ee/ai/components/mcp-settings.tsx`.

**Where enforcement lives.** Both layers are inside `McpService` — deliberately *not* in
`McpController` — because the service's public tool methods are the only tested seam
(`mcp.service.spec.ts` constructs the service directly with positional doubles):
1. `buildServer` registers the three write tools only when the flag is on, so a read-only
   workspace's `tools/list` contains only the nine read tools.
2. Each write method re-checks the flag (`requireWriteEnabled`), which is what makes the switch
   a real kill switch for already-open connections.

**Authorization** is one delegation to `PageAccessService.validateCanEdit`, which already folds
space membership, page-level restrictions **and the fork's page lock** into one answer. Do not
add a separate lock check — a second one would be a second place for lock semantics to drift.
Creation uses the web app's split gate (parent page ⇒ edit on the parent; space root ⇒ space-level
`Create`/`Page`). Cross-workspace targets report *not found*, never *forbidden*.

**Redis requirement.** `PageService.updatePageContent` routes content through
`CollaborationGateway.handleYjsEvent`, which is a **silent no-op** when `COLLAB_DISABLE_REDIS=true`
(the promise resolves, nothing is written). `McpService.updatePage` therefore refuses with a
`ServiceUnavailableException` before attempting a *content* update. Title/icon-only updates and
`create_page` are unaffected — creation writes its ydoc directly in `PageService.create`.
**The REST API has the identical silent no-op and is left as-is**: fixing it at the gateway would
mean editing collaboration code, which is the one area this fork keeps untouched.

## Offline/PWA (`apps/client/src/features/offline`, issues #17–#20)

Phase 1a of the offline plan (tracking issue #22): a service worker that makes the **app shell**
(JS/CSS/fonts/icons/locales) load with no network. Data persistence is #18, offline editing is
#19, background sync is #20 and the attachment upload outbox is #21, all below. Nothing in
**this** sub-section touches `apps/server/` or the collaboration/persistence path — the whole
feature makes zero server changes, and only #19 patches a collaboration-adjacent client file.

**Hand-rolled, not `vite-plugin-pwa`.** `vite-plugin-pwa` 1.3.0 does install and build fine on
this base (its peer range includes `vite ^8`, and `injectManifest` works under rolldown — both
verified). It was still not adopted, for three reasons: workbox precaching is **all-or-nothing**
over a filename glob, which here means a ~20 MB manifest dominated by the 8 MB D2 WASM chunk, so
one failed request leaves the worker permanently un-activated and the app with *no* offline
support; the glob sees only content-hashed file names, whereas "the mermaid and D2 chunks" can
only be identified reliably from the **module graph**; and it costs +55 packages / +712 lockfile
lines in a repo where the lockfile is load-bearing. The replacement adds **zero dependencies**.

- `build/precache-manifest.ts` — pure classification of the finished bundle into `core`
  (required, fetched during `install`; measured 34 entries / 4.60 MB: entry + its static import
  closure + their CSS + woff2 fonts + icons + `manifest.json`) and `optional` (best effort,
  warmed after activation; measured 56 entries / 10.49 MB: mermaid + D2). Splitting the two is
  the whole point: a flaky network must not be able to prevent activation. Verified in a browser
  — the worker activates with 34 entries cached, then warms to 90.

  Selection is by **module id**, never by file name, because rolldown emits opaque hashed chunks
  (`chunk-Z5NKEFVG-*.js`, `browser-D2tXIcaq.js`). `OPTIONAL_MODULE_MARKERS` names the two
  libraries **and our own lazy wrapper chunks** (`code-block/mermaid-view`, `code-block/d2-view`).
  The wrappers are not optional trivia: they are what the app actually imports, they contain no
  library module of their own, and caching the library without them fails offline with
  `Failed to fetch dynamically imported module` — observed in a real offline browser run before
  the markers were added. Do **not** replace this with a reverse walk of the import graph;
  mermaid shares vendor chunks with Excalidraw, so walking backwards sweeps in unrelated lazy
  features (measured: 56 entries → 122, dragging in Excalidraw and all of its locale chunks).
  Because the wrapper markers are source paths, moving a diagram view would silently drop it —
  `unmatchedOptionalMarkers()` makes the build **warn** when a marker matches nothing.
- `build/service-worker-plugin.ts` — the Vite plugin. Classifies in `generateBundle`, then in
  `closeBundle` runs a second isolated Vite build that compiles `sw/sw.ts` into a classic IIFE.
- `sw/routes.ts`, `sw/cache-policy.ts` — pure decision logic, unit tested (a service worker
  cannot be exercised in jsdom, so the decisions live outside the event handlers).
- `register.ts` / `update-notification.tsx` — registration (production builds only; the dev
  server has no `/sw.js`) and the update prompt.

**Two constraints you must not break:**

1. **`sw.js` must exist at the dist ROOT before the server boots.**
   `apps/server/src/integrations/static/static.module.ts` registers `@fastify/static` with
   `wildcard: false`, which enumerates `client/dist` **once** at registration and creates one
   route per file. A file that appears later falls through to the SPA catch-all, which answers
   `text/html` — and the browser rejects a worker script on MIME type. The Docker build already
   bakes `dist` before boot, so this holds; it breaks if you ever generate `sw.js` at runtime or
   serve `client/dist` from a volume populated after startup.
2. **No HTML is ever precached or used as a navigate fallback.** The same module rewrites
   `client/dist/index.html` at boot to inject `<script>window.CONFIG={…}</script>` (and stores
   the pristine copy as `index-template.html` **in the same directory**). A build-time HTML file
   therefore has no `COLLAB_URL`/`CLOUD`/upload limits and breaks the app. `isPrecachableFile`
   rejects every `.html`, and navigations are **NetworkFirst (3 s timeout)** falling back to a
   single runtime-cached copy of the last HTML the server actually served.
   The runtime asset/locale caches enforce the same rule from the other side
   (`isCacheableAsset`, issue #36): the SPA catch-all answers **200 `text/html`** for any
   unknown path, so in the deploy race — an old tab requests a hashed chunk the new deploy
   deleted — a status-only check stored the app shell in the CacheFirst `assets-v1` cache,
   where it stuck until logout. Anything HTML-shaped is refused there; `GET /api/files/*` is
   deliberately exempt, since no `/api` path reaches the catch-all and an uploaded `.html`
   attachment is legitimate HTML. Runtime cache writes also happen off the response path
   (`event.waitUntil`, issue #37): `cache.put` consumes the body, so awaiting it before
   returning delayed first byte by the full download.

**The API is classified before navigations** (`sw/routes.ts`). The app downloads attachments
with `window.open(downloadUrl)` — a *top-level navigation* to `/api/files/...`. Classified as a
navigation it went through NetworkFirst, so a file whose first byte outlasted the 3 s timeout
was answered with the **cached application shell instead of the file**, while fully online, and
the download simply produced an HTML page. No path under `/api/` is ever an SPA route, so
deciding on the path first removes the class; page navigations still reach the shell fallback
that offline boot depends on, and that ordering is pinned by tests.

Other invariants: non-GET requests and `Range` requests are never intercepted; `/collab` and
`/socket.io` are never routed (they are WebSocket upgrades, but the exclusion is explicit and
tested); everything under `/api` except `GET /api/files/*` passes through untouched; and the
worker never calls `skipWaiting()` on its own — a new build waits until the user accepts the
Mantine prompt, so an editor tab is never reloaded mid-session.

### Persisted REST cache (issue #18)

Phase 1b makes the shell *useful* offline by dehydrating the React Query cache into IndexedDB.
`main.tsx` swaps `QueryClientProvider` for `PersistQueryClientProvider` around the **same**
exported `queryClient` instance — a dozen modules import that binding directly, so it must be
wrapped, never replaced. Three new dependencies (`@tanstack/react-query-persist-client`,
`@tanstack/query-async-storage-persister`, `idb-keyval`), the first this feature has needed.

- **`persistence-policy.ts` holds the whole policy, and the query filter is an allowlist, never
  a denylist.** Only queries whose `queryKey[0]` is on the list reach disk. New query keys appear
  constantly in this app; a denylist would silently start persisting each one. `collab-token` is
  a live JWT and must never appear on the list — that is asserted by test, as is every other
  excluded family (search keys have unbounded key cardinality, `notifications` is registered
  `gcTime: 0`).
- **React Query's `onlineManager` must be driven by us, not by its own listener**
  (`online-state.ts` → `installQueryOnlineManager`). It initialises to `online = true` and by
  default only ever reacts to `online` / `offline` *events*, so a tab loaded while already offline
  never learns the truth: instead of pausing fetches it runs every restored query into a network
  error. That single default is what stands between a persisted cache and a usable offline app —
  without it the app renders "Error fetching page data." on top of a perfectly good cache, *and*
  the errored cache is then written over the good one. Both were observed in a browser. It was
  originally a one-shot seed from `navigator.onLine`; it is now a subscription to the reachability
  verdict, because on a VPN the events never fire at all (see **Detecting offline** below).
- **A snapshot is only written if it contains `currentUser`** (`isSnapshotWorthPersisting`).
  Persistence replaces the store wholesale and only successful queries are dehydrated, so a
  session that cannot reach the server would otherwise erase a good offline cache. Measured: one
  reload against an unreachable server left three page entries and no user.
- **Corrupt infinite-query data is refused on the way to disk *and* dropped on the way back**
  (`isCorruptInfiniteData` / `sanitizeRestoredClient`), because React Query validates only the
  *top-level* fetch result against `undefined` — for an infinite query that is the
  `{pages, pageParams}` wrapper, so a queryFn that resolves `undefined`/`null` for one page
  commits it silently and still reports success. A page is corrupt unless it is an object
  carrying an `items` array (an `IPagination`): a proxy's 200 **JSON** error body
  (`{"message":…}`) is object-shaped, passes the guarded `getNextPageParam`, and crash-loops in
  the component consumers (`flatMap((p) => p.items)`) exactly like the null case — so the
  predicate checks the pagination shape, not mere objectness. Observed in production: an office reverse proxy
  answered `POST /pages/recent` with 200 + HTML, the envelope unwrap (`req.data`) turned it into
  `undefined`, the persister froze it to `null` (JSON round trip), and every later boot crashed
  the home route in `getNextPageParam` ("can't access property 'meta', e is null" — blackscreen)
  before the post-restore invalidation could heal it. Private windows, with no persisted store,
  were immune — that asymmetry is the diagnostic tell. Three companion hardenings from the same
  incident, in decreasing order of load-bearing:
  - the **buster is now `APP_VERSION+APP_BUILD_ID`** (`features/offline/build/build-id.ts`:
    `BUILD_ID` build arg → git short SHA → build timestamp, so an arg-less Docker build still
    rotates), because the fork's package version is 0.95.0 on *every* build and a version-only
    buster never discarded anything. **Stated cost:** every deploy now discards the whole
    persisted query cache — one refetch cycle per device per deploy. Offline *edits* are
    untouched (`page.*` ydocs, dirty registry and outbox are separate databases), but a device
    that is offline across a deploy boots without its read cache; acceptable against a
    poisoned store surviving forever, and the same trade `clearOfflineData()` already makes.
  - the **api client rejects 2xx HTML answers** on non-exempt `/api` endpoints
    (`lib/api-response-guard.ts`), turning a proxy interposition window into ordinary request
    errors instead of silently-absorbed `undefined`s. The rejection is a plain `Error` (no
    `error.response`), so callers reading `error.response?.data?.message` show their generic
    message and no re-auth is triggered — the app cannot distinguish which proxy answered.
  - the persisted infinite families' `getNextPageParam` is null-tolerant (`lastPage?.meta?...`)
    and `useCommentsQuery`'s own page aggregation skips null pages. **Scope, stated honestly:
    this is defence in depth for the query-observer math, not a render guarantee** — component
    render paths (`recent-changes.tsx`, `favorites-pages.tsx`, the tree) still dereference
    `page.items` and would crash on a poisoned entry that reached them; the sanitizer and the
    HTML rejection are what keep such an entry from existing. Pinned by
    `poisoned-cache-render.hook.test.tsx`, which mounts the real hooks over the real poison
    shape — the guards are one-character edits in upstream files, which is exactly what a
    "take theirs" rebase resolution reverts silently.
  Upstream-file delta of this fix, for the rebase tally: `page-query.ts` (3 guarded
  callbacks), `comment-query.ts` (guarded callback + null-skipping aggregation),
  `favorite-query.ts` (guarded callback), `api-client.ts` (HTML rejection), `vite.config.ts`
  (define + wiring), `Dockerfile` / `fork-image.yml` / `docker-compose.local.yml` (`BUILD_ID`
  arg). Non-persisted infinite queries (`pages-created-by-user`, `spaceMembers`, …) keep their
  upstream unguarded callbacks on purpose — they cannot be poisoned by a restore.
- **`UserProvider` renders whenever cached user data exists.** Previously it returned an empty
  fragment while `/users/me` was loading or errored, which is why phase 1a booted to a white
  screen. It now blanks only while the cache is still restoring or when there is no user data at
  all. Without this the persisted cache is invisible.
- **Restore invalidates active queries** (`onQueryCacheRestored`). The app's defaults are
  `refetchOnMount: false` + `staleTime: 5m`, which was harmless when a reload started from an
  empty cache and would otherwise pin a reloaded tab to yesterday's sidebar forever. The delay
  before invalidating is load-bearing: the callback fires before React has re-rendered, so no
  observer is active yet and `refetchType: "active"` would match nothing.
- **The two session exits are NOT the same call, and must not be re-unified.** `handleLogout`
  runs `clearOfflineData()`; the 401 handler's `redirectToLogin` runs
  `clearOfflineDataOnSessionExpiry()` (`session-expiry.ts`). ⚠️ **This is a deliberate,
  documented narrowing of #18's stated behaviour, justified by phases 2/3 changing what is at
  stake since #18 was written.** #18 specified cleanup on both exits for *privacy on a shared
  machine*, when a `page.<pageId>` database held nothing but a cached copy of content the server
  already had. Since phase 2 it can hold the **only** copy of the user's work, and since phase 3
  the dirty registry is the only index of which ones do — so the original behaviour meant a
  token expiring after a long offline period, "log out all devices", an admin revoking a
  session, or a server restart with a rotated `APP_SECRET` silently and permanently destroyed
  unsynced edits. Found by an adversarial audit and reproduced end to end.
  An explicit logout is the user saying they are done with this device: it still erases
  everything, unconditionally. A 401 is *the session expired*, not *the user left*, so it keeps
  exactly what is needed to recover the work — the `page.*` database of every page the dirty
  registry lists, the sync markers for **those pages only** (a marker without its document is
  the state the gate now refuses to trust), and the registry itself — and erases everything
  else. With nothing pending it is byte-for-byte the logout path.
  **The explicit logout's client-side exit is unstoppable** (`logout-exit.ts`, PR #42 review
  BUG 2): `handleLogout` used to `await logout()` before the cleanup, so logging out while the
  server was unreachable rejected with a transport error, ran no cleanup, never navigated, and
  wedged the app on a stuck error screen that survived reload — defeating the shared-machine
  privacy exit at exactly the moment it matters (people log out as they walk away). The server
  call is now best-effort; `clearOfflineData()` and the navigation to the login page always run.
  **The unavoidable residue, stated plainly:** an offline logout cannot invalidate the
  server-side session — the `authToken` cookie is httpOnly (script cannot delete it) and the
  revoking `POST /api/auth/logout` never reached the server — so the session survives
  server-side until it expires. Everything under the client's control (offline stores, memory,
  the tab itself) is still torn down unconditionally.
- **Preserved data must be provably owned, and the readers enforce it themselves**
  (`data-ownership.ts`). The first version of the 401 fix preserved first and settled ownership
  later, from a localStorage note that one cleanup hook consulted — and an audit reached the
  *next user's session* through it three ways: an unrecorded owner read as "same user"; the hook
  gated on the offline-editing switch, so declining the feature declined the privacy cleanup;
  and the hook consuming its notice on the first sign-in while leaving the data, so the second
  sign-in found no notice and checked nothing. Every one ended with the previous user's text on
  screen **and pushed to the server under the new user's identity**. Four rules now hold, and
  they are deliberately redundant because three failures of one hook is a diagnosis:
  0. **Every authenticated boot stamps the disk** (`use-offline-resync.ts`), strictly *after*
     reconcile has decided — stamping first would relabel data reconcile was about to identify
     as somebody else's. Before this the stamp was written only at 401 time, and two paths left
     data unstamped: `redirectToLogin` does not await the cleanup before assigning
     `window.location.href`, and a user landing straight on `/auth/login` never fires a 401 at
     all. Reconcile no longer reads a missing stamp as "yours" either: **unstamped *with records
     present* erases**, so the guarantee survives a stamp write that fails. A fresh browser has
     no records and never pays for it. The localStorage hint is re-written in the same breath,
     because reconcile's erase path drops it and a 401 later in that session would otherwise
     find no hint and destroy the new user's pending work.
  1. **Nothing is preserved without a provable owner.** No owner hint, or the IndexedDB stamp
     cannot be written ⇒ this is the logout path, work included. Losing work in a case that
     should not arise beats handing it to a stranger.
  2. **The owner lives beside the data**, under a reserved key *in the dirty-page store*, not in
     localStorage. localStorage carries only a hint, because the axios 401 handler has no async
     boundary to read IndexedDB on; it is never what a reader trusts.
  3. **Reconciliation is triggered by the presence of the data**, never by a notice, and runs
     **unconditionally on sign-in** — `useOfflineDataOwnership()` takes no `enabled` argument, so
     there is nowhere for the switch to be consulted. Mismatch *or* unreadable ⇒ erase.
  4. **The readers refuse on their own account.** `offlineDataIsOurs()` starts false; the editing
     gate and the resync manager both require it. A missed cleanup degrades to "data sits inert
     on disk" instead of "data appears in someone else's session".
  What this does **not** cover, stated plainly: `page-editor.tsx` binds `IndexeddbPersistence`
  for every page it opens, and that is collaboration code the fork does not touch — so a foreign
  document still on disk when a page is opened would merge. Rules 1 and 3 are what stop such a
  document existing; rule 4 is defence in depth for the window in between.
  The preservation is announced: a notice is written for the login page
  (`unsynced-recovery-notice.tsx`) and the resync manager pushes the edits on the next sign-in.
  The notice is an announcement only — **never a trigger for anything**, which is what leak (3)
  was.
- **Preservation follows what the user was promised.** `dirty-tracking.ts` records edits made
  while the provider is *disconnected*, but the phase-2 "your changes could not be saved to the
  server" banner appears on a *connected* session whose writes the server refuses. Those edits
  are registered too, from the same tick that raises the banner, so the preservation set matches
  the promise. And an **unreadable registry preserves everything** rather than reading as
  "nothing is pending" — that reading is precisely how the original defect destroyed work.
- **`clearOfflineData()` itself** stops persistence *first* so a throttled write cannot restore
  what it erases, then drops the dehydrated cache, every `page.*` y-indexeddb database (a
  pre-existing leak that predates this work) and the SW runtime caches. Two deliberate
  omissions:
  it **keeps the build's precache** (compiled assets only, and an activated worker never re-runs
  `install`, so deleting it would break offline boot until the next deploy); and it **does not
  `deleteDatabase` its own store**, only clears its records — idb-keyval holds the connection
  open with no `versionchange` handler, so the delete parks as `blocked` and then blocks every
  later `indexedDB.open` of that name for the life of the document.

### Offline editing (issue #19) — ⚠️ the fork's one exception to "don't touch collab code"

Phase 2 makes a previously-synced page **editable with no connection**. It is the only part of
this fork that patches a collaboration-adjacent file, and the patch is deliberately tiny.

**The standing cost, stated plainly.** `apps/client/src/features/editor/page-editor.tsx` is the
exact file upstream rewrote in the Hocuspocus v4 / `collab-socket.ts` work that produced the
data-loss regression this fork is pinned away from (docmost#2353, see the top of this file).
**If the base ever moves onto a release containing that rewrite, this patch will not apply and
must be re-implemented by hand against the new file** — do not resolve it as a merge conflict
and hope. Everything else in the feature lives in `features/offline/` and rebases cleanly.
The patch is 24 lines (`+17 −7`) and consists of exactly four things:

1. one import from `features/offline/offline-editing.ts` (a barrel that exists purely so this is
   *one* import statement to re-create);
2. `useOfflineEditGate({ pageId, providers: providersRef, isLocalSynced, connectionStatus })`;
3. one widened condition — `showStatic` may also flip false when the gate allows it, in addition
   to the existing first-`Connected`-and-synced path;
4. `onAuthenticationFailed` now asks `isCollabTokenExpired()` instead of calling
   `jwtDecode(collabQuery?.token)` (which **throws** on the undefined token an offline boot
   produces, since `collab-token` is deliberately never persisted), and reports a non-expired
   failure instead of swallowing it.

Provider creation/destruction (`providersRef`), `IndexeddbPersistence` usage, and the ydoc are
untouched. No ydoc is ever seeded from REST content.

**The invariant.** *A document that has never completed a real remote sync in this browser, and
is not actually holding content right now, is never editable.* `sync-markers.ts` writes a
per-page marker only when the **provider instance's own** `synced` is true on a `Connected`
socket. `canEditWithoutConnection()` is pure and its thirty-two-row truth table is a test.

- **The marker alone is not enough, and the code no longer pretends it is.** The marker store
  and the page's `page.<pageId>` document are two independent IndexedDB databases and can
  disagree: delete only the document and the marker survives, `isLocalSynced` goes true for the
  empty database exactly as for a populated one, and the gate opened a **live, editable, blank**
  editor above the words "changes are saved locally". Found by an adversarial audit of the
  merged phases. The predicate now also requires `hasDocContent()` (`doc-content.ts`), which
  asks the document itself via `Y.encodeStateVector` — a doc nothing has ever been written to
  encodes to a single zero byte. A *synced but empty* page still opens; "never synced" is the
  state being rejected.
- The gate reads the provider through `providersRef` **itself**, not `providersRef.current`,
  because the effect that builds the providers runs *after* the render that calls the hook — so
  a value captured during render is null on the first pass and can be stale afterwards. A
  destroyed provider still reports `synced === true`, which would mark a page the server never
  acknowledged. **An earlier version of this note justified the ref by claiming `PageEditor` is
  not remounted across navigation. That is false** — `pages/page/page.tsx:169` puts
  `key={page.id}` on the memoized editor — and the code was safe only through React's
  declaration-order effect execution across two files, an untested cross-file invariant that any
  move of the hook call or switch to `useLayoutEffect` would have broken silently. The bundle in
  `providersRef` now carries its own `pageId` and the hook refuses to act unless it matches the
  page it was asked about, which is a local, tested condition. The hook still holds *which page*
  is known synced (and which is known populated) rather than a boolean, for the same reason.
- The gate also requires that **the server is unreachable** (`reachability.ts`, see **Detecting
  offline** below). Not in the issue's predicate; added so that every behavioural difference is
  confined to sessions that cannot reach the server — an ordinary session takes the same path
  with the switch on as with it off, including the data-loss repro. This term read
  `navigator.onLine === false` until it was found to be **the reason offline editing did not work
  at all on a machine with a VPN configured**; a session that can reach the API but not the
  collaboration WebSocket (blocked upgrade, hostile proxy) still stays read-only, since the probe
  is an HTTP request.
- **Dropped writes are surfaced, never resolved by discarding.** The server marks a connection
  `readOnly` for space READERs, page-level restrictions, **the fork's page lock** and trashed
  pages (`authentication.extension.ts`), then answers each update with `SyncStatus(false)`.
  Hocuspocus 3.4.4's provider has no `false` branch in `applySyncStatusMessage` — no event, no
  error — so `unsyncedChanges` never drains and the local doc silently diverges. The provider
  *does* expose the counter as a property, a `hasUnsyncedChanges` getter and an `unsyncedChanges`
  event, but a dropped write produces **no transition**, so the event cannot detect it; only
  elapsed time distinguishes a dropped write from a slow one. `unsynced-changes.ts` therefore
  samples the counter every second and warns after 10 s of a non-draining counter on a live,
  synced connection. The warning clears only when the counter reaches zero.
- **The switch is `localStorage`, default off** (`offline-editing-settings.ts`, key
  `docmost.offline-editing`), not a server-side user preference: the fork makes no
  `apps/server/` changes here, and a setting that gates *offline* behaviour has to be readable
  on the boot where there is no network. With it off, nothing in phases 2/3 is read or written,
  neither the marker nor the dirty-page database is created, no banner renders, no background
  sync loop exists and the title editor behaves exactly as upstream — that is what makes the
  phase safe to merge. Consequence: a page must be opened online **after** the switch is turned
  on before it can be edited offline.
  One exception: the cross-account ownership check runs regardless of the switch (see the
  session-exit section above), so `docmost-offline-dirty` is created — empty, never written to —
  on every authenticated boot. A safeguard that a feature toggle can disable is not a safeguard.
  **The switch does not make the app byte-identical to upstream, only the editor.** Phases 1a
  and 1b are unconditional by design: the service worker registers and precaches, the query
  cache is dehydrated into `docmost-offline`, the update check runs every 30 minutes and the
  "Offline — showing saved content" pill appears, switch or no switch. Earlier wording here and
  in `offline-editing-settings.ts` said "byte-identical to upstream" without that qualification.
- **The page title stays offline-disabled** (tooltip: "Title editing requires a connection").
  It is not in the Yjs document — `title-editor.tsx` saves it through a debounced
  `POST /api/pages/update` with no optimistic write and no retry — so an offline title edit is
  lost in silence. A title outbox is out of scope for #19.

Known limitations, all documented rather than hidden: the switch also gates the dropped-write
warning and the title lock, so both bugs remain reachable in their pre-existing form with the
switch off; and `showStatic` latches globally rather than per page (upstream behaviour), so a
page never visited before can still show an empty live editor if it is opened *after* an
offline-editable page in the same session — opening it as the first page of an offline session
correctly stays static.

### Background sync on reconnect (issue #20)

Phase 3 removes the "next time you open that page" clause from phase 2: edits made offline are
pushed on reconnect **without the user re-opening anything**. All of it lives in
`features/offline/`; `page-editor.tsx` gains **zero further lines**, and so does every other
upstream file — the loop is hosted by `OfflineIndicator`, which `layout.tsx` already mounts.

The shape is a registry plus a serial loop: `dirty-pages.ts` (its own IndexedDB database, for
the same `NotFoundError` reason as the sync markers) records a page when the phase-2 hook sees a
local edit on a disconnected provider; `resync-manager.ts` walks it one page at a time;
`resync-page.ts` decides what happened to each; `resync-session.ts` builds the actual providers.

- **The origin filter is not optional** (`dirty-tracking.ts`). `y-indexeddb@9.0.12` replays a
  stored document with the `IndexeddbPersistence` **as the transaction origin**
  (`Y.transact(doc, …, idbPersistence, false)`), and `@hocuspocus/provider` applies server
  updates with the provider as origin. Without excluding both, merely *opening* a page offline
  would mark it dirty — and every page the user only read offline would be queued for a
  background push and, if locked, reported to them as blocked. The rule is stated as an
  exclusion, not as a match on `ySyncPluginKey`, because a missed edit is lost work while a
  spurious record costs one redundant sync.
- **`resync-session.ts` is a transcription of `page-editor.tsx:138-212`, not a design.** Same
  construction order, same `attach()`, same teardown order. Inventing a second provider
  lifecycle is precisely the risk the v0.95.0 pin exists to remove. Its one addition is
  `ydoc.destroy()` at the end, which the editor does not need (its document dies with the
  component) and a loop that opens one per page per pass does.
- **`blocked` vs `retry` is the whole judgement**, and the discriminator is whether a handshake
  was observed **on a connection that is still live and synced at the deadline** (issue #35 —
  an earlier version latched the handshake alone, so a socket that died mid-push was reported
  as "the server refused"). `provider.synced` is set when the **server sends SyncStep2**
  (`applySyncMessage`), so it becomes true even on a read-only connection; `unsyncedChanges` is
  seeded to exactly 1 by `startSync()` (`resetUnsyncedChanges` *assigns*, discarding anything
  counted while the socket was still opening) and decremented only by `SyncStatus(true)` — there
  is no `false` branch (see the phase-2 notes above). So: handshake seen + counter drained =
  pushed; connection live and synced at the deadline + counter pinned = **the server refused**
  (locked/trashed/read-only) → `blocked`, kept and surfaced; no handshake = unreachable →
  `retry` (`no-handshake`), entry untouched, backoff; handshake seen but the socket down (or
  not re-synced) at the deadline = a flaky link → `retry` (`connection-lost`), same treatment.
  The in-editor warning (`unsynced-changes.ts`) never had this defect: its rule 1 resets the
  pending clock whenever live sync is lost, so it only judges a connection that is answering.
  A dead network must never be reported to the user as "this page could not sync", and a locked
  page must never be retried in silence forever. Authentication failure with a token
  `isCollabTokenExpired()` says is still valid is the other `blocked` reason: the page was
  hard-deleted, or access to it was revoked.
- **The offline edits ride the handshake.** The client answers the server's SyncStep1 with a
  SyncStep2 containing everything the server lacks — the same mechanism that pushes them today
  when the page is re-opened. Nothing in phase 3 constructs, replays or discards a Yjs update.
- **Three exclusions, three mechanisms.** Serial within a tab (the loop awaits each page); one
  tab per browser via `navigator.locks.request(…, { ifAvailable: true })` — `ifAvailable` so a
  second tab *declines* rather than queueing a duplicate pass; and never the page on screen, via
  `open-page-registry.ts`, checked before each page **and on every poll**, because the user can
  navigate into a page mid-push. The editor's claim is unconditional and always wins.
- **Blocked entries are never discarded**, and the UI is a *persistent* affordance rather than a
  toast: the work exists only on this device and nothing else in the product will ever mention
  it. The link is built from metadata captured at record time (`dirty-page-link.ts`) so it
  survives query-cache eviction; the resolver is *installed* by `use-offline-resync.ts` rather
  than imported, so the editor hook never drags `main.tsx` into its unit tests.
- **The switch still gates everything.** With `docmost.offline-editing` off the manager is never
  created — no timers, no `online` listener, no database — and the switch is reactive, so
  turning it on starts the loop without a reload.
- **Both new stores are cleared by `clearOfflineData()` on logout.** The registry is an index;
  the edits it indexes are the `page.*` databases the same call already deletes.

Deviations from #20, deliberate: the retry schedule is `5 s → 15 s → 60 s → 3 min → 10 min`
rather than "~60 s with backoff" (a flapping reconnect is worth recovering from in five seconds;
a device that has failed five passes is not about to succeed on the sixth), and blocked entries
are retried on *trigger* passes (reconnect, boot, manual) but skipped by the periodic timer,
which would otherwise burn a 30 s timeout per locked page on every tick forever.

Known limitations: a page whose lock is lifted while the tab sits idle is not re-attempted until
the next reconnect, boot or review; and the manager pushes Yjs content only — a title edited
offline is still lost, since titles are REST-only (#19's note stands). An outbox for titles
remains out of scope. #21's attachment outbox is now plugged into this same manager — see the
next section.

### Attachment upload outbox (issue #21) — Excalidraw & media offline

Phase 4, **opt-in behind the same `docmost.offline-editing` switch and qualitatively riskier
than phases 1–3** (the issue says so and it is true — read the LWW caveat first). Attachments
never touch the CRDT: an Excalidraw drawing is one SVG uploaded over REST, a pasted image is a
REST upload the node then references. So offline attachment work is an *outbox*:
`upload-outbox.ts`, its own IndexedDB database (`docmost-offline-outbox`, same `NotFoundError`
reasoning as the sync markers), holding the blob plus enough to replay the upload and repair the
document afterwards, keyed by **the attachment id the document points at**.

**⚠️ The Excalidraw last-writer-wins caveat, stated plainly.** A diagram is overwritten
wholesale on save. Replaying an offline save is **last-writer-wins at the file level**: if
someone else edited the same diagram while you were offline, your replay silently replaces their
version. There is no merge and no client-side fix; it is inherent to a single-file diagram
(same class of caveat as `update_page` replace in the MCP write surface). Acceptable for
single-author pages, dangerous for shared ones — which is a large part of why the feature stays
behind the default-off switch.

**The pending-URL trick is the whole design.** A queued upload's node carries
`src = /api/files/<id>/<fileName>` — a *real-shaped* attachment URL whose id is a
client-generated placeholder UUID for new files (`mode: "create"`), or the real id for an
existing Excalidraw diagram (`mode: "overwrite"`). The service worker's existing `api-file`
route consults the outbox **before the network** (`sw/outbox-serving.ts`) and answers those URLs
from the queued blob. That one decision buys, with **zero changes to any upstream node view**:
rendering offline; rendering *after reload* (the issue's "re-derive from the outbox blob after
reload" — an object URL dies with the document, the outbox record does not); rendering online
before the replay lands (the server would 404); and — for an existing diagram with a queued
overwrite — **reopen-safety**: `handleOpen` fetches the node's `src`, the worker serves the
queued blob, so the user edits their latest save instead of clobbering it with edits to the
stale server copy. Cost, stated plainly: with no service worker (dev server) a pending node is a
broken image until replay. Real attachments pay one keyed IndexedDB miss per fetch; outbox
responses are never HTTP- or SW-cached, so a deleted record ends the URL.

**Call sites, kept to one import each** (`offline-uploads.ts` is the barrel, like
`offline-editing.ts`): both Excalidraw components route their save through
`saveExcalidrawOrQueue` — online it *is* the upstream `uploadFile` + attrs pair, and it also
repairs the two queue states it can meet (a placeholder id must never reach the server, so that
save uploads fresh and deletes the superseded record; a queued overwrite is deleted after a
direct save of strictly newer content — replaced, not discarded; **a direct save the server
refuses rethrows and keeps the queued record** — pinned by test). Offline it enqueues; for an
existing diagram the node keeps its id and path but gets a **fresh `?t=` cache-buster** (review
gap #3): the img node view re-assigns `el.src` on change, so the in-page preview re-fetches
through the SW — which matches outbox records by attachment id, never by query string — and
shows the new drawing immediately instead of after a reload. The attr write is an ordinary
offline document edit and syncs with everything else on reconnect.
`handlePaste`/`handleFileDrop` call `queueMediaFilesOffline` at the top of their file branches;
it answers `false` — do the upstream thing — in every non-queueing session. A **transport**
failure during an apparently-online save reroutes into the queue (the reachability verdict lags
the first dropped request of an outage); a server *answer* is always rethrown — converting "the
server said no" into "it will upload later" would be lying. The attr shapes for all five node
types live in exactly one module (`pending-media.ts`), transcribed from the upstream upload
pipeline, and rewrites are **merges** over current attrs so width/align survive.

**Replay rides the #20 manager** (`upload-replay.ts`, called from `runResyncPass` after the page
loop): same lock, same triggers, same backoff, same two ownership gates, same
blocked-on-trigger/skip-on-periodic rule. Unlike pages there is **no open-page exclusion** — an
upload is REST and touches no provider; replaying while the user is on the page is strictly
better. Blocked vs retry is HTTP-simple: 403/404 → `no-access`, other 4xx → `rejected` (both
kept and surfaced in the same pill/modal as blocked pages, **with a Download affordance**,
because the blob is the only copy anywhere); transport/5xx → retry; 401 → retry, because the
axios interceptor is already running session expiry, which preserves the outbox. A re-save
racing an in-flight upload is caught by `markUploadUploaded`'s `asOf` check — the newer blob
stays pending and replays next pass.
**A TRASHED page is not a refusal, measured rather than assumed** (#42 verification): the
server's `POST /files/upload` looks the page up with `pageRepo.findById`, which does not filter
`deletedAt`, and `validateCanEdit` checks membership, restrictions and the fork's lock — not
trash. So a queued overwrite replayed against a page another account trashed **uploads
successfully (200)**, settles, and is deleted; the pill's pending count dropping with no
blocked entry is a *completed* upload, and the bytes are on the trashed page — restore it from
trash and the offline drawing is there. Verified in a real browser three ways, including with
the Excalidraw modal open across the reconnect. The blocked path is for genuine refusals —
locked page and revoked access answer 403, a permanently-deleted page 404 — and was verified
end to end the same way: record marked `no-access`, kept, listed in the review modal with a
working Download, zero uncaught errors. The review-modal render path is pinned by
`resync-indicator.test.tsx` against the exact record shapes a pass produces (`blocked` set,
`link` absent, `lastPass` without `uploadedFiles`).
**The queue is published on boot, not only after passes** (review gap #4): a
reload-while-offline used to show no "N uploads waiting" pill and no blocked list over a
populated outbox, because enqueue-time publishing died with the previous document and the only
other publisher — the replay pass — is exactly what cannot run offline. `runResyncPass`'s
offline early-return now publishes both (after the ownership gate, so a stranger's counts are
never shown), and the switch turning on reaches the same path through the manager's boot pass.
**Two uncaught-error sources found by the same verification pass, both fixed:**
`useCollabToken`'s retry callback (`auth-query.tsx`) read `error.response.status` unguarded,
and `error.response` is undefined for every transport failure — an uncaught
`TypeError … (reading 'status') at retry` on the offline/reconnect boundary (reproduced
byte-for-byte in a real browser; the throw also broke that query's own retry loop). Now
optional-chained via the exported, tested `collabTokenRetry`. And `excalidraw-menu.tsx`'s
`handleOpen` opened the modal from its `finally` even when the scene fetch failed (the caught
error printing as "TypeError: Failed to fetch" from that chunk) — handing the user an **empty
editable canvas over an existing diagram**, whose next save or 60 s autosave would overwrite
the real content, queued blob included, with a blank scene. A failed load now refuses to open
and says so (`notifyDiagramLoadFailed`, kept in the `offline-uploads` barrel so the menu keeps
its single offline import).

**Rewrites are deferral, never ephemeral providers** — the issue's stated preference, and the
fork's pin makes it non-negotiable: nothing here constructs a provider session or transforms a
ydoc outside the editor. A successful `create` upload rewrites the node attrs through the page's
**live editor**, reached via `pageEditorAtom` (which `page-editor.tsx` already publishes
upstream — zero new lines there); if the page is not open, the record stays `uploaded` (SW keeps
rendering it) and `pending-node-rewrite.ts`'s watcher settles it on the next page open in this
tab. A false "the node is gone" would delete the only renderer of the placeholder URL, so that
verdict requires the open-page claim, the editor instance's own `storage.pageId`, and a document
past its initial-empty state (a just-mounted editor holds one empty paragraph until y-indexeddb
replays — "empty" must read as *not loaded yet*). `overwrite` records are deleted after upload
even unrewritten: the node already points at the real id, only the `?t=` cache-buster is stale,
and keeping the record would pin the SW to the local blob forever on a page never reopened here.
**Every overwrite settlement also purges the SW files cache for that attachment id**
(`purgeCachedAttachment`, matching by the same `outboxCandidateIdFromPath` rule the worker
uses): the cache can hold the diagram's *pre-save* bytes under the very URL the node carries,
and with the record gone an offline reopen would otherwise be handed that stale scene as an
**editable base**, whose next queued save silently overwrites the user's own newer server
version. "Broken image until reconnect" is the accepted cost; a stale editable base is not.
Consequence of deferral, stated plainly: until the uploading device reopens the page, **other
clients see the placeholder URL as a broken attachment** (their SW has no such record). The
replay pushes promptly on reconnect, so the window is normally the same as the page resync's.
The replay also **re-reads each record at upload time** rather than trusting the pass-start
snapshot: a record deleted mid-pass (the user saved the same diagram directly online) is
skipped, and a record re-saved mid-pass uploads its fresh blob — replaying a stale snapshot of
an overwrite could otherwise land *older* bytes as the server's latest.

**Session expiry preserves the outbox under the provable-ownership rules** — the same deliberate
narrowing as #18's, extended: a queued blob can be the only copy of a drawing, so the 401 path
preserves the outbox whenever it holds records (or cannot be read — "I cannot tell" preserves,
never erases) *and* the owner hint + stamp succeed; with no provable owner it is erased with
everything else, work included. Four things the dirty-registry logic alone would get wrong, all
pinned by tests: the outbox is consulted **independently** (an Excalidraw re-save queues an
upload without ever touching the ydoc, so "no dirty pages" ≠ "no pending work"); preserving
only the outbox still counts as "preserving something" so the owner hint survives; the
**dirty-page store is preserved whenever anything is** — including outbox-only work — because
the owner stamp lives *inside* it under a reserved key, and clearing it would stamp the owner
and then destroy the stamp one call later, leaving preserved blobs unattributable (an
empty-but-stamped registry is harmless; every listing filters the reserved key out; there is an
end-to-end test wiring the real store to prove the stamp survives); and **reconcile's unstamped
branch consults the outbox as well as the dirty registry** — an unstamped disk whose outbox
holds records is erased exactly like one with dirty pages, since a foreign blob left behind
would otherwise replay under the next user's cookie or be offered to them as a Download from
the blocked list. A genuinely fresh browser — both stores empty — still reads as clean and
never pays. Explicit logout still erases everything, unconditionally. The login-page notice
carries a **queued-uploads count** alongside its page list (review gap #5): outbox-only
preservation used to write a notice naming zero pages, which the reader took for "nothing
preserved" and rendered nothing — precisely for the work whose only copy is the queued blob.
An unreadable outbox is still preserved but counted as `uploads: 0`, because the notice must
never claim uploads that may not exist. The replay itself sits
behind `offlineDataIsOurs()` twice (cached verdict + the stamp beside the records). **Known
gap, deliberate**: the service worker cannot know who is signed in, so until sign-in reconcile
erases a foreign outbox it would serve a previous user's blob to a session that requests its
placeholder URL — reaching one requires knowing that UUID, and rules 1/3 of the ownership
scheme bound the window exactly as they do for `page.*` documents.

**Excalidraw fonts are self-hosted** (`build/excalidraw-assets-plugin.ts` +
`excalidraw-assets.ts`): `window.EXCALIDRAW_ASSET_PATH` was never set, so fonts came from a CDN
and the offline modal fell back to system fonts. The build copies the installed package's
`dist/prod/fonts` into `dist/excalidraw/**` (build-time copy — no binaries in the repo; resolved
from the package *main entry*, since its `exports` map hides `package.json`) and `register.ts`
sets the global — zero upstream-file changes; the dev server falls through to the CDN exactly as
before. Precache interplay, measured: Latin families (25 files, ~0.5 MB) are `optional` warm-up
entries; the **12 MB Xiaolai CJK family stays out of the manifest entirely** and is
runtime-CacheFirst via a new `/excalidraw/` asset route (users who draw CJK get the subsets
cached on first use); `classifyExcalidrawAsset` keeps every font out of required `core`, whose
small size gates worker activation. Post-#21 the manifest measures **35 core / 81 optional**
(the pre-#21 measurements elsewhere in this file — 34 core, warm to 90 — are historic values
from their build).

**Durable storage** (`durable-storage.ts`): `navigator.storage.persist()` is requested when the
switch is turned on and on every boot with it on — and **never with it off, a gate enforced
inside the module** because Firefox answers `persist()` with a user-facing permission prompt
that a user who never opted in must never see. The verdict is advisory: logged, a one-line note
in the preference UI on denial, no behaviour change. It protects only against *automatic
eviction under storage pressure* — clearing site data, private windows and cookie-clearing
policies still erase everything, and nothing can prevent that.

Known limitations, documented rather than hidden: page **titles** remain REST-only and offline
title edits are still lost (#19's note stands); draw.io is an external iframe and permanently
out of scope offline; a blocked upload whose cause is fixed server-side is retried on trigger
passes only, like blocked pages; an `uploaded` create-record whose page is never reopened in
this tab keeps its blob on disk indefinitely (logout clears it); pending media inserted
offline renders no per-node badge — the queued state is announced once via notification and
surfaced in the standing pill ("N uploads waiting for connection" offline, and the blocked
list), a deliberate trade against patching four upstream node views; **a queued VIDEO does not
preview while pending** — browsers fetch `<video>` with a `Range` header, and Range requests
are passed through untouched (a pre-existing, load-bearing SW invariant: a cached full body
answered to a Range request, or a cached 206, corrupts playback), so the placeholder URL goes
to the network and fails until the upload replays; the blob itself is safe and uploads like
everything else; and **cutting a pending node and pasting it on a different page** leaves the
record's `pageId` pointing at the original page, so when *that* page next opens the watcher
reads "node gone" and deletes the record — the pasted copy's placeholder URL stops rendering,
while the bytes survive server-side (after replay) as an attachment of the original page.

**Upload outbox repro** (add to the offline-editing repro; switch on, page previously synced):

1. Offline, open an existing Excalidraw diagram, draw, **Save & Exit** — the modal closes, a
   blue "saved on this device" notification appears, and the in-page preview shows the *new*
   drawing (served by the worker). Reopen the modal offline: it loads the new drawing, not the
   stale server copy.
2. Offline, paste an image and drag-drop a PDF: both render immediately and survive a reload
   while still offline. DevTools → Network shows the `/api/files/<uuid>/...` requests answered
   by the service worker (`x-docmost-sw-outbox: 1`). A dropped **video** queues but does not
   preview while pending (Range requests bypass the worker — see the limitations above); it
   must still upload and resolve on reconnect like the others.
3. Reconnect: `[docmost] offline uploads: … queued upload(s) to push` in the console, the toast
   counts files, and the nodes now point at real attachment ids (`select id, file_name from
   attachments order by created_at desc` grows). The Excalidraw attachment keeps its id.
4. Lock the page (or permanently delete it) from another account before reconnecting: the pill
   shows "N items could not sync — review", the review modal lists the file with a working
   **Download**, and nothing is discarded. Merely **trashing** the page is NOT this case: the
   server accepts uploads to trashed pages (see the replay notes above), so the queued upload
   lands, the record settles, and restoring the page from trash shows the offline drawing.
5. Reload while still offline: the "N uploads waiting for connection" pill reappears from the
   boot publish (gap #4) — a populated outbox must never be invisible.
6. Log out while offline with a queued upload: the app must reach the login page (never wedge
   on a stuck error screen), and all offline stores are erased — the explicit logout wins even
   with no network (BUG 2). The server-side session survives until expiry; that residue is
   documented above.
7. Switch off ⇒ all of it is inert: offline Excalidraw save fails with the modal left open and
   paste does nothing, exactly as upstream.

### Detecting offline (`reachability.ts`) — ⚠️ `navigator.onLine` is not it

Everything above depends on one question, and for phases 1b–3 that question was answered by
`navigator.onLine`. **It is not a reachability signal**, and on a real deployment it broke the
feature outright: with a VPN configured, both Chrome and Safari keep reporting
`navigator.onLine === true` after Wi-Fi is switched off, because the tunnel's virtual interface
(`utun*` on macOS) is still up. The spec only makes `false` meaningful — `true` means an interface
exists. Captive portals, an Ethernet cable into a dead switch and bridged VM adapters all do the
same thing.

Every consumer was wrong at once, and one of them silently: the #19 gate never opened, so offline
editing did nothing; React Query was never paused, so restored queries errored on top of a good
cache; and because the property never *transitions*, **neither `online` nor `offline` ever fires**
— so the #20 reconnect trigger did not exist either and pending edits waited for the ten-minute
periodic timer.

- **The question is "can we reach *this* server", never "is there internet".** For a self-hosted
  install a third-party probe is wrong in both directions — a server reachable only across the VPN
  is up with no internet at all, and a working connection says nothing when the container is down
  — besides sending a request somewhere the operator did not choose.
- **The probe is `GET /api/health/live`, and every property that makes it the right target is a
  property of this deployment**, verified in the tree rather than assumed: it returns `ok` without
  touching Postgres or Redis, `HealthController` carries no `JwtAuthGuard` (guards are
  per-controller; there is no global one), it is excluded from `DomainMiddleware`, from the
  `workspaceId` preHandler and from request logging, and only `auth.controller.ts` is rate limited.
  **Zero server changes**, which is what keeps the offline feature's promise about `apps/server/`.
- **The probe carries credentials (`same-origin`), and must keep doing so.** The endpoint needs no
  session, so omitting the cookie looks like hygiene — but behind an authenticating reverse proxy
  (Cloudflare Access, oauth2-proxy, Authelia) a cookie-less request is redirected to the identity
  provider, `fetch` follows it cross-origin, and the request rejects on CORS. Every probe would
  fail forever on a perfectly healthy deployment, and the verdict pauses React Query. There is
  nothing to protect by omitting: this is our own origin, and every other request the app makes
  sends the same cookie. Asserted by test.
- **The service worker must never be allowed to answer it.** `sw/routes.ts` passes through every
  `/api/` path except `/api/files/`, and a test asserts the classification *from the probe
  constant*. `cache: "no-store"` governs the HTTP cache and says nothing about Cache Storage, so a
  probe the worker could serve would report a server unreachable for a week as up.
- **Any HTTP response counts as reachable, including 404 and 502.** The question is whether packets
  completed a round trip, not whether the server is well: a reverse proxy that does not forward
  this one path must not be able to convince the app it is offline. Only a transport failure or a
  timeout is a failure — which also handles captive portals, whose cross-origin redirect makes
  `fetch` reject on CORS.
- **Hysteresis one way only.** Two consecutive failures declare unreachable (a single dropped
  request is ordinary, and the verdict *pauses every query in the app*); a single answer from the
  server declares reachable immediately. That asymmetry is what makes a wrong offline verdict
  self-correcting, and it matters because `installQueryOnlineManager` hands this verdict to React
  Query.
- **The probe is the fallback, not the signal.** `lib/api-client.ts` reports every axios response
  as reached and every transport-level failure as suspect, and `collab-connection-watch.ts` does
  the same for the collaboration socket — a completed handshake is proof, a drop is only a hint,
  and it must persist 3 s to count at all because every page navigation rebuilds the provider. An
  app in use therefore probes approximately never; the 30 s heartbeat exists solely for an **idle**
  tab, which makes no HTTP requests at all and would otherwise not notice a dead network until the
  user's next click. It is skipped while the tab is hidden and while traffic is flowing.
- **`whenServerReachable()` resolves only on a *definitive* verdict**, and `use-offline-resync.ts`
  awaits it before deciding whether to trust the cached user. Reading the optimistic boot
  assumption instead is what left offline editing dead on a cold offline boot: `getMyInfo()` failed,
  ownership refused to settle, and the gate requires `offlineDataIsOurs`.
- **Subscribers are notified by comparing against the last *published* verdict**, not by a
  before/after comparison inside the update. `navigator.onLine === false` is a live veto on every
  read, so when Wi-Fi really is switched off the verdict changes *before* the `offline` event
  arrives — a before/after comparison sees `false → false`, concludes nothing changed, and tells
  nobody. Caught by a test, not by a browser.

Consequences worth knowing: a session whose **server** is down (rather than whose network is) now
opens the #19 gate too, which is the same situation from the document's point of view and pushes on
recovery like any other offline edit. A session that can reach the API but not the collaboration
WebSocket still stays read-only. And an idle tab now sends one ~200-byte unauthenticated,
unlogged request every 30 s — deliberately unconditional, like phases 1a/1b, because the verdict
drives the offline pill and React Query's pausing as well as the editing gate.

**The one deployment shape to keep in mind**, stated rather than hidden: a reverse proxy that
forwards `/api/*` but **black-holes** `/api/health/live` specifically — no response at all, not
merely a 404 — makes an *idle* tab decide it is offline. React Query then pauses fetches, so the
recovery signal cannot come from a query. Two things stop that being terminal, and neither is the
probe: the collaboration socket is not routed through React Query, so opening any page produces a
handshake that reports reachable and unpauses everything; and the first successful response of any
kind does the same. It is worth verifying with the `curl` in the repro above rather than relying on
those, because "idle tab shows the offline pill" is a confusing thing to debug.

## Vim keybindings (`features/editor/extensions/vim-mode.ts`, PR #26)

Modal editing in the **page editor only**, off by default behind the `vimMode` user preference
(same plumbing as `editorToolbar`, straight through `updatePreference` into the existing settings
JSONB — no migration). Nothing here touches the collaboration/persistence path.

**Status: spike.** [`vim-prosemirror@0.2.0`](https://www.npmjs.com/package/vim-prosemirror) is
three weeks old, single-maintainer, and already patched twice. It is on trial, not adopted.

**We wrap its raw ProseMirror plugin, never its Tiptap extension** (`vim-prosemirror/tiptap`):

1. Its wrapper calls `editor.commands.undo()` unguarded, which throws in the pre-sync static
   editor, the readonly editor and the history editor — all of which share `mainExtensions` and
   load no history extension.
2. Its `>>`/`<<` hardcodes `sinkListItem("listItem")` and never reaches our `Indent` extension or
   task items.
3. The preference must toggle **without rebuilding the extension array**, which would recreate the
   collaborative editor mid-page. So the plugin is always registered and gated per-editor at
   runtime through a `WeakMap<Editor, VimRuntime>`, and `mainExtensions`' other consumers
   (readonly, history, transclusion, template) can never pick it up.

**Command lookup must stay lazy.** `addProseMirrorPlugins` runs while the `Editor` is still being
constructed — `createCommandManager()` has not run yet — so a captured `editor.commands` is an
empty map and every lookup misses silently. That is what broke `u`. Resolve per keypress.

**Keys we take back from vim** (`shouldBypassVim`): the library reads `event.ctrlKey` and never
looks at `metaKey`, so on macOS every Cmd chord arrives as a bare vim key — Cmd-V entered visual
mode, Cmd-C started a change operator, Cmd-X deleted a character. Cmd and Alt chords are now
handed back whole; on non-Apple platforms, where Ctrl is both modifiers, the browser and app keep
`a c v x z y f` and vim keeps the rest of its Ctrl bindings. Open slash/emoji popups bypass too.

**Touch devices are opted out.** Soft keyboards emit `keydown` with keyCode 229 and no usable
`key`, so modal editing silently degrades to always-insert.

### The two dependency patches (`patches/vim-prosemirror@0.2.0.patch`)

`VimState.register` is declared in the types but is **dead code** in 0.2.0 — there is no register.
`y`/`d`/`c`/`x` write to the *system clipboard* and `p` reads it back with
`navigator.clipboard.read()`, which is permission-gated in Chrome and Safari (a Paste dialog on
every press) and absent for page script in Firefox. It is also async and unawaited on the write
side, so `dd` then a fast `p` can race, and its own Markdown re-parser competes with our
`MarkdownClipboard` extension.

1. `p`/`P` paste the in-memory register synchronously, like vim's unnamed register. Pasting from
   *outside* the editor stays on Ctrl/Cmd-V — the only path that reaches Docmost's own paste
   pipeline (image/file upload, markdown transform), which vim's path cannot do.
2. The register is recorded **before** the `navigator.clipboard` guard, not after. Upstream's
   early return meant `y`/`d`/`c`/`x` recorded nothing in a non-secure context, so `p` was dead on
   plain-HTTP self-hosted deployments.

If a third patch becomes necessary, vendor the package into `packages/editor-ext` instead — at
that point our own vim code outweighs the glue.

### Known gaps

- No `:` ex commands, so no `:%s/pat/rep/g` — tracked in issue #25. `Mod-F` find & replace is
  unaffected and still works.
- `Escape` is consumed in normal mode, so it will not close the find dialog from inside the editor.
- `zz`/`H`/`M`/`L` resolve against the scroll container and are untested against our layout.
- `vim-prosemirror` publishes ESM with extensionless relative imports, which Node's resolver
  rejects. Vite backfills the extension; **vitest needs `server.deps.inline`** (see
  `apps/client/vitest.config.ts`).

## Personal spaces (`core/personal-space`)

Lets a workspace MEMBER own exactly one space of their own. The **only** thing this adds is a
second way to create a space; everything after creation is an ordinary space.

**Almost all of it already shipped natively in the `v0.95.0` base** — the schema
(`spaces.is_personal` + the `spaces_personal_creator_unique` partial index),
`SpaceRepo.findPersonalSpace`, `SpaceService.createSpace`'s `{ isPersonal }` option, the audit
entry, the workspace toggle (`settings.spaces.allowPersonal`, licence-gated on
`Feature.PERSONAL_SPACES` in `workspace.service.ts`) and the **entire client**
(`apps/client/src/ee/personal-space/*`; the client `ee/` dir is in-repo, only `apps/server/src/ee`
is the unfetchable submodule). Only the two endpoints the client calls — `POST
/personal-space/info` and `POST /personal-space/create` — were EE-only. This module is those two
endpoints and nothing else; there are **no client, schema or permission-model changes**.

**Why a separate endpoint at all.** `spaces/create` requires the workspace-level
`Manage`/`Space` ability, which MEMBERs do not have (`workspace-ability.factory.ts`), so a member
can otherwise never own a space. `personal-space/create` deliberately does not perform that check
— the admin toggle plus the one-per-creator unique index are what replace it. That is the whole
feature, and it is why the create path lives in its own controller rather than as a flag on
`spaces/create`.

**Licensing is checked once, on the toggle write**, matching the MCP module: an unlicensed
workspace can never switch `allowPersonal` on, so the endpoint checks only the toggle. `info` is
deliberately *not* toggle-gated — turning the toggle off stops new personal spaces, it does not
hide the one a user already owns (which is what the client's top menu expects).

**The slug is generated, never accepted from the client** (the modal has no slug field).
`slugBase()` folds accents, drops apostrophes and collapses the rest to hyphens, then up to four
retries append a short nanoid suffix — personal-space names collide by nature (two Sams in one
workspace). Its output is asserted against `CreateSpaceDto`'s slug regex by test, since nothing
else validates a server-generated slug.

### Deliberate non-changes (behaviour you should know about before enabling it)

These are all pre-existing Docmost semantics, kept as-is on purpose:

- **Workspace owners/admins cannot see a personal space.** `SpaceAbilityFactory` resolves roles
  purely from `space_members` and has no owner override; `WorkspaceCaslSubject.Space` is checked
  in exactly one place in the server (`space.controller.ts`, `spaces/create`). So an owner cannot
  read, list, export or delete another user's personal space, and cannot add themselves to it.
  This is already true of any space an admin isn't a member of — personal spaces just make that
  set large. Creation is still audited (`SPACE_CREATED` with `isPersonal: true`).
- **"Personal" is not enforced after creation.** The creator is space ADMIN, so they can rename
  it, add members/groups, or public-share pages from it (still subject to `disablePublicSharing`).
  Nothing re-reads `is_personal`.
- **Deleting a user orphans their personal space.** `workspace.service.deleteUser` removes the
  user's `space_members` rows but never touches `spaces`, so the space survives with zero members:
  unreachable by everyone and undeletable through any route. Pre-existing for any space, but
  personal spaces make it routine — fix it deliberately, not as a side effect of this feature.

## Adopting a newer upstream release

```bash
git fetch upstream --tags
# replant our commits from the current base onto the NEW release tag:
git rebase --onto <new-tag> <current-base-tag> main
# expected only conflict: pnpm-lock.yaml (see below) — resolve, then:
git rebase --continue
# verify (below), then:
git push --force-with-lease origin main
git tag fork-v<new-base>-1 && git push origin fork-v<new-base>-1   # → CI publishes to GHCR
```

Keep a backup branch before rebasing: `git branch backup/main-pre-<date> main`.

## Lockfile (pnpm) — read before regenerating

- Package manager is **pinned to `pnpm@10.4.0`** (`package.json` → `packageManager`); the
  Dockerfile installs that exact version and runs `pnpm install --frozen-lockfile`.
- The root `package.json` `pnpm.overrides` / `pnpm.patchedDependencies` are **load-bearing**
  (security/compat pins incl. `y-prosemirror`, `ws`, `dompurify`, a patched `scimmy`). Newer
  pnpm (11+) warns it ignores the `pnpm` field, but preserves overrides already recorded in an
  existing lockfile.
- To resolve a rebase lockfile conflict: reset the file to the base tag's version, then
  regenerate — this reapplies overrides and adds only our new deps:
  ```bash
  git checkout <base-tag> -- pnpm-lock.yaml
  pnpm install --lockfile-only
  git add pnpm-lock.yaml && git rebase --continue
  ```
- Sanity check the result matches the pinned pnpm: `npx pnpm@10.4.0 install --frozen-lockfile`
  must print "Lockfile is up to date".

## Private `ee/` submodule

`.gitmodules` declares `apps/server/src/ee` → `https://github.com/docmost/ee` (private, upstream
only). The fork **cannot** fetch it and **does not need it** — it ships native replacements and
gates on the module's absence. Consequences:
- Build/checkout **without** the submodule. CI uses `actions/checkout` with `submodules: false`.
- The local docker build works with an empty `ee/` dir; don't try to initialize the submodule.

## Verify after any base/dependency change

```bash
# typecheck
pnpm --filter "@docmost/editor-ext" build          # build shared workspace pkg first
( cd apps/client && npx tsc --noEmit )              # expect 0 errors
( cd apps/server && npx tsc --noEmit -p tsconfig.json )   # expect 0 errors
( cd apps/client && npx vitest run )                # expect 0 failures

# end-to-end: rebuild image + boot, then run the repro
docker compose -f docker-compose.local.yml build docmost
docker compose -f docker-compose.local.yml up -d    # app on http://localhost:3000
```

**Data-loss reproduction** (must NOT lose content): create two pages with distinct content
(e.g. a D2 block and an Excalidraw diagram), switch rapidly back and forth many times, then
reload. Content must survive. A poll of `select octet_length(ydoc), length(text_content) from
pages` should never show a populated page collapse to ~100–500 bytes with `text=0`.

**Offline/PWA checks** (see the Offline/PWA section above):

```bash
( cd apps/client && npx vite build )
test -f apps/client/dist/sw.js                              # must be at the dist ROOT
grep -c '\.html' apps/client/dist/sw.js                     # must print 0
grep -oh '0\.95\.0+[A-Za-z0-9]*' apps/client/dist/assets/index-*.js | head -1
# ^ the query-cache buster: must carry a build id suffix (git SHA locally,
#   BUILD_ID in CI, timestamp in arg-less Docker builds). A bare version here
#   means the buster stopped rotating — the poisoned-store condition.
```

Then, in a browser against the running container:
1. Load the app, DevTools → Application → Service Workers: `sw.js` is activated and running.
   Cache Storage shows `docmost-offline-precache-<version>-<hash>` at 34 entries immediately,
   growing to 90 as the best-effort warm-up finishes. No `.html` entry may ever appear.
2. `curl -I http://localhost:3000/sw.js` → `content-type: application/javascript` (**not**
   `text/html`) and `cache-control: public, max-age=0` + `ETag`. A `text/html` here means
   `sw.js` was missing from `client/dist` when the server booted.
3. Open a page containing a mermaid block and one containing a D2 block.
4. DevTools → Network → Offline, reload: the shell boots from cache with `window.CONFIG` intact
   and no chunk-load errors, **and the app renders** — sidebar tree and previously visited pages
   come from the persisted query cache (#18). A page never opened online shows the "Page not
   found" empty state rather than crashing.
5. DevTools → Network → Online: the `/collab` and `/socket.io` WebSockets reconnect normally
   (the worker must never appear in their request chain).
6. Deploy a newer build, then reload an old tab: the "A new version is available" prompt
   appears, "Reload" activates the waiting worker, and `docmost-offline-precache-*` caches from
   the previous build are gone afterwards. The tab must **not** reload on its own.

Since #18 the offline diagram criterion can be checked by hand: open a page with a mermaid block
and one with a D2 block while online, go offline, reload, and reopen them. Both previews must
render with nothing fetched from the network. Re-do this if you change the precache
classification.

**Offline editing repro** (#19; run the data-loss reproduction above **twice**, once with the
switch on and once off — the switch must make no difference to it):

1. Settings → Preferences → **Edit pages offline** → on. Open a page online and let it sync.
2. Go offline (DevTools → Network → Offline). The live editor stays up and a grey "Offline —
   changes are saved locally…" banner appears. Type in the body, and inside a mermaid/D2 code
   block. The page title must be non-editable with a tooltip.
3. Reload while still offline: the edits are still there and the editor is still live.
4. Meanwhile, from another account, edit the same page. Go back online: both sets of edits are
   present. `select octet_length(ydoc), length(text_content) from pages` must **grow**; a
   populated page collapsing to ~100–500 bytes with `text=0` is the regression.
5. Lock the page from the other account while the first user edits it offline, then reconnect:
   within ~15 s the orange "Your changes could not be saved to the server" banner appears and
   the local document is untouched. Nothing may ever discard it.
6. Open a page never visited before as the **first** page of an offline session: it must stay
   static and read-only.
7. Switch off ⇒ everything above is inert: static read-only offline, no banners, editable title.

**Reachability repro** (the VPN case; DevTools' Offline toggle **cannot** reproduce it, because it
also forces `navigator.onLine` to `false` — which is the failure mode's whole disguise):

1. On a machine with a VPN configured, connect the VPN, then switch Wi-Fi **off** at the OS level.
2. Console: `navigator.onLine` prints `true` — the bug's starting condition. On any build before
   this fix, everything below fails here.
3. Within ~10 s the "Offline — showing saved content" pill appears, and a previously-synced page
   stays editable with the grey "changes are saved locally" banner. Network shows repeated failed
   `GET /api/health/live` requests, then a widening gap between them.
4. Switch Wi-Fi back on: within ~5 s a probe succeeds, the pill disappears, and the offline edits
   are pushed with no page re-open (`[docmost] offline resync: … (online)` in the console).
5. Server-side sanity check, on the deployment rather than in a browser:
   `curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/health/live` must print `200`.
   Any status is survivable (any HTTP status counts as reachable); a reverse proxy that
   **black-holes** that one path is the case to care about — see the note at the end of
   **Detecting offline**.

## Deploy (GHCR)

`.github/workflows/fork-image.yml` builds multi-arch (amd64+arm64) and pushes to
`ghcr.io/sawii00/docmost` on `fork-v*` tags, using the built-in `GITHUB_TOKEN`. Deploy by
pinning the immutable tag on the server:

```yaml
services:
  docmost:
    image: ghcr.io/sawii00/docmost:fork-v0.95.0-1   # not `build:`
```

Tag scheme: `fork-v<upstream-base>-<iteration>` (stays clear of upstream's `v*` tags so their
Docker Hub `release.yml` never fires on ours). Also published: `:fork-latest` (moving).
