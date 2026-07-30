import { beforeEach, describe, expect, it, vi } from "vitest";

// `resync-manager` reaches the real session (Yjs + Hocuspocus) and the app's
// query client through its default dependencies. Every test below injects its
// own, so the modules are stubbed to keep the suite about the loop.
vi.mock("./resync-session", () => ({ openResyncSession: vi.fn() }));
vi.mock("@/main", () => ({ queryClient: { getQueryData: () => undefined } }));
vi.mock("@/features/auth/services/auth-service", () => ({
  getCollabToken: vi.fn(),
}));

import {
  isPassIncomplete,
  nextRetryDelayMs,
  RESYNC_IDLE_INTERVAL_MS,
  RESYNC_RETRY_SCHEDULE_MS,
  runResyncPass,
  createResyncManager,
  type ResyncManagerDeps,
  type ResyncPassSummary,
} from "./resync-manager";
import type { DirtyPageRecord } from "./dirty-pages";
import type { PageResyncOutcome } from "./resync-page";

const record = (
  pageId: string,
  dirtySince = 1,
  blocked?: DirtyPageRecord["blocked"],
): DirtyPageRecord => ({ pageId, dirtySince, updatedAt: dirtySince, blocked });

interface Harness {
  deps: ResyncManagerDeps;
  registry: Map<string, DirtyPageRecord>;
  attempted: string[];
  published: Array<Record<string, unknown>>;
  timers: Array<{ fn: () => void; ms: number }>;
  /** Publish a change of connectivity, as `reachability.ts` does. */
  announceOnline: () => void;
  /** Whether the manager is still listening for one. */
  listening: () => boolean;
}

