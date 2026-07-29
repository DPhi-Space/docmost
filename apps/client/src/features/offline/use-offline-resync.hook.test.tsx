/**
 * Ownership reconciliation is a privacy control, not a feature.
 *
 * The audit's second leak trigger was exactly this: the reconcile lived inside
 * a hook that began `if (!enabled) return`, so a user who turned the
 * offline-editing switch off thereby turned off the cleanup that keeps the
 * previous user's documents out of their session. The owner had been recorded
 * correctly and it made no difference.
 *
 * These tests pin the split: the *loop* follows the switch, the *safeguard*
 * never does.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ownership = vi.hoisted(() => ({
  reconcileOfflineDataOwnership: vi.fn(async () => "clean" as const),
}));
const dirtyPages = vi.hoisted(() => ({
  setOfflineDataOwner: vi.fn(async () => true),
}));
vi.mock("./dirty-pages", () => dirtyPages);
const manager = vi.hoisted(() => ({
  createResyncManager: vi.fn(() => ({ trigger: vi.fn(), stop: vi.fn() })),
  RESYNC_LOCK_NAME: "docmost-offline-resync",
}));

const userService = vi.hoisted(() => ({ getMyInfo: vi.fn() }));
vi.mock("@/features/user/services/user-service", () => userService);
vi.mock("./data-ownership", () => ownership);
vi.mock("./resync-manager", () => manager);
vi.mock("./resync-state", () => ({ resetResyncState: vi.fn() }));

import {
  useOfflineDataOwnership,
  useOfflineResync,
} from "./use-offline-resync";
import {
  OFFLINE_DATA_OWNER_KEY,
  PENDING_RECOVERY_KEY,
} from "./session-expiry";

const USER = { user: { id: "user-1" } };
const PREVIOUS_USER = { user: { id: "previous-user" } };

function wrapper(seed?: unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed !== undefined) client.setQueryData(["currentUser"], seed);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useOfflineDataOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userService.getMyInfo.mockResolvedValue(USER);
    ownership.reconcileOfflineDataOwnership.mockResolvedValue("clean" as never);
    dirtyPages.setOfflineDataOwner.mockResolvedValue(true);
    Object.defineProperty(window.navigator, "onLine", {
      value: true,
      configurable: true,
    });
    localStorage.removeItem(OFFLINE_DATA_OWNER_KEY);
    localStorage.removeItem(PENDING_RECOVERY_KEY);
  });

  it("reconciles on sign-in", async () => {
    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalledWith(
        "user-1",
      ),
    );
  });

  it("reconciles with the offline-editing switch off", async () => {
    // The hook takes no `enabled` argument at all — there is nowhere for the
    // switch to be consulted. Turning a feature off must not turn a safeguard
    // off with it.
    expect(useOfflineDataOwnership.length).toBe(0);

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalledOnce(),
    );
  });

  it("records the owner hint the 401 handler will read", async () => {
    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(localStorage.getItem(OFFLINE_DATA_OWNER_KEY)).toBe("user-1"),
    );
  });

  it("stamps the disk on every authenticated boot, not only after a 401", async () => {
    // Two ways existed for offline data to end up unstamped, both read by
    // reconcile as "nothing preserved, so it is yours": `redirectToLogin` does
    // not await the cleanup before navigating, and a user landing straight on
    // /auth/login never fires a 401 at all. Stamping every boot makes an absent
    // stamp mean "a browser that has never held anyone's offline data".
    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(dirtyPages.setOfflineDataOwner).toHaveBeenCalledWith("user-1"),
    );
  });

  it("stamps only after reconcile has decided", async () => {
    // Ordering is the whole safety argument: stamping first would relabel data
    // reconcile was about to identify as somebody else's, turning the check
    // that protects the previous user into the thing that hides them.
    const order: string[] = [];
    ownership.reconcileOfflineDataOwnership.mockImplementation(async () => {
      order.push("reconcile");
      return "erased" as never;
    });
    dirtyPages.setOfflineDataOwner.mockImplementation(async () => {
      order.push("stamp");
      return true;
    });

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() => expect(order).toEqual(["reconcile", "stamp"]));
  });

  it("re-writes the owner hint after an erase wiped it", async () => {
    // Reconcile's erase path runs `clearOfflineData()`, which drops the hint.
    // Without rewriting it, a 401 later in that same session would find no
    // hint and destroy the new user's pending work instead of preserving it.
    ownership.reconcileOfflineDataOwnership.mockImplementation(async () => {
      localStorage.removeItem(OFFLINE_DATA_OWNER_KEY);
      return "erased" as never;
    });

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(localStorage.getItem(OFFLINE_DATA_OWNER_KEY)).toBe("user-1"),
    );
  });

  it("stamps nothing while ownership is deferred", async () => {
    // Nothing decided means nothing claimed.
    ownership.reconcileOfflineDataOwnership.mockResolvedValue(
      "deferred" as never,
    );

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalled(),
    );
    expect(dirtyPages.setOfflineDataOwner).not.toHaveBeenCalled();
    expect(localStorage.getItem(OFFLINE_DATA_OWNER_KEY)).toBeNull();
  });

  it("refuses, rather than settling, when no user can be identified", async () => {
    userService.getMyInfo.mockRejectedValue(new Error("401"));
    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper() });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalledWith(null),
    );
    expect(localStorage.getItem(OFFLINE_DATA_OWNER_KEY)).toBeNull();
  });

  it("asks the server rather than believing a restored cache", async () => {
    // The audit's third trigger survived the first attempt at this fix here:
    // the next user signs in, the app boots holding the *previous* user's
    // identity in a restored cache, and the mismatch is never seen. Waiting for
    // the app to refetch does not work either — its defaults are
    // `refetchOnMount: false` with a five-minute `staleTime`, and a browser run
    // confirmed `/users/me` is never requested on a warm-cache boot.
    userService.getMyInfo.mockResolvedValue(USER);

    renderHook(() => useOfflineDataOwnership(), {
      wrapper: wrapper(PREVIOUS_USER),
    });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalledWith(
        "user-1",
      ),
    );
    expect(userService.getMyInfo).toHaveBeenCalled();
    expect(ownership.reconcileOfflineDataOwnership).not.toHaveBeenCalledWith(
      "previous-user",
    );
  });

  it("trusts the restored cache when there is no network to sign in over", async () => {
    // Offline, nobody can have signed in, so the cached user is the only user
    // there is — and refusing here would break offline editing for its owner.
    // The request is not even attempted: `networkMode: "online"` would pause it
    // forever, leaving ownership unsettled.
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
    });

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalledWith(
        "user-1",
      ),
    );
    expect(userService.getMyInfo).not.toHaveBeenCalled();
  });

  it("refuses — never guesses from the cache — when the identity request fails", async () => {
    // Falling back here was observed to guess wrong: the request lost a race
    // with a new session, the restored cache answered with the *previous*
    // user, ownership settled as "ours", and the manager pushed that user's
    // document under the new user's cookie.
    userService.getMyInfo.mockRejectedValue(new Error("network"));

    renderHook(() => useOfflineDataOwnership(), {
      wrapper: wrapper(PREVIOUS_USER),
    });

    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalledWith(null),
    );
    expect(ownership.reconcileOfflineDataOwnership).not.toHaveBeenCalledWith(
      "previous-user",
    );
  });

  it("consumes the login notice only after ownership is settled", async () => {
    localStorage.setItem(
      PENDING_RECOVERY_KEY,
      JSON.stringify({ at: 1, ownerUserId: "user-1", pages: [{ pageId: "p" }] }),
    );

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });

    await waitFor(() =>
      expect(localStorage.getItem(PENDING_RECOVERY_KEY)).toBeNull(),
    );
  });

  it("leaves the notice alone while ownership cannot be decided", async () => {
    // The notice is an announcement, never a trigger — treating "the notice is
    // gone" as "the data is settled" was the third leak.
    ownership.reconcileOfflineDataOwnership.mockResolvedValueOnce(
      "deferred" as never,
    );
    const notice = JSON.stringify({
      at: 1,
      ownerUserId: "user-1",
      pages: [{ pageId: "p" }],
    });
    localStorage.setItem(PENDING_RECOVERY_KEY, notice);

    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper(USER) });
    await waitFor(() =>
      expect(ownership.reconcileOfflineDataOwnership).toHaveBeenCalled(),
    );

    expect(localStorage.getItem(PENDING_RECOVERY_KEY)).toBe(notice);
  });
});

describe("useOfflineResync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts no manager while the switch is off", () => {
    renderHook(() => useOfflineResync(false), { wrapper: wrapper(USER) });

    expect(manager.createResyncManager).not.toHaveBeenCalled();
  });

  it("starts the manager when the switch is on", () => {
    renderHook(() => useOfflineResync(true), { wrapper: wrapper(USER) });

    expect(manager.createResyncManager).toHaveBeenCalledOnce();
  });
});
