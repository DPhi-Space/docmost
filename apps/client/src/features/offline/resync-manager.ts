/**
 * The background loop that pushes offline edits without the user re-opening
 * anything — OneNote parity, and the point of phase 3.
 *
 * Everything genuinely difficult about it is elsewhere and deliberately so:
 * the per-page verdict is `resync-page.ts`, the provider lifecycle is
 * `resync-session.ts`, the store is `dirty-pages.ts`. What is left here is
 * *when* to run and *how many at a time*, which is where the three exclusion
 * rules live.
 *
 * ## Three exclusions, three different mechanisms
 *
 * 1. **One page at a time, in this tab.** Strictly serial — the loop awaits
 *    each page. Concurrency here would mean several sockets and several
 *    y-indexeddb writers competing on a device that has just proved its network
 *    is unreliable, for no user-visible gain.
 * 2. **One tab at a time, in this browser.** `navigator.locks.request` with
 *    `ifAvailable: true`, so a second tab *declines* rather than queueing — a
 *    queued pass would run straight after the first and re-attempt everything
 *    that first pass had just finished. Browsers without the Web Locks API
 *    (none this app supports, but the check is free) fall through to running:
 *    the pass is idempotent, and refusing to sync is the worse failure.
 * 3. **Never the page on screen.** `open-page-registry.ts`, checked before each
 *    page *and* on every poll while one is in flight, because the user can
 *    navigate into a page mid-push.
 *
 * ## Triggers and backoff
 *
 * Reconnecting (`online`), starting the app, and a slow timer while entries
 * remain. The retry schedule is explicit rather than a formula so it can be
 * read at a glance and asserted in a test. It deviates from the issue's "~60 s
 * with backoff" at the front: the first retry is 5 s, because the common case
 * is a reconnect that flapped and recovering from it in five seconds is worth
 * more than the request it costs. It ends slower than the issue implies, at ten
 * minutes, because a device that has failed six passes is not about to succeed
 * on the seventh.
 *
 * The switch (`offline-editing-settings.ts`, default off) is checked at the top
 * of every pass. With it off nothing here reads the registry, so a browser that
 * never opted in never opens the database — phase 3 keeps phase 2's promise
 * that "off" means "no new behaviour".
 */

import { getCollabToken } from "@/features/auth/services/auth-service";
import type { ICollabToken } from "@/features/auth/types/auth.types";
import { queryClient } from "@/main";
import { isCollabTokenExpired } from "./collab-auth";
import {
  blockedPages,
  clearDirtyPage,
  listDirtyPages,
  markDirtyPageBlocked,
  selectPagesToResync,
} from "./dirty-pages";
import { isOfflineEditingEnabled } from "./offline-editing-settings";
import { offlineDataIsOurs } from "./data-ownership";
import { getOpenPage } from "./open-page-registry";
import { openResyncSession } from "./resync-session";
import {
  resyncPage,
  type PageResyncOutcome,
  type ResyncPageDeps,
} from "./resync-page";
import { setResyncState } from "./resync-state";

/** The Web Locks name; shared by every tab of this origin. */
export const RESYNC_LOCK_NAME = "docmost-offline-resync";

/**
 * Delay before the next pass after one that did not finish everything.
 * Indexed by the number of consecutive incomplete passes, holding at the last.
 */
export const RESYNC_RETRY_SCHEDULE_MS = [
  5_000, 15_000, 60_000, 180_000, 600_000,
];

/** A pass that finished cleanly still re-checks at this interval. */
export const RESYNC_IDLE_INTERVAL_MS = 60_000;

export function nextRetryDelayMs(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(consecutiveFailures, 1) - 1,
    RESYNC_RETRY_SCHEDULE_MS.length - 1,
  );
  return RESYNC_RETRY_SCHEDULE_MS[index];
}

/**
 * Why a pass ran. Only the *cause* differs — a pass that a change of
 * circumstances triggered also retries pages already marked blocked, since a
 * lifted lock or a restored permission can only be discovered by trying again.
 */
export type ResyncTrigger = "boot" | "online" | "periodic" | "manual";

export interface ResyncPassSummary {
  attempted: number;
  synced: number;
  blocked: number;
  /** Pages left for a later pass: transport failures and aborts. */
  deferred: number;
  /** Another tab held the lock; nothing was attempted here. */
  skipped: boolean;
}

export interface ResyncManagerDeps {
  listDirtyPages: typeof listDirtyPages;
  clearDirtyPage: typeof clearDirtyPage;
  markDirtyPageBlocked: typeof markDirtyPageBlocked;
  getOpenPage: () => string | null;
  resyncOnePage: (pageId: string) => Promise<PageResyncOutcome>;
  withLock: <T>(name: string, run: () => Promise<T>) => Promise<T | undefined>;
  isEnabled: () => boolean;
  isOnline: () => boolean;
  /** The offline data on this disk is provably the signed-in user's. */
  offlineDataIsOurs: () => boolean;
  now: () => number;
  publish: typeof setResyncState;
  /** Injected so a test can drive the schedule without real timers. */
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  log: (message: string, detail?: unknown) => void;
  /**
   * The per-page dependency bundle `resyncOnePage` is built from. Present only
   * on the production wiring (`createDefaultResyncDeps`), where it exists so a
   * test can inspect the parts — `shouldAbort` above all — that are otherwise
   * sealed inside a closure.
   */
  perPageDeps?: () => ResyncPageDeps;
}

