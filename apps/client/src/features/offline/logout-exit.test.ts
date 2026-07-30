import { describe, expect, it, vi } from "vitest";
import { performLogoutExit } from "./logout-exit";

describe("performLogoutExit", () => {
  it("runs server logout, cleanup, then navigation, in order", async () => {
    const order: string[] = [];
    await performLogoutExit({
      serverLogout: async () => {
        order.push("server");
      },
      clearOfflineData: async () => {
        order.push("clear");
      },
      navigateToLogin: () => order.push("navigate"),
    });
    expect(order).toEqual(["server", "clear", "navigate"]);
  });

  it("BUG 2 regression: an offline logout (transport failure) still clears and navigates", async () => {
    const clearOfflineData = vi.fn(async () => {});
    const navigateToLogin = vi.fn();
    await performLogoutExit({
      serverLogout: async () => {
        // What axios produces when POST /api/auth/logout cannot reach the
        // server — the exact failure that used to wedge the app.
        throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
      },
      clearOfflineData,
      navigateToLogin,
    });
    expect(clearOfflineData).toHaveBeenCalledTimes(1);
    expect(navigateToLogin).toHaveBeenCalledTimes(1);
  });

  it("navigates even when the cleanup itself throws", async () => {
    const navigateToLogin = vi.fn();
    await performLogoutExit({
      serverLogout: async () => {},
      clearOfflineData: async () => {
        throw new Error("IndexedDB is gone");
      },
      navigateToLogin,
    });
    expect(navigateToLogin).toHaveBeenCalledTimes(1);
  });

  it("never rejects, whatever the dependencies do", async () => {
    await expect(
      performLogoutExit({
        serverLogout: async () => {
          throw new Error("boom");
        },
        clearOfflineData: async () => {
          throw new Error("boom");
        },
        navigateToLogin: () => {
          /* navigation itself is fire-and-forget */
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("still calls the server first when it succeeds (session revoked before local teardown)", async () => {
    const order: string[] = [];
    const serverLogout = vi.fn(async () => {
      order.push("server");
    });
    await performLogoutExit({
      serverLogout,
      clearOfflineData: async () => {
        order.push("clear");
      },
      navigateToLogin: () => order.push("navigate"),
    });
    expect(serverLogout).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("server");
  });
});
