import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Provider, useAtom } from "jotai";
import { WebSocketStatus } from "@hocuspocus/provider";
import { yjsConnectionStatusAtom } from "@/features/editor/atoms/editor-atoms";
import {
  DISCONNECT_GRACE_MS,
  useCollabConnectionWatch,
} from "./collab-connection-watch";
import { resetReachabilityForTests } from "./reachability";

let setStatus: (status: string) => void;

/**
 * Rendered inside a jotai `Provider` in every case below. `yjsConnectionStatusAtom`
 * is module-global — that is exactly why the real hook has to treat a stale value
 * as meaningless — so without a fresh store per render, one case's `Connected`
 * leaks into the next and the "never had a status" case cannot fail.
 */
function Host() {
  const [, set] = useAtom(yjsConnectionStatusAtom);
  setStatus = set;
  useCollabConnectionWatch();
  return null;
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
    render(
      <Provider>
        <Host />
      </Provider>,
    );

    act(() => setStatus(WebSocketStatus.Connected));

    expect(reached).toHaveBeenCalled();
  });

  it("says nothing about a socket that has never had a status", () => {
    const monitor = recordingMonitor();
    const suspect = vi.spyOn(monitor, "reportSuspect");
    const reached = vi.spyOn(monitor, "reportReached");

    render(
      <Provider>
        <Host />
      </Provider>,
    );
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
    render(
      <Provider>
        <Host />
      </Provider>,
    );

    act(() => setStatus(WebSocketStatus.Connected));
    act(() => setStatus(WebSocketStatus.Disconnected));
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
    act(() => setStatus(WebSocketStatus.Connected));
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 5);

    expect(suspect).not.toHaveBeenCalled();
  });

  it("reports a socket that stays down, since nothing else may notice", () => {
    // A tab sitting on a page makes no HTTP requests at all, so this is usually
    // the first — and often the only — signal that the network has died.
    const monitor = recordingMonitor();
    const suspect = vi.spyOn(monitor, "reportSuspect");
    render(
      <Provider>
        <Host />
      </Provider>,
    );

    act(() => setStatus(WebSocketStatus.Connected));
    act(() => setStatus(WebSocketStatus.Disconnected));
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

    expect(suspect).toHaveBeenCalledOnce();
  });
});
