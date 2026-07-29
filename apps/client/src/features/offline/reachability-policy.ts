/**
 * Deciding whether *this* Docmost server can be reached — the decision half,
 * kept pure so the whole table is a test.
 *
 * ## Why `navigator.onLine` is not this
 *
 * `navigator.onLine === false` is a trustworthy negative: the user agent is
 * telling us it has no route at all. `true` means only that *an interface
 * exists*, which is a much weaker claim than the app needs, and it is routinely
 * wrong in ways users hit:
 *
 * - **a VPN.** The virtual adapter (`utun*` on macOS) stays up when Wi-Fi
 *   drops, and both Chrome's and Safari's network-change detection read that as
 *   connectivity. Reported against this fork's offline editing: Wi-Fi off, and
 *   `navigator.onLine` still `true` in both browsers, so the gate in
 *   `offline-edit-gate.ts` never opened and the editor stayed read-only.
 * - a captive portal that answers every request with its own login page;
 * - an Ethernet cable into a dead switch, or a bridged VM adapter.
 *
 * ## Why the question is "the server", not "the internet"
 *
 * A probe against a third party would be wrong in both directions for a
 * self-hosted install: a server reachable only across the VPN is *online* with
 * no internet at all, and a working internet connection says nothing when the
 * container is down. It would also send a request somewhere the operator did
 * not choose. So the only signal that counts is one of our own origin's
 * responses — see `reachability.ts` for which one, and why any HTTP status at
 * all is a success.
 *
 * ## The two properties this state machine exists for
 *
 * 1. **Hysteresis before declaring offline** ({@link CONFIRM_FAILURES}).
 *    Consumers of the verdict include the editing gate, and a gate that flips
 *    open on a three-second blip during ordinary page-switching is worse than
 *    one that takes ten seconds to notice a dead network. A single failure never
 *    decides.
 * 2. **No hysteresis at all in the other direction.** One answer from the server
 *    — from a probe *or* from ordinary application traffic — means reachable,
 *    immediately and unconditionally. That asymmetry is what makes a
 *    false-offline verdict self-correcting: the moment any request succeeds the
 *    app stops believing it. Worth being deliberate about, because
 *    `installQueryOnlineManager` hands this verdict to React Query, which
 *    *pauses fetches* when it says offline; a sticky wrong answer there would
 *    take the app down.
 */

export type ReachabilitySignal =
  /** The user agent says there is no route. Believed outright. */
  | { kind: "browser-offline" }
  /** An interface came back. Believed of nothing; it only prompts a probe. */
  | { kind: "browser-online" }
  /**
   * Something failed in a way a dead network would explain: a transport-level
   * request failure, or the collaboration socket dropping. A hint to go and
   * check, never a verdict.
   */
  | { kind: "suspect" }
  /** The server answered something. The only positive evidence there is. */
  | { kind: "reached" }
  /** A probe got no answer at all (transport failure or timeout). */
  | { kind: "probe-failed" }
  /** The tab became visible, or the network interface changed. */
  | { kind: "wake" };

export interface ReachabilityState {
  /** The verdict consumers read. */
  reachable: boolean;
  /** Consecutive probe failures. Any success resets it to zero. */
  failures: number;
  /**
   * Something suggests connectivity changed and it has not been checked yet.
   * Distinct from `failures` because it asks for a probe *now* rather than on
   * the schedule.
   */
  suspect: boolean;
}

/**
 * How many consecutive probe failures declare the server unreachable.
 *
 * Two, not one: a single failed request is an ordinary event on a working
 * network (a dropped packet, a restarting container, a proxy hiccup), and the
 * verdict pauses every query in the app.
 */
export const CONFIRM_FAILURES = 2;

/** Gap between the confirmation probes that follow a first failure. */
export const RECHECK_DELAY_MS = 3_000;

/**
 * Probe schedule while believed unreachable, holding at the last step.
 *
 * Deliberately the shape of `RESYNC_RETRY_SCHEDULE_MS`: a flapping connection is
 * worth recovering from in seconds, and a device that has been dark for half an
 * hour is not worth a request every five seconds. Recovery does not depend on
 * this alone — an `online` event, the tab becoming visible, or any successful
 * request all short-circuit it.
 */
export const OFFLINE_BACKOFF_MS = [5_000, 15_000, 60_000, 180_000];

/**
 * How long an *idle* healthy tab goes without evidence before probing.
 *
 * A tab sitting on a page produces no HTTP traffic at all — the editor talks
 * over a WebSocket and the query defaults are `refetchOnMount: false` with a
 * five-minute `staleTime` — so without this a Wi-Fi failure while reading would
 * go unnoticed until the user's next click. Any successful request resets the
 * window, so an actively used tab probes approximately never.
 */
export const HEARTBEAT_MS = 30_000;

/** A probe that has not answered within this long has not answered. */
export const PROBE_TIMEOUT_MS = 4_000;

export function initialReachabilityState(
  browserOnline: boolean,
): ReachabilityState {
  // Optimistic when the browser has no objection: this is the state the app
  // boots in today, and a first probe is kicked off immediately to replace the
  // assumption with an answer.
  return browserOnline
    ? { reachable: true, failures: 0, suspect: false }
    : { reachable: false, failures: CONFIRM_FAILURES, suspect: false };
}

/**
 * @returns the same object when nothing changed, so the store can skip both the
 *          notification and the re-render.
 */
export function nextReachabilityState(
  state: ReachabilityState,
  signal: ReachabilitySignal,
): ReachabilityState {
  switch (signal.kind) {
    case "browser-offline":
      // The one signal taken at face value. `failures` is advanced to the
      // confirmation threshold rather than left alone so that the backoff below
      // starts at its first step instead of an arbitrary one.
      return same(state, {
        reachable: false,
        failures: Math.max(state.failures, CONFIRM_FAILURES),
        suspect: false,
      });

    case "browser-online":
    case "wake":
      // An interface appearing is not the server answering. All it earns is a
      // probe, and only when there is something to find out.
      if (state.reachable && state.failures === 0) return state;
      return same(state, { ...state, suspect: true });

    case "suspect":
      // Nothing to add while already unreachable: a probe is already scheduled.
      if (!state.reachable) return state;
      return same(state, { ...state, suspect: true });

    case "reached":
      return same(state, { reachable: true, failures: 0, suspect: false });

    case "probe-failed": {
      const failures = state.failures + 1;
      return same(state, {
        reachable: state.reachable && failures < CONFIRM_FAILURES,
        failures,
        // Consumed: the question has been asked, and the answer decides the
        // next delay.
        suspect: false,
      });
    }
  }
}

function same(
  state: ReachabilityState,
  next: ReachabilityState,
): ReachabilityState {
  return state.reachable === next.reachable &&
    state.failures === next.failures &&
    state.suspect === next.suspect
    ? state
    : next;
}

/**
 * When the next probe is due.
 *
 * @returns milliseconds, or `null` for "nothing to check" — a healthy state with
 *          no outstanding suspicion, where the only probe left is the idle
 *          heartbeat the caller schedules.
 */
export function probeDelayMs(state: ReachabilityState): number | null {
  if (state.suspect) return 0;
  if (!state.reachable) {
    const step = Math.min(
      Math.max(state.failures - CONFIRM_FAILURES, 0),
      OFFLINE_BACKOFF_MS.length - 1,
    );
    return OFFLINE_BACKOFF_MS[step];
  }
  return state.failures > 0 ? RECHECK_DELAY_MS : null;
}