/**
 * Run the loop over the whole registry once.
 *
 * Exported for tests and for an explicit "retry" affordance; the manager below
 * is what schedules it. Never rejects — a pass that throws would leave the
 * schedule without a next tick.
 */
export async function runResyncPass(
  trigger: ResyncTrigger,
  deps: ResyncManagerDeps,
): Promise<ResyncPassSummary> {
  const empty: ResyncPassSummary = {
    attempted: 0,
    synced: 0,
    blocked: 0,
    deferred: 0,
    skipped: false,
  };

  // Ownership before anything else. Pushing a document this browser cannot
  // prove belongs to the signed-in user would put the previous user's words on
  // the server under the current user's identity — the worst half of the leak
  // this guards. `false` until reconciliation says otherwise.
  if (!deps.offlineDataIsOurs()) return empty;
  if (!deps.isEnabled() || !deps.isOnline()) return empty;

  const result = await deps.withLock(RESYNC_LOCK_NAME, async () => {
    const records = await deps.listDirtyPages();
    const pages = selectPagesToResync(records, {
      openPageId: deps.getOpenPage(),
      // The periodic timer is the only trigger that is not a change of
      // circumstances, and the only one for which retrying a locked page
      // would just burn its timeout again.
      includeBlocked: trigger !== "periodic",
    });

    // The blocked list is published unconditionally after the lock is
    // released, so nothing more is owed here.
    if (pages.length === 0) return empty;

    deps.log(
      `offline resync: ${pages.length} page(s) to push (${trigger})`,
      pages.map((page) => page.pageId),
    );

    const summary: ResyncPassSummary = { ...empty, attempted: pages.length };
    deps.publish({ phase: "syncing", total: pages.length, completed: 0 });

    for (const page of pages) {
      // Re-checked every page: connectivity can die mid-pass, and stopping
      // early is what keeps the failure a deferral rather than a wall of
      // 30-second timeouts.
      if (!deps.isOnline()) {
        // Assigned, not accumulated: pages already deferred one at a time are
        // part of the same remainder.
        summary.deferred = pages.length - summary.synced - summary.blocked;
        break;
      }

      const outcome = await deps.resyncOnePage(page.pageId);
      switch (outcome.status) {
        case "synced":
          await deps.clearDirtyPage(page.pageId);
          summary.synced += 1;
          break;
        case "blocked":
          await deps.markDirtyPageBlocked(page.pageId, outcome.reason);
          summary.blocked += 1;
          deps.log(
            `offline resync: ${page.pageId} refused by the server`,
            outcome.reason,
          );
          break;
        default:
          // `retry` and `aborted` both leave the entry exactly as it was.
          summary.deferred += 1;
          break;
      }
      deps.publish({ completed: summary.synced + summary.blocked + summary.deferred });
    }

    return summary;
  });

  // `undefined` means the lock was held by another tab.
  if (result === undefined) {
    deps.log("offline resync: another tab holds the lock, standing down");
    return { ...empty, skipped: true };
  }

  await publishBlocked(deps);
  deps.publish({
    phase: "idle",
    total: 0,
    completed: 0,
    lastPass:
      result.synced > 0 || result.blocked > 0
        ? { at: deps.now(), synced: result.synced, blocked: result.blocked }
        : null,
  });
  return result;
}

async function publishBlocked(deps: ResyncManagerDeps): Promise<void> {
  deps.publish({ blocked: blockedPages(await deps.listDirtyPages()) });
}

/**
 * A pass is "incomplete" when something is still owed: pages deferred by a
 * transport failure, or a tab that could not take the lock. Pages the server
 * refused are *not* incomplete — they are a finished answer, surfaced in the
 * UI, and retrying them on a backoff schedule would be a treadmill.
 */
export function isPassIncomplete(summary: ResyncPassSummary): boolean {
  return summary.skipped || summary.deferred > 0;
}

export interface ResyncManager {
  /** Run a pass now, ignoring the schedule. */
  trigger(reason: ResyncTrigger): void;
  stop(): void;
}

