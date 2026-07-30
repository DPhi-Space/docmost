import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { WebSocketStatus } from "@hocuspocus/provider";
import { yjsConnectionStatusAtom } from "@/features/editor/atoms/editor-atoms";
import {
  DISCONNECT_GRACE_MS,
  useCollabConnectionWatch,
} from "./collab-connection-watch";
import { resetReachabilityForTests } from "./reachability";

function Host() {
  useCollabConnectionWatch();
  return null;
}

/**
 * `yjsConnectionStatusAtom` is module-global — that is exactly why the real hook
 * has to treat a stale value as meaningless — so every case gets an explicit,
 * fresh store and the "never had a status" case can fail independently.
 */
function renderHost() {
  const store = createStore();
  render(
    <Provider store={store}>
      <Host />
    </Provider>,
  );
  return store;
}

/** A monitor that records what it is told rather than acting on it. */
function recordingMonitor() {
  const monitor = resetReachabilityForTests({
    browserOnline: () => true,
    probe: async () => true,
    setTimer: () => 0,
    clearTimer: () => {},
    subscribeBrowserEvents: () => () => {},
  });
  monitor.start();
  return monitor;
}

describe("useCollabConnectionWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetReachabilityForTests();
  });

  it("treats a completed handshake as proof the server is reachable", () => {
    const monitor = recordingMonitor();
    const reached = vi.spyOn(monitor, "reportReached");
    const store = renderHost();

    act(() => store.set(yjsConnectionStatusAtom, WebSocketStatus.Connected));

    expect(reached).toHaveBeenCalled();
  });

  it("says nothing about a socket that has never had a status", () => {
    const monitor = recordingMonitor();
    const suspect = vi.spyOn(monitor, "reportSuspect");
    const reached = vi.spyOn(monitor, "reportReached");

    renderHost();
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 5);

    // The atom is `""` before any editor mounts and keeps its last value after
    // one unmounts; neither says anything about the network.
    expect(suspect).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
  });

  it("ignores the disconnect every page navigation produces", () => {
    // Each navigation destroys and rebuilds the provider, so the status leaves
    // `Connected` constantly during ordinary use. Reporting immediately would
    // fire a probe per navigation for nothing.
    const monitor = recordingMonitor();
    const suspect = vi.spyOn(monitor, "reportSuspect");
    const store = renderHost();

    act(() => store.set(yjsConnectionStatusAtom, WebSocketStatus.Connected));
    act(() => store.set(yjsConnectionStatusAtom, WebSocketStatus.Disconnected));
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
    act(() => store.set(yjsConnectionStatusAtom, WebSocketStatus.Connected));
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 5);

    expect(suspect).not.toHaveBeenCalled();
  });

  it("reports a socket that stays down, since nothing else may notice", () => {
    // A tab sitting on a page makes no HTTP requests at all, so this is usually
    // the first — and often the only — signal that the network has died.
    const monitor = recordingMonitor();
    const suspect = vi.spyOn(monitor, "reportSuspect");
    const store = renderHost();

    act(() => store.set(yjsConnectionStatusAtom, WebSocketStatus.Connected));
    act(() => store.set(yjsConnectionStatusAtom, WebSocketStatus.Disconnected));
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

    expect(suspect).toHaveBeenCalledOnce();
  });
});
