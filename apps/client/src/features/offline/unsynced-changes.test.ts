import { describe, expect, it } from "vitest";
import {
  initialUnsyncedState,
  nextUnsyncedState,
  UNSYNCED_GRACE_MS,
  type UnsyncedSample,
  type UnsyncedState,
} from "./unsynced-changes";

const GRACE = 10_000;

/** Fold a sequence of samples, the way the hook's timer does. */
function fold(
  samples: UnsyncedSample[],
  graceMs = GRACE,
  from: UnsyncedState = initialUnsyncedState,
): UnsyncedState {
  return samples.reduce((state, s) => nextUnsyncedState(state, s, graceMs), from);
}

const live = (unsyncedChanges: number, now: number): UnsyncedSample => ({
  hasLiveSync: true,
  unsyncedChanges,
  now,
});

const offline = (unsyncedChanges: number, now: number): UnsyncedSample => ({
  hasLiveSync: false,
  unsyncedChanges,
  now,
});

describe("nextUnsyncedState", () => {
  it("does not warn about a counter that drains", () => {
    // A healthy connection: each edit is acknowledged within a tick.
    const state = fold([
      live(0, 0),
      live(1, 1_000),
      live(0, 2_000),
      live(3, 3_000),
      live(0, 4_000),
    ]);

    expect(state.warned).toBe(false);
  });

  it("does not warn before the grace period has elapsed", () => {
    const state = fold([live(1, 0), live(1, GRACE - 1)]);

    expect(state.warned).toBe(false);
    expect(state.pendingSince).toBe(0);
  });

  it("warns once the counter has been stuck for the whole grace period", () => {
    const state = fold([live(1, 0), live(1, GRACE)]);

    expect(state.warned).toBe(true);
  });

  it("measures the grace period from when the counter first went positive", () => {
    // Nothing pending for the first 30s; the clock starts at 30s, not at 0.
    const state = fold([live(0, 0), live(0, 30_000), live(1, 30_001)]);

    expect(state.pendingSince).toBe(30_001);
    expect(state.warned).toBe(false);
    expect(nextUnsyncedState(state, live(1, 40_000), GRACE).warned).toBe(false);
    expect(nextUnsyncedState(state, live(1, 40_001), GRACE).warned).toBe(true);
  });

  it("restarts the clock after a drain, so a slow save does not accumulate", () => {
    const state = fold([
      live(1, 0),
      live(1, 9_000),
      live(0, 9_500), // drained
      live(1, 10_000),
      live(1, 19_000), // only 9s pending this time
    ]);

    expect(state.warned).toBe(false);
  });

  it("ignores a positive counter while there is no live sync", () => {
    // The whole point of the feature: offline edits are unsynced by design.
    const state = fold([
      offline(1, 0),
      offline(7, 60_000),
      offline(7, 600_000),
    ]);

    expect(state).toEqual(initialUnsyncedState);
  });

  it("does not start the clock during a handshake, when the counter is seeded to 1", () => {
    // `startSync()` calls `resetUnsyncedChanges()`, which sets the counter to 1
    // before a single edit exists.
    const state = fold([offline(1, 0), offline(1, 30_000), live(0, 30_100)]);

    expect(state.warned).toBe(false);
  });

  it("keeps an existing warning when the connection drops", () => {
    // Losing the connection does not retroactively make dropped writes land.
    const warned = fold([live(1, 0), live(1, GRACE)]);
    expect(warned.warned).toBe(true);

    const afterDrop = fold([offline(1, GRACE + 1_000)], GRACE, warned);

    expect(afterDrop.warned).toBe(true);
    expect(afterDrop.pendingSince).toBeNull();
  });

  it("clears the warning only when the counter reaches zero on a live sync", () => {
    const warned = fold([live(1, 0), live(1, GRACE)]);

    // e.g. the page lock was lifted and the queued updates finally landed.
    const recovered = nextUnsyncedState(warned, live(0, GRACE + 5_000), GRACE);

    expect(recovered).toEqual(initialUnsyncedState);
  });

  it("re-warns after a recovery if the counter sticks again", () => {
    const recovered = fold([live(1, 0), live(1, GRACE), live(0, GRACE + 1)]);
    const state = fold(
      [live(1, 100_000), live(1, 100_000 + GRACE)],
      GRACE,
      recovered,
    );

    expect(state.warned).toBe(true);
  });

  it("returns the same object when nothing changed, so React is not woken", () => {
    const state = fold([live(1, 0)]);

    expect(nextUnsyncedState(state, live(1, 1_000), GRACE)).toBe(state);
    expect(nextUnsyncedState(initialUnsyncedState, live(0, 0), GRACE)).toBe(
      initialUnsyncedState,
    );
    expect(nextUnsyncedState(initialUnsyncedState, offline(4, 0), GRACE)).toBe(
      initialUnsyncedState,
    );
  });

  it("treats a negative counter as drained", () => {
    expect(fold([live(-1, 0), live(-1, 60_000)]).warned).toBe(false);
  });

  it("waits the full grace period, to the millisecond, before warning", () => {
    // Written with literals rather than `UNSYNCED_GRACE_MS` on both sides: an
    // assertion that the constant equals itself cannot fail, and the boundary
    // is the only part of this worth pinning. Shortening the grace would make
    // ordinary slow saves look like dropped writes.
    const pending = { pendingSince: 0, warned: false };
    const sample = (now: number) => ({
      hasLiveSync: true,
      unsyncedChanges: 1,
      now,
    });

    expect(nextUnsyncedState(pending, sample(9_999)).warned).toBe(false);
    expect(nextUnsyncedState(pending, sample(10_000)).warned).toBe(true);
  });
});
