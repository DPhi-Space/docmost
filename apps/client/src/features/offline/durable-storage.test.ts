import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDurableStorageVerdict,
  requestDurableStorage,
  resetDurableStorageForTests,
  type DurableStorageDeps,
  type StorageManagerLike,
} from "./durable-storage";

function manager(overrides: Partial<StorageManagerLike> = {}): StorageManagerLike & {
  persistCalls: number;
} {
  const state = { persistCalls: 0 };
  return Object.assign(state, {
    persisted: async () => false,
    persist: async () => {
      state.persistCalls += 1;
      return true;
    },
    ...overrides,
  });
}

function deps(overrides: Partial<DurableStorageDeps> = {}): DurableStorageDeps {
  return {
    storageManager: manager(),
    isEnabled: () => true,
    log: () => {},
    ...overrides,
  };
}

describe("requestDurableStorage", () => {
  beforeEach(resetDurableStorageForTests);

  it("asks and records a grant", async () => {
    expect(await requestDurableStorage(deps())).toBe("granted");
    expect(getDurableStorageVerdict()).toBe("granted");
  });

  it("records a denial without changing behaviour", async () => {
    const verdict = await requestDurableStorage(
      deps({ storageManager: manager({ persist: async () => false }) }),
    );
    expect(verdict).toBe("denied");
  });

  it("NEVER touches the API while the switch is off", async () => {
    // Firefox answers persist() with a user-facing permission prompt. A user
    // who never opted into offline editing must never see it — the gate lives
    // inside this module, not in call sites that can forget it.
    const m = manager();
    const persisted = vi.fn(async () => false);
    m.persisted = persisted;

    const verdict = await requestDurableStorage(
      deps({ storageManager: m, isEnabled: () => false }),
    );

    expect(verdict).toBe("unknown");
    expect(persisted).not.toHaveBeenCalled();
    expect(m.persistCalls).toBe(0);
  });

  it("does not re-prompt an origin that is already persisted", async () => {
    const m = manager({ persisted: async () => true });
    const verdict = await requestDurableStorage(deps({ storageManager: m }));

    expect(verdict).toBe("granted");
    expect(m.persistCalls).toBe(0);
  });

  it("reports unsupported browsers without throwing", async () => {
    expect(await requestDurableStorage(deps({ storageManager: null }))).toBe(
      "unsupported",
    );
  });

  it("keeps the previous verdict when the API throws", async () => {
    await requestDurableStorage(deps());
    const verdict = await requestDurableStorage(
      deps({
        storageManager: manager({
          persisted: async () => {
            throw new Error("blocked");
          },
        }),
      }),
    );
    expect(verdict).toBe("granted");
  });

  it("logs the outcome so the verdict is observable in a real browser", async () => {
    const log = vi.fn();
    await requestDurableStorage(
      deps({ storageManager: manager({ persist: async () => false }), log }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("denied"));
  });
});
