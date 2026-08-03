/**
 * The per-build identifier behind the offline query-cache buster
 * (`features/offline/persistence.ts`). The package version cannot serve: this
 * fork pins the upstream base, so it reads 0.95.0 on every fork build, and a
 * version-only buster never discards anything — which is how a poisoned store
 * survived every deploy.
 *
 * Pure decision over injected sources (sibling convention of this directory:
 * build logic stays vitest-reachable; `vite.config.ts` only supplies the real
 * sources). Precedence, and why each step exists:
 *
 * 1. the `BUILD_ID` env var — Docker builds have no `.git` in their context
 *    (see `.dockerignore`), so CI passes the commit SHA in as a build arg;
 * 2. the git short SHA — local `vite build` and the dev server;
 * 3. the build timestamp — Docker builds *without* the arg (notably
 *    `docker-compose.local.yml`). A timestamp over-approximates "the build
 *    changed", which is safe: the cost of a false rotation is one refetch
 *    cycle, the cost of a missed one is a stale store surviving a deploy. A
 *    cached Docker layer skips the rebuild entirely and keeps its old id,
 *    which is exactly right — identical artifacts, identical buster.
 */
export interface BuildIdSources {
  /** `process.env.BUILD_ID`; empty string means "not provided". */
  env: string | undefined;
  /** Short git SHA, or null where git or `.git` is unavailable. */
  gitShortSha: () => string | null;
  /** Build-time clock, for the last-resort rotation. */
  timestamp: () => number;
}

export function resolveBuildId(sources: BuildIdSources): string {
  if (sources.env) return sources.env;
  const sha = sources.gitShortSha();
  if (sha) return sha;
  return `t${sources.timestamp().toString(36)}`;
}
