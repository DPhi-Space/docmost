import { describe, it, expect } from "vitest";
import {
  UpdateEffect,
  UpdateEvent,
  createUpdateController,
  nextUpdateState,
} from "./update-state";

const run = (events: UpdateEvent[]) => {
  const effects: UpdateEffect[] = [];
  const controller = createUpdateController((effect) => effects.push(effect));
  for (const event of events) controller.send(event);
  return { state: controller.state, effects };
};

describe("nextUpdateState", () => {
  it("prompts once when a waiting worker appears", () => {
    expect(nextUpdateState("idle", { type: "waiting-detected" })).toEqual({
      state: "update-available",
      effects: ["show-prompt"],
    });
  });

  it("does not re-prompt while the prompt is already up", () => {
    expect(
      nextUpdateState("update-available", { type: "waiting-detected" }),
    ).toEqual({ state: "update-available", effects: [] });
  });

  it("stays quiet after the user dismisses the prompt", () => {
    expect(nextUpdateState("dismissed", { type: "waiting-detected" })).toEqual({
      state: "dismissed",
      effects: [],
    });
  });

  it("only hands over when the user asks", () => {
    expect(
      nextUpdateState("update-available", { type: "reload-requested" }),
    ).toEqual({ state: "reloading", effects: ["hide-prompt", "skip-waiting"] });
  });

  it("ignores a reload request that was never prompted for", () => {
    expect(nextUpdateState("idle", { type: "reload-requested" })).toEqual({
      state: "idle",
      effects: [],
    });
  });

  it("reloads only after a handover this tab initiated", () => {
    expect(
      nextUpdateState("reloading", { type: "controller-changed" }),
    ).toEqual({ state: "reloading", effects: ["reload-page"] });
  });

  it("never reloads on a controller change this tab did not initiate", () => {
    // First-ever activation calls clients.claim(), and another tab accepting an
    // update also fires controllerchange here. Neither may reload an editor.
    for (const state of ["idle", "update-available", "dismissed"] as const) {
      expect(nextUpdateState(state, { type: "controller-changed" })).toEqual({
        state,
        effects: [],
      });
    }
  });
});

describe("update flow", () => {
  it("prompt -> accept -> handover -> reload", () => {
    expect(
      run([
        { type: "waiting-detected" },
        { type: "reload-requested" },
        { type: "controller-changed" },
      ]),
    ).toEqual({
      state: "reloading",
      effects: ["show-prompt", "hide-prompt", "skip-waiting", "reload-page"],
    });
  });

  it("a silent activation never reloads the tab", () => {
    expect(run([{ type: "controller-changed" }])).toEqual({
      state: "idle",
      effects: [],
    });
  });

  it("dismissing hides the prompt and suppresses the update poll for the session", () => {
    expect(
      run([
        { type: "waiting-detected" },
        { type: "dismissed" },
        { type: "waiting-detected" },
        { type: "waiting-detected" },
      ]),
    ).toEqual({ state: "dismissed", effects: ["show-prompt", "hide-prompt"] });
  });

  it("hiding the prompt on accept does not re-enter dismissal", () => {
    // The Mantine notification fires onClose when we hide it programmatically,
    // which sends a `dismissed` event after the state is already `reloading`.
    expect(
      run([
        { type: "waiting-detected" },
        { type: "reload-requested" },
        { type: "dismissed" },
        { type: "controller-changed" },
      ]),
    ).toEqual({
      state: "reloading",
      effects: ["show-prompt", "hide-prompt", "skip-waiting", "reload-page"],
    });
  });

  it("repeated update polls prompt exactly once", () => {
    const { effects } = run([
      { type: "waiting-detected" },
      { type: "waiting-detected" },
      { type: "waiting-detected" },
    ]);
    expect(effects).toEqual(["show-prompt"]);
  });
});
