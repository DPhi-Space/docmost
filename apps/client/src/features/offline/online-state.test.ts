import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installQueryOnlineManager } from "./online-state";
import {
  resetReachabilityForTests,
  type BrowserEventHandlers,
  type ReachabilityMonitor,
} from "./reachability";

function manager() {
  const setOnline = vi.fn();
  let teardown: (() => void) | undefined;
  return {
    setOnline,
    /** What React Query does with the setup function it is given. */
    setEventListener(
      setup: (set: (online: boolean) => void) => (() => void) | undefined,
    ) {
      teardown?.();
      teardown = setup(setOnline);
    },
    teardown: () => teardown?.(),
  };
}

/**
 * A monitor that never probes on its own, so the only things that move it are
 * the reports and events a test makes explicitly.
 */
function quietMonitor(startOnline = true): {
  monitor: ReachabilityMonitor;
  events: () => BrowserEventHandlers;
  setBrowserOnline: (online: boolean) => void;
} {
  let online = startOnline;
  let events!: BrowserEventHandlers;
  const monitor = resetReachabilityForTests({
    browserOnline: () => online,
    probe: () => new Promise<boolean>(() => {}),
    setTimer: () => 0,
    clearTimer: () => {},
    subscribeBrowserEvents: (handlers) => {
      events = handlers;
      return () => {};
    },
  });
  return {
    monitor,
    events: () => events,
    setBrowserOnline: (next) => {
      online = next;
    },
  };
}

describe("installQueryOnlineManager", () => {
  beforeEach(() => resetReachabilityForTests());
  afterEach(() => resetReachabilityForTests());

  it("seeds React Query with the verdict instead of its own default", () => {
    // `OnlineManager` starts at `online = true` and never reads anything. A tab
    // loaded while already offline gets no `offline` event, so without this it
    // runs every restored query into a network error rather than pausing.
    quietMonitor(false);
    const m = manager();

    installQueryOnlineManager(m);

    expect(m.setOnline).toHaveBeenCalledWith(false);
  });

  it("publishes every later change of the verdict", () => {
    // The other half of the same problem, and the reason this replaces the
    // manager's listener rather than seeding a value once: with a VPN interface
    // up, neither `online` nor `offline` ever fires, so a seeded value could
    // never be corrected.
    const h = quietMonitor(true);
    const m = manager();
    installQueryOnlineManager(m);
    m.setOnline.mockClear();

    h.setBrowserOnline(false);
    h.events().onBrowserOffline();
    expect(m.setOnline).toHaveBeenLastCalledWith(false);

    h.setBrowserOnline(true);
    h.monitor.reportReached();
    expect(m.setOnline).toHaveBeenLastCalledWith(true);
  });

  it("says nothing on internal churn", () => {
    // A suspicion is not a verdict. Publishing it would pause every query in the
    // app on a single dropped request.
    const h = quietMonitor(true);
    const m = manager();
    installQueryOnlineManager(m);
    m.setOnline.mockClear();

    h.monitor.reportSuspect();

    expect(m.setOnline).not.toHaveBeenCalled();
  });

  it("unsubscribes cleanly when React Query drops its listeners", () => {
    const h = quietMonitor(true);
    const m = manager();
    installQueryOnlineManager(m);
    h.setBrowserOnline(false);
    h.events().onBrowserOffline();
    m.setOnline.mockClear();

    m.teardown();
    h.setBrowserOnline(true);
    h.monitor.reportReached();

    expect(m.setOnline).not.toHaveBeenCalled();
  });
});
