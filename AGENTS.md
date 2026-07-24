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

None of these touch the collaboration/persistence/page-load path — that's what keeps upstream
adoption low-conflict.

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
