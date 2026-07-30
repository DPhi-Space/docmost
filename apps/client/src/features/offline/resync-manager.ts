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
  readOfflineDataOwner,
  selectPagesToResync,
  type OfflineDataOwner,
} from "./dirty-pages";
import { isOfflineEditingEnabled } from "./offline-editing-settings";
import {
  getSettledUserId,
  offlineDataIsOurs,
  subscribeOwnership,
} from "./data-ownership";
import { getOpenPage } from "./open-page-registry";
import { isServerReachable, subscribeReachability } from "./reachability";
import { openResyncSession } from "./resync-session";
import {
  resyncPage,
  type PageResyncOutcome,
  type ResyncPageDeps,
} from "./resync-page";
import { setResyncState } from "./resync-state";
import {
  EMPTY_UPLOAD_SUMMARY,
  createDefaultUploadReplayDeps,
  publishUploadState,
  replayUploadPass,
  type UploadReplaySummary,
} from "./upload-replay";
import { listUploadRecords, type UploadOutboxRecord } from "./upload-outbox";

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
  /** Phase 4: the upload-outbox half of the pass. */
  uploads: UploadReplaySummary;
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
  /**
   * Notifies when the answer to `isOnline` changes; returns an unsubscribe.
   *
   * This used to be a bare `window.addEventListener("online")` inside the
   * manager, which is dead code on the failure this whole change is about: where
   * `navigator.onLine` is stuck at `true` (a VPN interface up after Wi-Fi is
   * switched off) the property never transitions, so neither event ever fires and
   * the *reconnect* trigger — the one that matters most, since it is the moment
   * offline edits can finally be pushed — never fired either. Recovery was left
   * to the periodic timer, up to ten minutes away.
   */
  subscribeOnline: (listener: () => void) => () => void;
  /** The offline data on this disk is provably the signed-in user's. */
  offlineDataIsOurs: () => boolean;
  /** Notifies when the answer above changes; returns an unsubscribe. */
  subscribeOwnership: (listener: () => void) => () => void;
  /** The owner stamp, read from the same store as the work it describes. */
  readOfflineDataOwner: () => Promise<OfflineDataOwner>;
  /**
   * Phase 4: replay the upload outbox. Runs inside the same lock and behind
   * the same ownership gates as the page loop, after it — the pages carry the
   * document structure the uploads' node rewrites are aimed at.
   * `includeBlocked` follows the same trigger rule as the pages.
   */
  replayUploads: (includeBlocked: boolean) => Promise<UploadReplaySummary>;
  /** The outbox contents, for publishing state when no pass can run. */
  listUploadRecords: typeof listUploadRecords;
  /** Publishes the outbox-derived slice of the pill's state. */
  publishUploadRecords: (records: readonly UploadOutboxRecord[]) => void;
  /** The identity the current ownership verdict was reached for. */
  currentUserId: () => string | null;
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
    uploads: EMPTY_UPLOAD_SUMMARY,
  };

  // Ownership before anything else. Pushing a document this browser cannot
  // prove belongs to the signed-in user would put the previous user's words on
  // the server under the current user's identity — the worst half of the leak
  // this guards. `false` until reconciliation says otherwise.
  if (!deps.offlineDataIsOurs()) return empty;
  if (!deps.isEnabled()) return empty;
  if (!deps.isOnline()) {
    /**
     * No pass can run, but the standing UI must still reflect the queue.
     * After a reload-while-offline nothing else ever publishes: enqueue-time
     * publishing happened in the previous document, and the replay pass — the
     * only other publisher — is exactly what cannot run here. Without this,
     * the "N uploads waiting for connection" pill and the blocked list stayed
     * empty over a populated outbox until the first online pass (gap #4 of
     * the #21 review). Ownership is already settled above, so this discloses
     * nothing that is not the signed-in user's.
     */
    await publishQueuedWork(deps);
    return empty;
  }

  const result = await deps.withLock(RESYNC_LOCK_NAME, async () => {
    /**
     * Ownership again, this time read from the **same store as the records**.
     *
     * `offlineDataIsOurs()` above is a cached verdict, and a cached verdict can
     * be out of step with the disk: a browser run caught a pass pushing the
     * previous user's document because the flag had been opened while the erase
     * that followed it was still in flight. The stamp lives beside the records
     * in one IndexedDB store, so it cannot disagree with them.
     */
    const owner = await deps.readOfflineDataOwner();
    if (
      owner.status === "unreadable" ||
      (owner.status === "known" && owner.ownerUserId !== deps.currentUserId())
    ) {
      deps.log("offline resync: registry is not this user's, standing down");
      return empty;
    }

    // The periodic timer is the only trigger that is not a change of
    // circumstances, and the only one for which retrying a locked page (or a
    // refused upload) would just burn its timeout again.
    const includeBlocked = trigger !== "periodic";

    const records = await deps.listDirtyPages();
    const pages = selectPagesToResync(records, {
      openPageId: deps.getOpenPage(),
      includeBlocked,
    });

    const summary: ResyncPassSummary = { ...empty, attempted: pages.length };

    if (pages.length > 0) {
      deps.log(
        `offline resync: ${pages.length} page(s) to push (${trigger})`,
        pages.map((page) => page.pageId),
      );

      deps.publish({ phase: "syncing", total: pages.length, completed: 0 });

      for (const page of pages) {
        // Re-checked every page: connectivity can die mid-pass, and stopping
        // early is what keeps the failure a deferral rather than a wall of
        // 30-second timeouts.
        if (!deps.isOnline()) {
          // Assigned, not accumulated: pages already deferred one at a time
          // are part of the same remainder.
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
            deps.log(
              `offline resync: ${page.pageId} deferred`,
              outcome.status === "retry" ? outcome.reason : outcome.status,
            );
            break;
        }
        deps.publish({
          completed: summary.synced + summary.blocked + summary.deferred,
        });
      }
    }

    /**
     * Phase 4: uploads after pages, under the same lock. After, because the
     * page loop pushes the document structure whose nodes the uploads' attr
     * rewrites are aimed at; and inside the lock so two tabs can never replay
     * the same blob concurrently. A failure here must not cost the page half
     * of the pass its summary.
     */
    try {
      summary.uploads = await deps.replayUploads(includeBlocked);
    } catch (error) {
      deps.log("offline uploads: replay failed", error);
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
      result.synced > 0 || result.blocked > 0 || result.uploads.uploaded > 0
        ? {
            at: deps.now(),
            synced: result.synced,
            blocked: result.blocked,
            uploadedFiles: result.uploads.uploaded,
          }
        : null,
  });
  return result;
}

