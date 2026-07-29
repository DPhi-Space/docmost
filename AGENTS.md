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
- `spike: vim keybindings` — client-only modal editing in the page editor, off by default
  behind a user preference (see **Vim keybindings** below). Server delta is one DTO field and one
  `updatePreference` branch.
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

## Vim keybindings (`features/editor/extensions/vim-mode.ts`, spike)

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

# end-to-end: rebuild image + boot, then run the repro
docker compose -f docker-compose.local.yml build docmost
docker compose -f docker-compose.local.yml up -d    # app on http://localhost:3000
```

**Data-loss reproduction** (must NOT lose content): create two pages with distinct content
(e.g. a D2 block and an Excalidraw diagram), switch rapidly back and forth many times, then
reload. Content must survive. A poll of `select octet_length(ydoc), length(text_content) from
pages` should never show a populated page collapse to ~100–500 bytes with `text=0`.

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