export function createResyncManager(
  overrides: Partial<ResyncManagerDeps> = {},
): ResyncManager {
  const deps: ResyncManagerDeps = { ...createDefaultResyncDeps(), ...overrides };

  let stopped = false;
  let running = false;
  /** A trigger that arrived while a pass was in flight, to run after it. */
  let queued: ResyncTrigger | null = null;
  let consecutiveIncomplete = 0;
  let timer: number | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (ms: number) => {
    cancelTimer();
    if (stopped) return;
    timer = deps.setTimer(() => {
      timer = null;
      void run("periodic");
    }, ms);
  };

  const run = async (trigger: ResyncTrigger): Promise<void> => {
    if (stopped) return;
    if (running) {
      // Never two passes at once, even across triggers: `online` firing during
      // a periodic pass must not open a second set of providers.
      queued = trigger;
      return;
    }
    running = true;
    cancelTimer();
    try {
      const summary = await runResyncPass(trigger, deps);
      // A pass triggered by a *change of circumstances* restarts the backoff
      // from the beginning, so a user who reconnects is not still serving a
      // ten-minute delay accumulated inside a tunnel. It does not skip the
      // backoff — an `online` pass that still fails is retried in 5 s, not 60.
      const previous =
        trigger === "online" || trigger === "manual" ? 0 : consecutiveIncomplete;
      consecutiveIncomplete = isPassIncomplete(summary) ? previous + 1 : 0;
      schedule(
        consecutiveIncomplete > 0
          ? nextRetryDelayMs(consecutiveIncomplete)
          : RESYNC_IDLE_INTERVAL_MS,
      );
    } catch (error) {
      // A pass must never be able to end the schedule.
      deps.log("offline resync: pass failed", error);
      consecutiveIncomplete += 1;
      schedule(nextRetryDelayMs(consecutiveIncomplete));
    } finally {
      running = false;
      const next = queued;
      queued = null;
      if (next && !stopped) void run(next);
    }
  };

  const onOnline = () => void run("online");
  globalThis.addEventListener?.("online", onOnline);

  void run("boot");

  return {
    trigger: (reason) => void run(reason),
    stop: () => {
      stopped = true;
      cancelTimer();
      globalThis.removeEventListener?.("online", onOnline);
    },
  };
}

/**
 * A collaboration token, reusing the editor's cached one.
 *
 * `["collab-token"]` is the exact key `useCollabToken` writes, so a session
 * with an open editor pays nothing here, and a refresh made here is picked up
 * by the editor. The token is a 24 h JWT; `isCollabTokenExpired` is the
 * non-throwing reader phase 2 introduced, and answers "expired" for a missing
 * or unreadable token, which routes into the refetch below.
 */
async function fetchCollabToken(): Promise<string | undefined> {
  const cached = queryClient.getQueryData<ICollabToken>(["collab-token"]);
  if (cached?.token && !isCollabTokenExpired(cached.token)) return cached.token;
  try {
    const fresh = await getCollabToken();
    if (fresh?.token) queryClient.setQueryData(["collab-token"], fresh);
    return fresh?.token;
  } catch {
    // Offline, or the API is down: the pass defers and the schedule retries.
    return undefined;
  }
}

/**
 * Cross-tab exclusion.
 *
 * `ifAvailable: true` makes a second tab decline instead of queueing behind the
 * first; a queued pass would start the moment the first finished and re-attempt
 * work that had just been done. The callback receiving `null` is exactly that
 * decline, and is reported as `undefined` so the caller can tell it apart from
 * a pass that ran and found nothing.
 */
export async function withWebLock<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(name, { ifAvailable: true }, async (lock) =>
    lock ? run() : undefined,
  ) as Promise<T | undefined>;
}

/**
 * The production wiring, exported so it can be *tested* rather than merely
 * written.
 *
 * Every test in this file that supplies its own dependencies proves something
 * about the loop and nothing about how the loop is connected to the app. That
 * gap is real: replacing `isEnabled` with `() => true` here would bypass the
 * kill switch, and replacing either open-page hook with `() => null` would let
 * the manager open a second provider on the page the user is reading — and a
 * suite that never touches this function stays green through both.
 */
export function createDefaultResyncDeps(): ResyncManagerDeps {
  const perPageDeps = (): ResyncPageDeps => ({
    openSession: openResyncSession,
    getToken: fetchCollabToken,
    isTokenExpired: (token) => isCollabTokenExpired(token),
    // Re-read on every poll, not captured: the user can navigate into a page
    // while it is being pushed.
    shouldAbort: (id) => getOpenPage() === id,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });

  return {
    listDirtyPages,
    clearDirtyPage,
    markDirtyPageBlocked,
    getOpenPage,
    resyncOnePage: (pageId) => resyncPage(pageId, perPageDeps()),
    /** Exposed for the wiring test; not part of `ResyncManagerDeps`. */
    perPageDeps,
    withLock: withWebLock,
    isEnabled: isOfflineEditingEnabled,
    isOnline: () => globalThis.navigator?.onLine !== false,
    offlineDataIsOurs,
    now: () => Date.now(),
    publish: setResyncState,
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimer: (handle) => globalThis.clearTimeout(handle),
    log: (message, detail) => {
      // Deliberately `console.info` and deliberately unconditional: the
      // multi-tab and per-page behaviour of this loop is only observable in a
      // real browser, and #20 asks for it to be verifiable by logging.
      if (detail === undefined) console.info(`[docmost] ${message}`);
      else console.info(`[docmost] ${message}`, detail);
    },
  };
}
