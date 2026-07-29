/**
 * The three leak triggers an audit found in the first session-expiry fix, each
 * one now a test, plus the reader-side refusal that makes a missed cleanup
 * inert rather than dangerous.
 *
 * Every original trigger ended the same way: the previous user's document text
 * on the next user's screen, and pushed to the server under their identity.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  getOwnershipStatus,
  offlineDataIsOurs,
  reconcileOfflineDataOwnership,
  resetOwnershipForTests,
} from "./data-ownership";
import type { OfflineDataOwner } from "./dirty-pages";

function harness(owner: OfflineDataOwner) {
  const cleared: string[] = [];
  return {
    cleared,
    deps: {
      readOfflineDataOwner: async () => owner,
      clearOfflineData: async () => {
        cleared.push("cleared");
      },
    },
  };
}

describe("offlineDataIsOurs", () => {
  beforeEach(resetOwnershipForTests);

  it("is false before anything has been established", () => {
    // The default has to be refusal. Nothing needs to go right for this to
    // hold; something has to go right to leave it.
    expect(offlineDataIsOurs()).toBe(false);
    expect(getOwnershipStatus()).toBe("unknown");
  });
});

describe("reconcileOfflineDataOwnership", () => {
  beforeEach(resetOwnershipForTests);

  it("opens the readers when nothing was ever preserved", async () => {
    const h = harness({ status: "none" });

    await expect(
      reconcileOfflineDataOwnership("user-1", h.deps),
    ).resolves.toBe("clean");

    expect(offlineDataIsOurs()).toBe(true);
    expect(h.cleared).toEqual([]);
  });

  it("opens the readers for the owner", async () => {
    const h = harness({ status: "known", ownerUserId: "user-1" });

    await expect(reconcileOfflineDataOwnership("user-1", h.deps)).resolves.toBe(
      "ours",
    );

    expect(offlineDataIsOurs()).toBe(true);
    expect(h.cleared).toEqual([]);
  });

  it("erases when a different account signs in (T1f/T1i)", async () => {
    // Reached in the audit three ways. The trigger is now the *presence of the
    // data* — never a notice, which the old code consumed on the first sign-in
    // and then treated as "settled" on the second.
    const h = harness({ status: "known", ownerUserId: "alice" });

    await expect(reconcileOfflineDataOwnership("bob", h.deps)).resolves.toBe(
      "erased",
    );

    expect(h.cleared).toEqual(["cleared"]);
  });

  it("erases when the owner stamp cannot be read", async () => {
    // "I cannot tell whose this is" and "it is someone else's" are the same
    // thing from the next user's point of view.
    const h = harness({ status: "unreadable" });

    await expect(reconcileOfflineDataOwnership("bob", h.deps)).resolves.toBe(
      "erased",
    );

    expect(h.cleared).toEqual(["cleared"]);
  });

  it("never opens the readers before the erase has finished", async () => {
    // Order is the whole guarantee: opening first would leave a window in
    // which the manager could push a stranger's document.
    const seen: boolean[] = [];
    const h = harness({ status: "known", ownerUserId: "alice" });

    await reconcileOfflineDataOwnership("bob", {
      ...h.deps,
      clearOfflineData: async () => {
        seen.push(offlineDataIsOurs());
      },
    });

    expect(seen).toEqual([false]);
    expect(offlineDataIsOurs()).toBe(true);
  });

  it("defers, without erasing, while no user is known", async () => {
    // Erasing here would destroy the signed-in user's own pending work every
    // time the user query happened to be slow. Refusing to decide costs
    // nothing: the readers stay closed and no page renders without a user.
    const h = harness({ status: "known", ownerUserId: "alice" });

    await expect(reconcileOfflineDataOwnership(null, h.deps)).resolves.toBe(
      "deferred",
    );

    expect(h.cleared).toEqual([]);
    expect(offlineDataIsOurs()).toBe(false);
  });

  it("closes the readers again if a later reconcile cannot decide", async () => {
    const h = harness({ status: "none" });
    await reconcileOfflineDataOwnership("user-1", h.deps);
    expect(offlineDataIsOurs()).toBe(true);

    await reconcileOfflineDataOwnership(undefined, h.deps);

    expect(offlineDataIsOurs()).toBe(false);
  });
});
