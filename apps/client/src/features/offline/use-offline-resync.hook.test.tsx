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
const manager = vi.hoisted(() => ({
  createResyncManager: vi.fn(() => ({ trigger: vi.fn(), stop: vi.fn() })),
  RESYNC_LOCK_NAME: "docmost-offline-resync",
}));

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

  it("does nothing at all until a user is known", async () => {
    renderHook(() => useOfflineDataOwnership(), { wrapper: wrapper() });

    await Promise.resolve();
    expect(ownership.reconcileOfflineDataOwnership).not.toHaveBeenCalled();
    expect(localStorage.getItem(OFFLINE_DATA_OWNER_KEY)).toBeNull();
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
