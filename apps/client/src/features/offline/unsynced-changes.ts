/**
 * Detecting edits the server accepted the connection for and then threw away.
 *
 * ## What the server does
 *
 * `apps/server/src/collaboration/extensions/authentication.extension.ts` marks a
 * connection `readOnly` for space READERs, page-level restrictions, **the fork's
 * page lock** (via `canUserEditPage`) and trashed pages. Authentication still
 * *succeeds* — the connection is live, the document syncs down, awareness works.
 * Hocuspocus 3.4.4's server then answers every inbound update on such a
 * connection with `SyncStatus(false)` (`hocuspocus-server.esm.js`, the
 * `messageYjsUpdate` and `messageYjsSyncStep2` branches) and drops it.
 *
 * ## What the 3.4.4 provider does with that answer
 *
 * Nothing:
 *
 * ```js
 * applySyncStatusMessage(provider, applied) {
 *   if (applied) { provider.decrementUnsyncedChanges(); }
 * }
 * ```
 *
 * There is no `false` branch — no event, no error, no callback. The write is
 * lost server-side and the client is never told.
 *
 * The observable consequence is a counter that never drains.
 * `HocuspocusProvider` 3.4.4 *does* expose the counter three ways: the public
 * `unsyncedChanges: number` property, the `hasUnsyncedChanges` getter, and an
 * `unsyncedChanges` event (`provider.on("unsyncedChanges", …)` / the
 * `onUnsyncedChanges` config hook) carrying `{ number }`. The event fires on
 * every increment and decrement — but a dropped write produces *no* transition,
 * so the event alone can never tell you the drop happened. What distinguishes a
 * dropped write from a slow one is only **time**: on a healthy connection the
 * counter returns to zero within milliseconds of each edit; on a read-only one
 * it is pinned above zero forever. Hence a sampled counter plus a grace period
 * rather than an event subscription — one mechanism instead of two, since the
 * timer is required either way.
 *
 * The reducer below is pure so that the grace-period semantics are pinned by
 * tests rather than by a browser.
 */

/** Default grace before a non-draining counter is reported. */
export const UNSYNCED_GRACE_MS = 10_000;

export interface UnsyncedSample {
  /**
   * The connection is up **and** the initial handshake completed. Before that,
   * a positive counter means nothing: `startSync()` deliberately seeds it to 1.
   */
  hasLiveSync: boolean;
  /** `HocuspocusProvider.unsyncedChanges`. */
  unsyncedChanges: number;
  /** Monotonic-enough clock reading; `Date.now()` in the hook. */
  now: number;
}

export interface UnsyncedState {
  /** When the counter was first seen above zero on a live, synced connection. */
  pendingSince: number | null;
  /** Latched: the user has unsynced local edits the server would not take. */
  warned: boolean;
}

export const initialUnsyncedState: UnsyncedState = {
  pendingSince: null,
  warned: false,
};

/**
 * Fold one sample into the detector state.
 *
 * Three rules, each earning its keep:
 *
 * 1. **No live sync ⇒ no judgement.** While offline or mid-handshake a positive
 *    counter is the *normal* state; treating it as a failure would fire the
 *    warning on every offline edit, which is exactly the case the feature is
 *    for. Note that an existing warning is *not* cleared here: losing the
 *    connection does not retroactively make the dropped writes land.
 * 2. **Live sync, counter above zero ⇒ start (or continue) the clock**, and
 *    latch the warning once the grace period has elapsed. Healthy editing keeps
 *    resetting this because each update is acknowledged within milliseconds.
 * 3. **Live sync, counter at zero ⇒ everything landed.** This is the only way
 *    the warning clears — reconnecting to a page whose lock was lifted drains
 *    the counter and the banner disappears on its own.
 *
 * The local document is never touched, in any branch. A warning is information;
 * discarding a user's work to resolve it is not this module's decision to make,
 * and is not offered anywhere in the feature.
 */
export function nextUnsyncedState(
  state: UnsyncedState,
  sample: UnsyncedSample,
  graceMs: number = UNSYNCED_GRACE_MS,
): UnsyncedState {
  if (!sample.hasLiveSync) {
    return state.pendingSince === null ? state : { ...state, pendingSince: null };
  }

  if (sample.unsyncedChanges <= 0) {
    return state.pendingSince === null && !state.warned
      ? state
      : initialUnsyncedState;
  }

  const pendingSince = state.pendingSince ?? sample.now;
  const warned = state.warned || sample.now - pendingSince >= graceMs;
  return pendingSince === state.pendingSince && warned === state.warned
    ? state
    : { pendingSince, warned };
}
