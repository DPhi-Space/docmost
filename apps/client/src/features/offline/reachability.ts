/**
 * Is this Docmost server reachable right now? The evidence-gathering half; the
 * decisions are all in `reachability-policy.ts`.
 *
 * ## The probe
 *
 * `GET /api/health/live` on our **own origin**, and every property that makes it
 * the right target is a property of the deployment, not a coincidence:
 *
 * - it returns the string `ok` and touches neither Postgres nor Redis
 *   (`apps/server/src/integrations/health/health.controller.ts`);
 * - `HealthController` carries no `JwtAuthGuard` — guards are per-controller in
 *   this app, there is no global one — so it needs no session;
 * - it is excluded from `DomainMiddleware` (`core.module.ts`) and from the
 *   `workspaceId` preHandler (`main.ts`), so it works on any hostname;
 * - it is excluded from request logging (`pino.config.ts`), so probing does not
 *   fill the operator's logs;
 * - only `auth.controller.ts` is rate limited, so probing cannot lock anyone out;
 * - and **the service worker passes it through untouched** — `sw/routes.ts`
 *   passes through every `/api/` path except `/api/files/`. That one is
 *   load-bearing: `cache: "no-store"` governs the HTTP cache and says nothing
 *   about Cache Storage, so a probe the worker was allowed to answer could
 *   report a server that has been unreachable for a week as up. There is a test
 *   asserting the route classification from this constant.
 *
 * **Any HTTP response counts as reachable, including 404 and 502.** The question
 * is whether packets completed a round trip to the origin, not whether the
 * server is healthy — and a reverse proxy that does not forward this one path
 * must not be able to convince the app it is offline. Only a transport failure
 * or a timeout is a failure. A captive portal is handled by the same rule from
 * the other side: its redirect goes cross-origin, `fetch` rejects on CORS, and
 * the probe correctly fails.
 *
 * ## Evidence, in order of strength
 *
 * The probe is the *fallback*, not the main signal. In order:
 *
 * 1. **Ordinary application traffic.** `lib/api-client.ts` reports every axios
 *    response as `reached` and every transport-level failure as `suspect`, and
 *    the collaboration socket reports its own connects and drops
 *    (`collab-connection-watch.ts`). An app in use is answering this question
 *    continuously for free.
 * 2. **`navigator.onLine === false`**, which is trustworthy in that one
 *    direction and is consulted live on every read.
 * 3. **The probe**, which exists for the case nothing else covers: an idle tab,
 *    where a Wi-Fi failure would otherwise go unnoticed until the user's next
 *    click.
 *
 * ## Starting
 *
 * Constructing the monitor subscribes to browser events and nothing else. No
 * request is ever sent until {@link startReachabilityMonitor} is called (from
 * `main.tsx`), which keeps every test that merely renders a component inert and
 * offline-free unless it opts in.
 */

import { useSyncExternalStore } from "react";
import {
  HEARTBEAT_MS,
  PROBE_TIMEOUT_MS,
  initialReachabilityState,
  nextReachabilityState,
  probeDelayMs,
  type ReachabilitySignal,
  type ReachabilityState,
} from "./reachability-policy";

/** The endpoint above. Exported so the service-worker route test can use it. */
export const HEALTH_PROBE_PATH = "/api/health/live";

/**
 * One probe.
 *
 * `credentials: "omit"` because the endpoint is public and a probe has no
 * business carrying the session cookie; the cache-busting parameter because an
 * intermediary proxy is not bound by `cache: "no-store"` and a cached `ok` is
 * exactly the lie this module cannot afford.
 */
