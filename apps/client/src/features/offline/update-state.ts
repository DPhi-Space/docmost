/**
 * The service-worker update prompt, as a pure state machine.
 *
 * The rule this encodes: **the worker never takes over on its own.** A new
 * build installs and then waits; the tab keeps running the old bundle until the
 * user explicitly accepts. An editor session must never be reloaded from under
 * someone mid-typing, which is exactly what `skipWaiting()` in the worker's
 * `install` handler would do.
 */

export type UpdateState =
  /** No newer worker known. */
  | "idle"
  /** A newer worker is installed and waiting; the prompt is on screen. */
  | "update-available"
  /** The user accepted; we asked the worker to take over and are awaiting it. */
  | "reloading"
  /** The user dismissed the prompt; stay quiet for the rest of this session. */
  | "dismissed";

export type UpdateEvent =
  /** A waiting worker was observed (on registration, on updatefound, on poll). */
  | { type: "waiting-detected" }
  /** The user pressed "Reload". */
  | { type: "reload-requested" }
  /** `navigator.serviceWorker.controller` changed. */
  | { type: "controller-changed" }
  /** The user closed the prompt. */
  | { type: "dismissed" };

export type UpdateEffect =
  | "show-prompt"
  | "hide-prompt"
  | "skip-waiting"
  | "reload-page";

export interface UpdateTransition {
  state: UpdateState;
  effects: UpdateEffect[];
}

export const INITIAL_UPDATE_STATE: UpdateState = "idle";

export function nextUpdateState(
  state: UpdateState,
  event: UpdateEvent,
): UpdateTransition {
  switch (event.type) {
    case "waiting-detected":
      // Re-notifying an already-prompted or deliberately-dismissed user is
      // noise: the periodic update poll fires this repeatedly.
      return state === "idle"
        ? { state: "update-available", effects: ["show-prompt"] }
        : { state, effects: [] };

    case "reload-requested":
      return state === "update-available"
        ? { state: "reloading", effects: ["hide-prompt", "skip-waiting"] }
        : { state, effects: [] };

    case "controller-changed":
      // Only reload when *we* asked for the handover. A controllerchange we did
      // not initiate (another tab accepted the update, or the first-ever
      // activation calling clients.claim()) must not reload this tab.
      return state === "reloading"
        ? { state: "reloading", effects: ["reload-page"] }
        : { state, effects: [] };

    case "dismissed":
      return state === "update-available"
        ? { state: "dismissed", effects: ["hide-prompt"] }
        : { state, effects: [] };

    default:
      return { state, effects: [] };
  }
}

/**
 * Thin stateful wrapper so callers do not have to thread the state themselves.
 * Effects are handed to `onEffect` in order.
 */
export function createUpdateController(
  onEffect: (effect: UpdateEffect) => void,
) {
  let state: UpdateState = INITIAL_UPDATE_STATE;
  return {
    get state() {
      return state;
    },
    send(event: UpdateEvent) {
      const transition = nextUpdateState(state, event);
      state = transition.state;
      for (const effect of transition.effects) onEffect(effect);
      return state;
    },
  };
}
