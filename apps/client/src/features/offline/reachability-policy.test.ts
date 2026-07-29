import { describe, expect, it } from "vitest";
import {
  CONFIRM_FAILURES,
  HEARTBEAT_MS,
  OFFLINE_BACKOFF_MS,
  RECHECK_DELAY_MS,
  initialReachabilityState,
  nextReachabilityState,
  probeDelayMs,
  type ReachabilitySignal,
  type ReachabilityState,
} from "./reachability-policy";

const state = (over: Partial<ReachabilityState> = {}): ReachabilityState => ({
  reachable: true,
  failures: 0,
  suspect: false,
  ...over,
});

/** Feed a sequence of signals through, for the multi-step properties. */
function walk(
  start: ReachabilityState,
  ...signals: ReachabilitySignal[]
): ReachabilityState {
  return signals.reduce(nextReachabilityState, start);
}

describe("initialReachabilityState", () => {
  it("assumes reachable when the browser has no objection", () => {
    expect(initialReachabilityState(true)).toEqual(state());
  });

  it("believes the browser outright when it says there is no route", () => {
    const initial = initialReachabilityState(false);
    expect(initial.reachable).toBe(false);
    // At the threshold, so the backoff below starts at its first step rather
    // than an arbitrary one.
    expect(probeDelayMs(initial)).toBe(OFFLINE_BACKOFF_MS[0]);
  });
});

describe("nextReachabilityState — declaring the server unreachable", () => {
  it("does not go offline on a single failed probe", () => {
    // The verdict pauses every query in the app; one dropped request is an
    // ordinary event on a working network.
    const next = nextReachabilityState(state(), { kind: "probe-failed" });

    expect(next.reachable).toBe(true);
    expect(next.failures).toBe(1);
  });

  it("goes offline once the failures reach the confirmation threshold", () => {
    const failures = Array.from(
      { length: CONFIRM_FAILURES },
      () => ({ kind: "probe-failed" }) as const,
    );

    expect(walk(state(), ...failures).reachable).toBe(false);
  });

  it("goes offline immediately when the browser says there is no route", () => {
    // The one signal taken at face value: `false` is the only thing
    // `navigator.onLine` is trustworthy about.
    expect(
      nextReachabilityState(state(), { kind: "browser-offline" }).reachable,
    ).toBe(false);
  });

  it("treats a suspicion as a request to check, never as an answer", () => {
    const next = nextReachabilityState(state(), { kind: "suspect" });

    expect(next.reachable).toBe(true);
    expect(probeDelayMs(next)).toBe(0);
  });
});

describe("nextReachabilityState — coming back", () => {
  it("believes a single answer from the server, with no hysteresis at all", () => {
    // The asymmetry is deliberate: this is what makes a wrong offline verdict
    // self-correcting the moment any request succeeds.
    const offline = state({ reachable: false, failures: 7 });

    expect(nextReachabilityState(offline, { kind: "reached" })).toEqual(state());
  });

  it("does not believe an interface reappearing", () => {
    const offline = state({ reachable: false, failures: 3 });
    const next = nextReachabilityState(offline, { kind: "browser-online" });

    expect(next.reachable).toBe(false);
    // It earns a probe, and only a probe.
    expect(probeDelayMs(next)).toBe(0);
  });

  it("does not believe the tab becoming visible either", () => {
    const offline = state({ reachable: false, failures: 3 });

    expect(
      nextReachabilityState(offline, { kind: "wake" }).reachable,
    ).toBe(false);
  });

  it("keeps walking the backoff while probes keep failing", () => {
    let current = state({ reachable: false, failures: CONFIRM_FAILURES });
    const delays = [probeDelayMs(current)];
    for (let i = 0; i < OFFLINE_BACKOFF_MS.length + 1; i += 1) {
      current = nextReachabilityState(current, { kind: "probe-failed" });
      delays.push(probeDelayMs(current));
    }

    // The documented schedule, stated rather than read back, and holding at its
    // last step forever.
    expect(delays).toEqual([
      5_000, 15_000, 60_000, 180_000, 180_000, 180_000,
    ]);
  });
});

describe("nextReachabilityState — identity", () => {
  it("returns the same object when nothing changed", () => {
    // The store compares by identity to decide whether to notify; a fresh object
    // on every signal would re-render the app on every heartbeat.
    const healthy = state();
    expect(nextReachabilityState(healthy, { kind: "reached" })).toBe(healthy);
    expect(nextReachabilityState(healthy, { kind: "wake" })).toBe(healthy);
    expect(nextReachabilityState(healthy, { kind: "browser-online" })).toBe(
      healthy,
    );

    const offline = state({ reachable: false, failures: CONFIRM_FAILURES });
    expect(nextReachabilityState(offline, { kind: "suspect" })).toBe(offline);
    expect(nextReachabilityState(offline, { kind: "browser-offline" })).toBe(
      offline,
    );
  });
});

describe("probeDelayMs", () => {
  it("asks for a probe immediately when something is suspected", () => {
    expect(probeDelayMs(state({ suspect: true }))).toBe(0);
    expect(
      probeDelayMs(state({ reachable: false, failures: 9, suspect: true })),
    ).toBe(0);
  });

  it("rechecks quickly after a first failure, before the verdict is in", () => {
    expect(probeDelayMs(state({ failures: 1 }))).toBe(RECHECK_DELAY_MS);
  });

  it("wants nothing at all from a healthy, unsuspected state", () => {
    // `null` is what leaves an active tab paying nothing: the caller falls back
    // to the idle heartbeat, which itself skips when traffic is flowing.
    expect(probeDelayMs(state())).toBeNull();
    expect(RECHECK_DELAY_MS).toBeLessThan(HEARTBEAT_MS);
  });
});