export async function probeServerOnce(
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${HEALTH_PROBE_PATH}?_=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    // Deliberately not `response.ok`: see the file comment.
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ReachabilityMonitorDeps {
  probe: () => Promise<boolean>;
  /** `navigator.onLine`, read live rather than cached. */
  browserOnline: () => boolean;
  /** Whether the tab is on screen; a hidden tab is not worth probing for. */
  isVisible: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  /**
   * Browser connectivity events. Injected as one function so a test can drive
   * every entry point without touching globals, and so the production version
   * can attach to three different targets in one place.
   */
  subscribeBrowserEvents: (handlers: BrowserEventHandlers) => () => void;
}

export interface BrowserEventHandlers {
  onBrowserOnline: () => void;
  onBrowserOffline: () => void;
  onWake: () => void;
}

export interface ReachabilityMonitor {
  /** The verdict: is the server reachable? */
  isReachable(): boolean;
  /** Notified only when the verdict itself changes, never on internal churn. */
  subscribe(listener: () => void): () => void;
  /** An HTTP response arrived from our origin. The strongest signal there is. */
  reportReached(): void;
  /** A request failed at the transport layer, or a live socket dropped. */
  reportSuspect(): void;
  /** Probe now; resolves with the verdict. */
  check(): Promise<boolean>;
  /**
   * The first verdict backed by evidence, for callers whose decision cannot be
   * taken optimistically (see `use-offline-resync.ts`). Always resolves.
   */
  settled(): Promise<boolean>;
  /** Begin probing. Idempotent. */
  start(): void;
  stop(): void;
  /** Internals, for tests and for the wiring test. */
  state(): ReachabilityState;
}

export function defaultReachabilityDeps(): ReachabilityMonitorDeps {
  return {
    probe: () => probeServerOnce(),
    browserOnline: () => globalThis.navigator?.onLine !== false,
    isVisible: () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
    now: () => Date.now(),
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimer: (handle) => globalThis.clearTimeout(handle),
    subscribeBrowserEvents: ({ onBrowserOnline, onBrowserOffline, onWake }) => {
      const wake = () => {
        // A hidden tab's timers are throttled to a minute or worse, so becoming
        // visible is the moment a stale verdict is most likely and cheapest to
        // correct.
        if (typeof document === "undefined" || !document.hidden) onWake();
      };
      /**
       * The Network Information API's `change` fires on interface changes that
       * do not move `navigator.onLine` at all — which is precisely the VPN case
       * this module exists for. Chromium-only, and used only as a prompt to go
       * and check, never as an answer.
       */
      const connection = (
        globalThis.navigator as { connection?: EventTarget } | undefined
      )?.connection;

      globalThis.addEventListener?.("online", onBrowserOnline);
      globalThis.addEventListener?.("offline", onBrowserOffline);
      globalThis.document?.addEventListener?.("visibilitychange", wake);
      connection?.addEventListener?.("change", wake);

      return () => {
        globalThis.removeEventListener?.("online", onBrowserOnline);
        globalThis.removeEventListener?.("offline", onBrowserOffline);
        globalThis.document?.removeEventListener?.("visibilitychange", wake);
        connection?.removeEventListener?.("change", wake);
      };
    },
  };
}

export function createReachabilityMonitor(
  overrides: Partial<ReachabilityMonitorDeps> = {},
): ReachabilityMonitor {
  const deps: ReachabilityMonitorDeps = {
    ...defaultReachabilityDeps(),
    ...overrides,
  };

  let state = initialReachabilityState(deps.browserOnline());
  let started = false;
  let stopped = false;
  let timer: number | null = null;
  let probing: Promise<boolean> | null = null;
  /** When the server was last known to have answered anything. */
  let lastReachedAt = deps.now();
  /** The first evidence-backed verdict, or null while still assuming. */
  let verdict: boolean | null = null;

  const listeners = new Set<() => void>();
  let settleWaiters: Array<(value: boolean) => void> = [];

  /**
   * The verdict, with `navigator.onLine === false` as a live veto.
   *
   * Read rather than cached because it is the one signal that needs no
   * corroboration, and because reading it here means a browser that changes it
   * without dispatching an event still cannot make the app believe it is online.
   */
  const isReachable = (): boolean => deps.browserOnline() && state.reachable;

  /**
   * The last verdict subscribers were told about.
   *
   * Compared against rather than recomputing "before and after" inside `apply`,
   * because the veto above can move the verdict with *no signal at all*: when
   * Wi-Fi is switched off for real, `navigator.onLine` flips to `false` and only
   * then does the `offline` event arrive — so a before/after comparison sees
   * `false → false`, concludes nothing changed, and tells nobody. The offline
   * pill stayed hidden, React Query was never paused and the resync manager never
   * heard, all from a two-line "optimisation". Caught by a test, not a browser.
   */
  let published = isReachable();

  const notifyIfChanged = () => {
    const current = isReachable();
    if (current === published) return;
    published = current;
    for (const listener of listeners) listener();
  };

  const cancelTimer = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (!started || stopped) return;
    cancelTimer();
    timer = deps.setTimer(onTimer, probeDelayMs(state) ?? HEARTBEAT_MS);
  };

  const apply = (signal: ReachabilitySignal) => {
    if (stopped) return;
    state = nextReachabilityState(state, signal);
    notifyIfChanged();
    // "Unreachable" is always a definitive answer — the policy only reaches it
    // after its confirmation threshold — so it settles `settled()`. An
    // unconfirmed failure deliberately does not; see `settle`.
    if (!isReachable()) settle(false);
    schedule();
  };

  function onTimer(): void {
    timer = null;
    if (stopped) return;

    if (!deps.browserOnline()) {
      // No route at all: nothing to probe, and `apply` reschedules for us.
      apply({ kind: "browser-offline" });
      return;
    }

    if (probeDelayMs(state) === null) {
      // Healthy and unsuspected — this tick is the idle heartbeat. Skip it if
      // the tab is off screen, or if ordinary traffic has already answered the
      // question inside the window.
      if (!deps.isVisible() || deps.now() - lastReachedAt < HEARTBEAT_MS) {
        schedule();
        return;
      }
    }

    void runProbe();
  }

  /**
   * Publish a verdict to `settled()`'s waiters.
   *
   * Only ever called with an answer that is *definitive*: the server answered, or
   * the policy has confirmed it cannot be reached. A first failed probe leaves
   * the state optimistically `reachable` while it is being confirmed, and a
   * caller waiting on this must not be handed that — `use-offline-resync.ts`
   * decides from the answer whether to trust the cached user, and "probably
   * online" resolves to a request that fails and an identity it then refuses,
   * which is what left offline editing dead on a cold boot.
   */
  const settle = (value: boolean) => {
    verdict = value;
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiters) resolve(value);
  };

  const runProbe = async (): Promise<boolean> => {
    // One in flight at a time: a suspicion arriving mid-probe is answered by
    // the probe already running.
    if (probing) return probing;
    probing = (async () => {
      try {
        return await deps.probe();
      } catch {
        // A probe implementation must never be able to stop the schedule.
        return false;
      }
    })();
    const reached = await probing;
    probing = null;
    if (stopped) return reached;
    if (reached) lastReachedAt = deps.now();
    apply({ kind: reached ? "reached" : "probe-failed" });
    if (reached) settle(true);
    return isReachable();
  };

  const unsubscribeBrowser = deps.subscribeBrowserEvents({
    onBrowserOnline: () => apply({ kind: "browser-online" }),
    onBrowserOffline: () => apply({ kind: "browser-offline" }),
    onWake: () => apply({ kind: "wake" }),
  });

  return {
    isReachable,
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reportReached() {
      lastReachedAt = deps.now();
      // The common case by far, and it must stay free: an app under normal use
      // calls this on every response.
      if (state.reachable && state.failures === 0 && !state.suspect) {
        if (verdict === null && deps.browserOnline()) settle(true);
        return;
      }
      apply({ kind: "reached" });
      if (deps.browserOnline()) settle(true);
    },

    reportSuspect() {
      // No probe is fired from here. `apply` reschedules, and a suspected state
      // asks for its probe at delay 0 — one path to the probe rather than two.
      apply({ kind: "suspect" });
    },

    check: () => runProbe(),

    settled() {
      if (!deps.browserOnline()) return Promise.resolve(false);
      if (verdict !== null) return Promise.resolve(isReachable());
      // Nothing is going to probe, so the optimistic assumption is the answer.
      if (!started || stopped) return Promise.resolve(isReachable());
      return new Promise<boolean>((resolve) => settleWaiters.push(resolve));
    },

    start() {
      if (started || stopped) return;
      started = true;
      // Replace the boot assumption with an answer straight away; `settled()`
      // waits on exactly this.
      if (deps.browserOnline()) void runProbe();
      else settle(false);
      schedule();
    },

    stop() {
      stopped = true;
      cancelTimer();
      unsubscribeBrowser();
      listeners.clear();
      // Nobody is left to answer these, and a hung promise is worse than a
      // pessimistic one.
      settle(false);
    },
  };
}

