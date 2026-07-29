import { describe, expect, it, vi } from "vitest";
import {
  resyncPage,
  type ResyncPageDeps,
  type ResyncSession,
  type ResyncSessionSample,
} from "./resync-page";

const HEALTHY: ResyncSessionSample = {
  localSynced: true,
  connected: true,
  synced: true,
  unsyncedChanges: 0,
  authenticationFailed: false,
};

const DISCONNECTED: ResyncSessionSample = {
  localSynced: true,
  connected: false,
  synced: false,
  unsyncedChanges: 3,
  authenticationFailed: false,
};

/**
 * A session that yields a scripted sequence of samples, holding the last one
 * forever, plus a virtual clock advanced by every `wait`.
 */
function harness(
  samples: ResyncSessionSample[],
  overrides: Partial<ResyncPageDeps> = {},
) {
  let index = 0;
  let clock = 0;
  const destroy = vi.fn();
  const session: ResyncSession = {
    sample: () => samples[Math.min(index++, samples.length - 1)],
    destroy,
  };
  const deps: ResyncPageDeps = {
    openSession: vi.fn(async () => session),
    getToken: vi.fn(async () => "token"),
    isTokenExpired: () => false,
    shouldAbort: () => false,
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutMs: 1_000,
    pollMs: 100,
    ...overrides,
  };
  return { deps, destroy, session };
}

describe("resyncPage", () => {
  it("reports success once the handshake completed and the counter drained", async () => {
    const { deps } = harness([DISCONNECTED, DISCONNECTED, HEALTHY]);

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "synced",
    });
  });

  it("does not call it success while the stored document is still replaying", async () => {
    // A zero counter before y-indexeddb has finished only means there was
    // nothing to send yet — the offline edit has not even reached the doc.
    const { deps } = harness([
      { ...HEALTHY, localSynced: false },
      { ...HEALTHY, localSynced: false },
      HEALTHY,
    ]);

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "synced",
    });
  });

  it("reports blocked when a completed handshake never acknowledges the writes", async () => {
    // The read-only signature: connected, synced, counter pinned above zero.
    const { deps } = harness([{ ...HEALTHY, unsyncedChanges: 2 }]);

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "blocked",
      reason: "not-accepted",
    });
  });

  it("reports retry — not blocked — when the handshake never happened", async () => {
    // A network that died mid-pass must never be shown to the user as a page
    // that could not sync.
    const { deps } = harness([DISCONNECTED]);

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "retry",
      reason: "no-handshake",
    });
  });

  it("reports blocked when authentication fails with a token that is still valid", async () => {
    const { deps } = harness([{ ...DISCONNECTED, authenticationFailed: true }], {
      isTokenExpired: () => false,
    });

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "blocked",
      reason: "no-access",
    });
  });

  it("reports retry when authentication fails with an expired token", async () => {
    const { deps } = harness([{ ...DISCONNECTED, authenticationFailed: true }], {
      isTokenExpired: () => true,
    });

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "retry",
      reason: "no-token",
    });
  });

  it("retries rather than blocking when no token can be obtained", async () => {
    const { deps, destroy } = harness([HEALTHY], {
      getToken: async () => undefined,
    });

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "retry",
      reason: "no-token",
    });
    // No session was opened, so nothing to tear down.
    expect(destroy).not.toHaveBeenCalled();
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("retries when the session cannot be constructed", async () => {
    const { deps } = harness([HEALTHY], {
      openSession: async () => {
        throw new Error("no websocket");
      },
    });

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "retry",
      reason: "session-failed",
    });
  });

  it("stands down before opening anything when the editor already owns the page", async () => {
    const { deps, destroy } = harness([HEALTHY], {
      shouldAbort: () => true,
    });

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "aborted",
    });
    expect(deps.openSession).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("stands down mid-flight when the editor takes the document", async () => {
    let polls = 0;
    const { deps, destroy } = harness([DISCONNECTED], {
      shouldAbort: () => polls++ > 1,
    });

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "aborted",
    });
    // The session is still torn down — that is the point of aborting.
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the session on every terminating path", async () => {
    for (const samples of [
      [HEALTHY],
      [{ ...HEALTHY, unsyncedChanges: 1 }],
      [DISCONNECTED],
      [{ ...DISCONNECTED, authenticationFailed: true }],
    ]) {
      const { deps, destroy } = harness(samples);
      await resyncPage("page-1", deps);
      expect(destroy).toHaveBeenCalledOnce();
    }
  });

  it("survives a session whose teardown throws", async () => {
    const { deps, session } = harness([HEALTHY]);
    session.destroy = () => {
      throw new Error("already closed");
    };

    await expect(resyncPage("page-1", deps)).resolves.toEqual({
      status: "synced",
    });
  });
});
