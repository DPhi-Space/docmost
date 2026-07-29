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
- `feat(offline): service worker + PWA app shell (#17)`, `persist React Query cache (#18)` and
  `allow editing offline on previously-synced pages (#19)` — see **Offline/PWA** below. #17/#18
  touch nothing on the collaboration path; **#19 is the fork's one deliberate exception**, a
  24-line patch to `page-editor.tsx` that must be re-implemented by hand if the base ever moves
  past upstream's collab rewrite.
- other commits not mentioned here

With the single, documented exception of #19's 24-line gate patch, none of these touch the
collaboration/persistence/page-load path — that's what keeps upstream adoption low-conflict.

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

## Offline/PWA (`apps/client/src/features/offline`, issues #17–#19)

Phase 1a of the offline plan (tracking issue #22): a service worker that makes the **app shell**
(JS/CSS/fonts/icons/locales) load with no network. Data persistence is #18 and offline editing
is #19, both below; background sync (#20) and uploads (#21) are still unbuilt. Nothing in
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
- **React Query's `onlineManager` must be seeded from `navigator.onLine` at boot**
  (`online-state.ts`). It initialises to `online = true` and only ever reacts to `online` /
  `offline` *events*, so a tab loaded while already offline never learns the truth: instead of
  pausing fetches it runs every restored query into a network error. That single default is what
  stands between a persisted cache and a usable offline app — without the seed the app renders
  "Error fetching page data." on top of a perfectly good cache, *and* the errored cache is then
  written over the good one. Both were observed in a browser.
- **A snapshot is only written if it contains `currentUser`** (`isSnapshotWorthPersisting`).
  Persistence replaces the store wholesale and only successful queries are dehydrated, so a
  session that cannot reach the server would otherwise erase a good offline cache. Measured: one
  reload against an unreachable server left three page entries and no user.
- **`UserProvider` renders whenever cached user data exists.** Previously it returned an empty
  fragment while `/users/me` was loading or errored, which is why phase 1a booted to a white
  screen. It now blanks only while the cache is still restoring or when there is no user data at
  all. Without this the persisted cache is invisible.
- **Restore invalidates active queries** (`onQueryCacheRestored`). The app's defaults are
  `refetchOnMount: false` + `staleTime: 5m`, which was harmless when a reload started from an
  empty cache and would otherwise pin a reloaded tab to yesterday's sidebar forever. The delay
  before invalidating is load-bearing: the callback fires before React has re-rendered, so no
  observer is active yet and `refetchType: "active"` would match nothing.
- **`clearOfflineData()` runs on both session exits** (`handleLogout` and the 401 handler's
  `redirectToLogin`). It stops persistence *first* so a throttled write cannot restore what it
  erases, then drops the dehydrated cache, every `page.*` y-indexeddb database (a pre-existing
  leak that predates this work) and the SW runtime caches. Two deliberate omissions:
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

**The invariant.** *A document that has never completed a real remote sync in this browser is
never editable.* `sync-markers.ts` writes a per-page marker only when the **provider instance's
own** `synced` is true on a `Connected` socket, so the marker means y-indexeddb holds real
server content, never an empty shell — which is precisely what upstream's regression let become
authoritative. `canEditWithoutConnection()` is pure and its sixteen-row truth table is a test.

- The gate reads the provider through `providersRef` **itself**, not `providersRef.current`.
  `PageEditor` is not remounted when the route changes — only the `pageId` prop changes — and
  `page-editor.tsx` never resets `isLocalSynced` / `isRemoteSynced` on that change, so a value
  captured during render can belong to a provider that has since been destroyed. A destroyed
  provider still reports `synced === true`, which would mark a page the server never
  acknowledged. Same reason the hook holds *which page* is known synced rather than a boolean.
- The gate also requires `navigator.onLine === false`. Not in the issue's predicate; added so
  that every behavioural difference is confined to sessions with no network — an ordinary online
  session takes the same path with the switch on as with it off, including the data-loss repro.
  A session that is nominally online but cannot reach the collab server therefore stays
  read-only, exactly as today.
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
  on the boot where there is no network. With it off, nothing is read or written, no marker
  database is created, no banner renders and the title editor behaves exactly as upstream — that
  is what makes the phase safe to merge. Consequence: a page must be opened online **after**
  the switch is turned on before it can be edited offline.
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