async function publishBlocked(deps: ResyncManagerDeps): Promise<void> {
  deps.publish({ blocked: blockedPages(await deps.listDirtyPages()) });
}

/** Blocked pages + outbox counts, for sessions where no pass can run. */
async function publishQueuedWork(deps: ResyncManagerDeps): Promise<void> {
  try {
    await publishBlocked(deps);
    deps.publishUploadRecords(await deps.listUploadRecords());
  } catch {
    // Presentation only; the stores themselves are untouched.
  }
}

/**
 * A pass is "incomplete" when something is still owed: pages deferred by a
 * transport failure, or a tab that could not take the lock. Pages the server
 * refused are *not* incomplete — they are a finished answer, surfaced in the
 * UI, and retrying them on a backoff schedule would be a treadmill.
 */
export function isPassIncomplete(summary: ResyncPassSummary): boolean {
  return (
    summary.skipped || summary.deferred > 0 || summary.uploads.deferred > 0
  );
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

  /**
   * The verdict is only published when it *changes*, so "notified while online"
   * is the reconnect. Re-read rather than trusted from the notification: the
   * store's readers consult `navigator.onLine` live, so the answer can be more
   * pessimistic than the change that woke us.
   */
  const unsubscribeOnline = deps.subscribeOnline(() => {
    if (deps.isOnline()) void run("online");
  });

  /**
   * Ownership is a hard gate, and it is settled asynchronously — the boot pass
   * below almost always runs before the answer is known and returns empty. Run
   * again the moment it becomes known, or the next attempt is a whole idle
   * interval away.
   */
  const unsubscribeOwnership = deps.subscribeOwnership(() => {
    if (deps.offlineDataIsOurs()) void run("manual");
  });

  void run("boot");

  return {
    trigger: (reason) => void run(reason),
    stop: () => {
      stopped = true;
      cancelTimer();
      unsubscribeOwnership();
      unsubscribeOnline();
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
    replayUploads: (includeBlocked) =>
      replayUploadPass(includeBlocked, {
        ...createDefaultUploadReplayDeps(),
        // The same mid-pass connectivity check the page loop uses.
        isOnline: isServerReachable,
      }),
    listUploadRecords,
    publishUploadRecords: publishUploadState,
    withLock: withWebLock,
    isEnabled: isOfflineEditingEnabled,
    isOnline: isServerReachable,
    subscribeOnline: subscribeReachability,
    offlineDataIsOurs,
    subscribeOwnership,
    readOfflineDataOwner,
    currentUserId: getSettledUserId,
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
