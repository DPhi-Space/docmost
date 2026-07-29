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
- other commits not mentioned here

None of these touch the collaboration/persistence/page-load path — that's what keeps upstream
adoption low-conflict.

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

## Offline/PWA (`apps/client/src/features/offline`, issue #17)

Phase 1a of the offline plan (tracking issue #22): a service worker that makes the **app shell**
(JS/CSS/fonts/icons/locales) load with no network. Data persistence, offline editing and
background sync are later phases and are **not** in here. Nothing in this feature touches
`apps/server/` or the collaboration/persistence path.

**Hand-rolled, not `vite-plugin-pwa`.** `vite-plugin-pwa` 1.3.0 does install and build fine on
this base (its peer range includes `vite ^8`, and `injectManifest` works under rolldown — both
verified). It was still not adopted, for three reasons: workbox precaching is **all-or-nothing**
over a filename glob, which here means a ~20 MB manifest dominated by the 8 MB D2 WASM chunk, so
one failed request leaves the worker permanently un-activated and the app with *no* offline
support; the glob sees only content-hashed file names, whereas "the mermaid and D2 chunks" can
only be identified reliably from the **module graph**; and it costs +55 packages / +712 lockfile
lines in a repo where the lockfile is load-bearing. The replacement adds **zero dependencies**.

- `build/precache-manifest.ts` — pure classification of the finished bundle into `core`
  (required, fetched during `install`; ~4.6 MB: entry + its static import closure + their CSS +
  woff2 fonts + icons + `manifest.json`) and `optional` (best effort, warmed after `activate`;
  ~10.5 MB: mermaid + D2, matched by **module id**, not by file name). Splitting the two is the
  whole point: a flaky network must not be able to prevent activation.
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
2. Open a page containing a mermaid block and one containing a D2 block.
3. DevTools → Network → Offline, reload: the shell boots (no blank page, no chunk-load errors)
   and both diagram previews still render.
4. DevTools → Network → Online: the `/collab` and `/socket.io` WebSockets reconnect normally
   (the worker must never appear in their request chain).
5. Deploy a newer build, then reload an old tab: the "A new version is available" prompt
   appears, "Reload" activates the waiting worker, and `docmost-offline-precache-*` caches from
   the previous build are gone afterwards. The tab must **not** reload on its own.

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
