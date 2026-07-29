import { describe, expect, it, vi } from "vitest";
import { seedQueryOnlineState } from "./online-state";

const manager = () => ({ setOnline: vi.fn() });

describe("seedQueryOnlineState", () => {
  it("tells React Query it is offline when the browser already is", () => {
    const m = manager();
    seedQueryOnlineState(m, { onLine: false });
    expect(m.setOnline).toHaveBeenCalledWith(false);
  });

  it("leaves the manager alone when the browser is online", () => {
    // `true` is already the manager's initial value; asserting it would risk
    // overwriting a genuine `offline` event that arrived before this ran.
    const m = manager();
    seedQueryOnlineState(m, { onLine: true });
    expect(m.setOnline).not.toHaveBeenCalled();
  });

  it("leaves the manager alone where there is no navigator", () => {
    const m = manager();
    seedQueryOnlineState(m, undefined);
    expect(m.setOnline).not.toHaveBeenCalled();
  });
});