let monitor = createReachabilityMonitor();

/**
 * Begin probing. Called once from `main.tsx`, before the first render.
 *
 * Not done on import: a module that sends a request the moment it is loaded is
 * a module every unit test in the app has to work around.
 */
export function startReachabilityMonitor(): void {
  monitor.start();
}

/** Is the server reachable? The app-wide answer to "are we online". */
export function isServerReachable(): boolean {
  return monitor.isReachable();
}

/** Notified when the verdict changes. */
export function subscribeReachability(listener: () => void): () => void {
  return monitor.subscribe(listener);
}

/** An HTTP response arrived from our origin. */
export function reportNetworkSuccess(): void {
  monitor.reportReached();
}

/** A request failed at the transport layer, or a live socket dropped. */
export function reportNetworkFailure(): void {
  monitor.reportSuspect();
}

/** The first evidence-backed verdict. Always resolves; see `settled`. */
export function whenServerReachable(): Promise<boolean> {
  return monitor.settled();
}

export function useServerReachable(): boolean {
  return useSyncExternalStore(
    subscribeReachability,
    isServerReachable,
    () => true,
  );
}

/** Test seam: the singleton is module state and has to be replaceable. */
export function resetReachabilityForTests(
  overrides: Partial<ReachabilityMonitorDeps> = {},
): ReachabilityMonitor {
  monitor.stop();
  monitor = createReachabilityMonitor(overrides);
  return monitor;
}