function harness(
  records: DirtyPageRecord[],
  outcomes: Record<string, PageResyncOutcome> = {},
  overrides: Partial<ResyncManagerDeps> = {},
): Harness {
  const registry = new Map(records.map((r) => [r.pageId, r]));
  const attempted: string[] = [];
  const published: Array<Record<string, unknown>> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const onlineListeners = new Set<() => void>();

  const deps: ResyncManagerDeps = {
    listDirtyPages: async () => [...registry.values()],
    clearDirtyPage: async (pageId) => void registry.delete(pageId),
    markDirtyPageBlocked: async (pageId, reason) => {
      const existing = registry.get(pageId);
      if (existing) registry.set(pageId, { ...existing, blocked: { reason, at: 1 } });
    },
    getOpenPage: () => null,
    resyncOnePage: async (pageId) => {
      attempted.push(pageId);
      return outcomes[pageId] ?? { status: "synced" };
    },
    withLock: async (_name, run) => run(),
    isEnabled: () => true,
    isOnline: () => true,
    subscribeOnline: (listener) => {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
    offlineDataIsOurs: () => true,
    subscribeOwnership: () => () => {},
    readOfflineDataOwner: async () => ({ status: 'none' }) as const,
    replayUploads: async () => ({
      attempted: 0,
      uploaded: 0,
      blocked: 0,
      deferred: 0,
    }),
    listUploadRecords: async () => [],
    publishUploadRecords: () => {},
    currentUserId: () => 'user-1',
    now: () => 1_000,
    publish: (next) => void published.push(next as Record<string, unknown>),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    log: () => {},
    ...overrides,
  };

  return {
    deps,
    registry,
    attempted,
    published,
    timers,
    announceOnline: () => {
      for (const listener of [...onlineListeners]) listener();
    },
    listening: () => onlineListeners.size > 0,
  };
}

describe("nextRetryDelayMs", () => {
  it("walks the schedule and then holds at its last step", () => {
    expect(nextRetryDelayMs(1)).toBe(RESYNC_RETRY_SCHEDULE_MS[0]);
    expect(nextRetryDelayMs(3)).toBe(RESYNC_RETRY_SCHEDULE_MS[2]);
    expect(nextRetryDelayMs(RESYNC_RETRY_SCHEDULE_MS.length)).toBe(600_000);
    expect(nextRetryDelayMs(99)).toBe(600_000);
  });

  it("treats a zeroth failure as the first step rather than an index error", () => {
    expect(nextRetryDelayMs(0)).toBe(RESYNC_RETRY_SCHEDULE_MS[0]);
  });

  it("is the documented schedule, stated here rather than read back", () => {
    // Asserting that the module's own array is sorted proves nothing about the
    // schedule anyone actually experiences. These are the numbers: a fast first
    // retry for a reconnect that flapped, a ten-minute ceiling for a device
    // that has failed five passes.
    expect([1, 2, 3, 4, 5, 6, 20].map(nextRetryDelayMs)).toEqual([
      5_000, 15_000, 60_000, 180_000, 600_000, 600_000, 600_000,
    ]);
  });
});

describe("isPassIncomplete", () => {
  const summary = (over: Partial<ResyncPassSummary>): ResyncPassSummary => ({
    attempted: 0,
    synced: 0,
    blocked: 0,
    deferred: 0,
    skipped: false,
    uploads: { attempted: 0, uploaded: 0, blocked: 0, deferred: 0 },
    ...over,
  });

  it("is incomplete when pages were deferred", () => {
    expect(isPassIncomplete(summary({ deferred: 1 }))).toBe(true);
  });

  it("is incomplete when uploads were deferred", () => {
    expect(
      isPassIncomplete(
        summary({
          uploads: { attempted: 1, uploaded: 0, blocked: 0, deferred: 1 },
        }),
      ),
    ).toBe(true);
  });

  it("is complete when the only upload failures were refusals", () => {
    expect(
      isPassIncomplete(
        summary({
          uploads: { attempted: 1, uploaded: 0, blocked: 1, deferred: 0 },
        }),
      ),
    ).toBe(false);
  });

  it("is incomplete when another tab held the lock", () => {
    expect(isPassIncomplete(summary({ skipped: true }))).toBe(true);
  });

  it("is complete when the only failures were refusals", () => {
    // A refusal is a finished answer shown in the UI; backing off over it
    // would retry a locked page forever.
    expect(isPassIncomplete(summary({ synced: 2, blocked: 1 }))).toBe(false);
  });
});

describe("runResyncPass", () => {
  it("pushes every dirty page and forgets the ones that landed", async () => {
    const h = harness([record("a", 1), record("b", 2), record("c", 3)]);

    const summary = await runResyncPass("online", h.deps);

    expect(h.attempted).toEqual(["a", "b", "c"]);
    expect(summary).toMatchObject({ attempted: 3, synced: 3, deferred: 0 });
    expect(h.registry.size).toBe(0);
  });

  it("keeps a refused page, marked, and still pushes the rest", async () => {
    const h = harness([record("a", 1), record("locked", 2), record("c", 3)], {
      locked: { status: "blocked", reason: "not-accepted" },
    });

    const summary = await runResyncPass("online", h.deps);

    expect(summary).toMatchObject({ synced: 2, blocked: 1 });
    expect([...h.registry.keys()]).toEqual(["locked"]);
    expect(h.registry.get("locked")?.blocked?.reason).toBe("not-accepted");
  });

  it("leaves a page a transport failure deferred exactly as it was", async () => {
    const h = harness([record("a")], {
      a: { status: "retry", reason: "no-handshake" },
    });

    const summary = await runResyncPass("online", h.deps);

    expect(summary).toMatchObject({ deferred: 1, blocked: 0 });
    expect(h.registry.get("a")).toEqual(record("a"));
  });

  it("never opens a session for the page the editor owns", async () => {
    const h = harness([record("open"), record("other")], {}, {
      getOpenPage: () => "open",
    });

    await runResyncPass("online", h.deps);

    expect(h.attempted).toEqual(["other"]);
    expect(h.registry.has("open")).toBe(true);
  });

  it("stops early when connectivity dies mid-pass", async () => {
    let online = true;
    const h = harness([record("a", 1), record("b", 2), record("c", 3)], {}, {
      isOnline: () => online,
      resyncOnePage: async (pageId) => {
        online = false;
        return { status: "synced" };
      },
    });

    const summary = await runResyncPass("online", h.deps);

    expect(summary.synced).toBe(1);
    expect(summary.deferred).toBe(2);
  });

  it("retries blocked entries on a trigger, but not on the periodic timer", async () => {
    const blocked = record("locked", 1, { reason: "not-accepted", at: 1 });

    const onReconnect = harness([blocked]);
    await runResyncPass("online", onReconnect.deps);
    expect(onReconnect.attempted).toEqual(["locked"]);

    const onTimer = harness([blocked]);
    await runResyncPass("periodic", onTimer.deps);
    expect(onTimer.attempted).toEqual([]);
  });

  it("refuses when the registry's own stamp names another user", async () => {
    // The check that survives a stale verdict: a browser run caught a pass
    // pushing the previous user's document because the cached boolean had been
    // opened while the erase behind it was still in flight.
    const h = harness([record("a")], {}, {
      readOfflineDataOwner: async () => ({
        status: "known",
        ownerUserId: "someone-else",
      }),
      currentUserId: () => "user-1",
    });

    const summary = await runResyncPass("online", h.deps);

    expect(h.attempted).toEqual([]);
    expect(summary.attempted).toBe(0);
  });

  it("pushes when the registry's stamp is this user's", async () => {
    const h = harness([record("a")], {}, {
      readOfflineDataOwner: async () => ({
        status: "known",
        ownerUserId: "user-1",
      }),
      currentUserId: () => "user-1",
    });

    await runResyncPass("online", h.deps);

    expect(h.attempted).toEqual(["a"]);
  });

  it("refuses when the owner stamp cannot be read", async () => {
    const h = harness([record("a")], {}, {
      readOfflineDataOwner: async () => ({ status: "unreadable" }),
    });

    await runResyncPass("online", h.deps);

    expect(h.attempted).toEqual([]);
  });

  it("refuses to push anything the browser cannot prove is ours", async () => {
    // The worst half of the cross-account leak: pushing a previous user's
    // preserved document puts their words on the server under the current
    // user's identity, and the audit trail attributes them to the wrong person.
    const h = harness([record("a")], {}, { offlineDataIsOurs: () => false });

    const summary = await runResyncPass("online", h.deps);

    expect(h.attempted).toEqual([]);
    expect(h.published).toEqual([]);
    expect(summary.attempted).toBe(0);
  });

  it("refuses before it even consults the switch or the network", async () => {
    // Ownership is the first gate, so a browser holding foreign data cannot
    // reach the registry however the other conditions happen to be set.
    const reads: string[] = [];
    const h = harness([record("a")], {}, {
      offlineDataIsOurs: () => false,
      isEnabled: () => {
        reads.push("enabled");
        return true;
      },
      isOnline: () => {
        reads.push("online");
        return true;
      },
    });

    await runResyncPass("online", h.deps);

    expect(reads).toEqual([]);
  });

  it("does nothing at all while the offline-editing switch is off", async () => {
    const h = harness([record("a")], {}, { isEnabled: () => false });

    await runResyncPass("boot", h.deps);

    expect(h.attempted).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it("does nothing while the browser reports no network", async () => {
    const h = harness([record("a")], {}, { isOnline: () => false });

    await runResyncPass("boot", h.deps);

    expect(h.attempted).toEqual([]);
  });

  it("gap #4 regression: an offline boot still publishes the queued work", async () => {
    // Reload-while-offline: the outbox holds records and the registry holds a
    // blocked page, but no pass can run — enqueue-time publishing died with
    // the previous document, so this early return is the only publisher left.
    // The pill used to stay empty over a populated outbox until the first
    // online pass.
    const uploadRecords = [{ attachmentId: "att-1", status: "pending" }];
    const publishedUploads: unknown[] = [];
    const h = harness(
      [{ ...record("a"), blocked: { reason: "not-accepted", at: 1 } }],
      {},
      {
        isOnline: () => false,
        listUploadRecords: async () => uploadRecords as never,
        publishUploadRecords: (records) => void publishedUploads.push(records),
      },
    );

    await runResyncPass("boot", h.deps);

    expect(h.attempted).toEqual([]);
    expect(publishedUploads).toEqual([uploadRecords]);
    expect(h.published).toContainEqual(
      expect.objectContaining({
        blocked: [expect.objectContaining({ pageId: "a" })],
      }),
    );
  });

  it("gap #4: publishes nothing before ownership settles (a stranger's counts stay private)", async () => {
    const publishedUploads: unknown[] = [];
    const h = harness([record("a")], {}, {
      isOnline: () => false,
      offlineDataIsOurs: () => false,
      publishUploadRecords: (records) => void publishedUploads.push(records),
    });

    await runResyncPass("boot", h.deps);

    expect(publishedUploads).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it("stands down without attempting anything when another tab holds the lock", async () => {
    const h = harness([record("a")], {}, {
      withLock: async () => undefined,
    });

    const summary = await runResyncPass("online", h.deps);

    expect(summary.skipped).toBe(true);
    expect(h.attempted).toEqual([]);
  });

  it("publishes progress and then the pass result", async () => {
    const h = harness([record("a", 1), record("b", 2)]);

    await runResyncPass("online", h.deps);

    expect(h.published[0]).toMatchObject({ phase: "syncing", total: 2, completed: 0 });
    expect(h.published.at(-1)).toMatchObject({
      phase: "idle",
      lastPass: { synced: 2, blocked: 0 },
    });
  });

  it("reports no pass result when there was nothing to push", async () => {
    const h = harness([]);

    await runResyncPass("boot", h.deps);

    expect(h.published.at(-1)).toMatchObject({ phase: "idle", lastPass: null });
  });

  it("replays the upload outbox even when no page is dirty", async () => {
    // An Excalidraw re-save queues an upload without touching the ydoc, so a
    // pass with zero dirty pages still owes the outbox a replay.
    const calls: boolean[] = [];
    const h = harness([], {}, {
      replayUploads: async (includeBlocked) => {
        calls.push(includeBlocked);
        return { attempted: 1, uploaded: 1, blocked: 0, deferred: 0 };
      },
    });

    const summary = await runResyncPass("online", h.deps);

    expect(calls).toEqual([true]);
    expect(summary.uploads.uploaded).toBe(1);
    expect(h.published.at(-1)).toMatchObject({
      lastPass: { synced: 0, uploadedFiles: 1 },
    });
  });

  it("passes the periodic-blocked rule through to the upload replay", async () => {
    const calls: boolean[] = [];
    const h = harness([], {}, {
      replayUploads: async (includeBlocked) => {
        calls.push(includeBlocked);
        return { attempted: 0, uploaded: 0, blocked: 0, deferred: 0 };
      },
    });

    await runResyncPass("periodic", h.deps);
    await runResyncPass("manual", h.deps);

    expect(calls).toEqual([false, true]);
  });

  it("never replays uploads when ownership refuses", async () => {
    // The same gate as pages: pushing an unowned blob would upload the
    // previous user's file under the current session's cookie.
    let replayed = 0;
    const h = harness([], {}, {
      offlineDataIsOurs: () => false,
      replayUploads: async () => {
        replayed += 1;
        return { attempted: 0, uploaded: 0, blocked: 0, deferred: 0 };
      },
    });

    await runResyncPass("online", h.deps);

    expect(replayed).toBe(0);
  });

  it("keeps the page summary when the upload replay throws", async () => {
    const h = harness([record("a")], {}, {
      replayUploads: async () => {
        throw new Error("outbox unreadable");
      },
    });

    const summary = await runResyncPass("online", h.deps);

    expect(summary.synced).toBe(1);
    expect(summary.uploads.attempted).toBe(0);
  });

  it("publishes the blocked list the UI lists", async () => {
    const h = harness([record("a"), record("locked", 2)], {
      locked: { status: "blocked", reason: "no-access" },
    });

    await runResyncPass("online", h.deps);

    const blocked = h.published
      .map((p) => p.blocked as DirtyPageRecord[] | undefined)
      .filter(Boolean)
      .at(-1);
    expect(blocked?.map((r) => r.pageId)).toEqual(["locked"]);
  });
});

describe("createResyncManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a pass at boot and schedules the idle re-check", async () => {
    const h = harness([record("a")]);

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    manager.stop();

    expect(h.attempted).toEqual(["a"]);
    expect(h.timers[0].ms).toBe(RESYNC_IDLE_INTERVAL_MS);
  });

  it("backs off after a pass that left work owed", async () => {
    const h = harness([record("a")], {
      a: { status: "retry", reason: "no-handshake" },
    });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    manager.stop();

    expect(h.timers[0].ms).toBe(RESYNC_RETRY_SCHEDULE_MS[0]);
  });

  it("lengthens the backoff over consecutive incomplete passes", async () => {
    const h = harness([record("a")], {
      a: { status: "retry", reason: "no-handshake" },
    });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    // Fire the scheduled retry, which fails the same way.
    h.timers[0].fn();
    await vi.waitFor(() => expect(h.timers.length).toBe(2));
    manager.stop();

    expect(h.timers.map((t) => t.ms)).toEqual([
      RESYNC_RETRY_SCHEDULE_MS[0],
      RESYNC_RETRY_SCHEDULE_MS[1],
    ]);
  });

  it("resets the backoff when the server becomes reachable again", async () => {
    const h = harness([record("a")], {
      a: { status: "retry", reason: "no-handshake" },
    });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    h.timers[0].fn();
    await vi.waitFor(() => expect(h.timers.length).toBe(2));

    h.announceOnline();
    await vi.waitFor(() => expect(h.timers.length).toBe(3));
    manager.stop();

    expect(h.timers[2].ms).toBe(RESYNC_RETRY_SCHEDULE_MS[0]);
  });

  it("does not run a pass when the change of verdict is to unreachable", async () => {
    // The store publishes every *change*, in both directions. Only reconnecting
    // is a reason to try again; the other direction would open providers on a
    // dead network and burn a timeout per page.
    let online = true;
    const h = harness([record("a")], {}, { isOnline: () => online });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.attempted.length).toBe(1));
    online = false;
    h.announceOnline();
    await Promise.resolve();
    manager.stop();

    expect(h.attempted.length).toBe(1);
  });

  it("never runs two passes at once, and runs the queued trigger afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness([record("a")], {}, {
      resyncOnePage: async (pageId) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return { status: "synced" };
      },
    });

    const manager = createResyncManager(h.deps);
    manager.trigger("manual");
    manager.trigger("manual");
    release();
    await vi.waitFor(() => expect(h.timers.length).toBeGreaterThan(0));
    manager.stop();

    expect(maxInFlight).toBe(1);
  });

  it("runs again the moment ownership is settled", async () => {
    // The boot pass fires before reconciliation has asked the server who is
    // signed in, so it returns empty. Without this nudge the next attempt is a
    // whole idle interval away and a recovered session appears to do nothing.
    let ours = false;
    let notify: (() => void) | null = null;
    const h = harness([record("a")], {}, {
      offlineDataIsOurs: () => ours,
      subscribeOwnership: (listener) => {
        notify = listener;
        return () => {
          notify = null;
        };
      },
    });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBeGreaterThan(0));
    expect(h.attempted).toEqual([]);

    ours = true;
    notify!();
    await vi.waitFor(() => expect(h.attempted).toEqual(["a"]));
    manager.stop();
  });

  it("stops listening for ownership once stopped", async () => {
    let unsubscribed = false;
    const h = harness([record("a")], {}, {
      subscribeOwnership: () => () => {
        unsubscribed = true;
      },
    });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBeGreaterThan(0));
    manager.stop();

    expect(unsubscribed).toBe(true);
  });

  it("keeps the schedule alive when a pass throws", async () => {
    const h = harness([record("a")], {}, {
      listDirtyPages: async () => {
        throw new Error("indexeddb gone");
      },
    });

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    manager.stop();

    expect(h.timers[0].ms).toBe(RESYNC_RETRY_SCHEDULE_MS[0]);
  });

  it("stops listening and stops scheduling once stopped", async () => {
    const h = harness([record("a")]);

    const manager = createResyncManager(h.deps);
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    const before = h.attempted.length;
    expect(h.listening()).toBe(true);
    manager.stop();

    // Unsubscribed, not merely ignored: a manager the shell has torn down must
    // not be reachable from the connectivity store at all.
    expect(h.listening()).toBe(false);
    h.announceOnline();
    await Promise.resolve();

    expect(h.attempted.length).toBe(before);
  });
});
