/**
 * The wiring, not the logic.
 *
 * Every other suite in this feature injects its dependencies, which is what
 * makes them fast and honest about behaviour — and completely blind to how that
 * behaviour is connected to the application. Adversarial mutation testing put a
 * number on the gap: **0 of 6** mutants planted in `createDefaultResyncDeps`
 * and in `clearOfflineData`'s defaults were caught. Replacing `isEnabled` with
 * `() => true` bypassed the kill switch; replacing either open-page hook with
 * `() => null` let the manager open a second provider on the page the user was
 * reading; gutting the logout cleanup's real calls changed nothing. The suite
 * stayed green through all of it.
 *
 * These tests exercise the *default* arguments specifically. They are the only
 * ones here that care which function is called rather than what it computes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncMarkers = vi.hoisted(() => ({
  clearPageSyncMarkers: vi.fn(async () => {}),
  clearPageSyncMarkersExcept: vi.fn(async (_keep: readonly string[]) => {}),
}));
const dirtyPages = vi.hoisted(() => ({
  clearDirtyPages: vi.fn(async () => {}),
  listDirtyPages: vi.fn(async () => []),
  clearDirtyPage: vi.fn(async () => {}),
  markDirtyPageBlocked: vi.fn(async () => {}),
  selectPagesToResync: vi.fn(() => []),
  blockedPages: vi.fn(() => []),
}));
const persistedStore = vi.hoisted(() => ({
  deletePersistedQueryCache: vi.fn(async () => {}),
  stopPersistingQueryCache: vi.fn(),
}));

vi.mock("./sync-markers", () => syncMarkers);
vi.mock("./dirty-pages", () => dirtyPages);
vi.mock("./persisted-store", () => persistedStore);
vi.mock("./resync-session", () => ({ openResyncSession: vi.fn() }));
vi.mock("@/main", () => ({ queryClient: { getQueryData: () => undefined } }));
vi.mock("@/features/auth/services/auth-service", () => ({
  getCollabToken: vi.fn(),
}));

import { clearOfflineData } from "./clear-offline-data";
import { createDefaultResyncDeps } from "./resync-manager";
import { setResyncState } from "./resync-state";
import {
  claimOpenPage,
  getOpenPage,
  releaseOpenPage,
  resetOpenPageForTests,
} from "./open-page-registry";
import {
  OFFLINE_EDITING_STORAGE_KEY,
  setOfflineEditingEnabled,
} from "./offline-editing-settings";

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    value: online,
    configurable: true,
  });
}

describe("createDefaultResyncDeps — the manager's real dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpenPageForTests();
    localStorage.removeItem(OFFLINE_EDITING_STORAGE_KEY);
    setOnline(true);
  });

  afterEach(() => setOnline(true));

  it("reads the kill switch, rather than assuming it is on", () => {
    const deps = createDefaultResyncDeps();

    expect(deps.isEnabled()).toBe(false);
    setOfflineEditingEnabled(true);
    expect(deps.isEnabled()).toBe(true);
  });

  it("reads the browser's connectivity, rather than assuming it is online", () => {
    const deps = createDefaultResyncDeps();

    setOnline(false);
    expect(deps.isOnline()).toBe(false);
    setOnline(true);
    expect(deps.isOnline()).toBe(true);
  });

  it("reads the open-page registry the editor writes", () => {
    const deps = createDefaultResyncDeps();

    expect(deps.getOpenPage()).toBeNull();
    claimOpenPage("page-1");
    expect(deps.getOpenPage()).toBe("page-1");
    releaseOpenPage("page-1");
    expect(deps.getOpenPage()).toBeNull();
  });

  it("aborts a page the editor takes mid-push, re-reading the registry each time", () => {
    // The second of the two open-page exclusions, and the one that only matters
    // while a page is already in flight.
    const abort = createDefaultResyncDeps().perPageDeps!().shouldAbort;

    expect(abort("page-1")).toBe(false);
    claimOpenPage("page-1");
    expect(abort("page-1")).toBe(true);
    expect(abort("page-2")).toBe(false);
  });

  it("uses the non-throwing token reader for the auth verdict", () => {
    // A bare `jwtDecode` here throws on the undefined token an offline boot
    // produces, and a thrown error would be read as a failed pass forever.
    const { isTokenExpired } = createDefaultResyncDeps().perPageDeps!();

    expect(isTokenExpired(undefined as unknown as string)).toBe(true);
    expect(isTokenExpired("not-a-jwt")).toBe(true);
  });

  it("publishes into the store the UI subscribes to", () => {
    const deps = createDefaultResyncDeps();

    expect(deps.publish).toBe(setResyncState);
  });

  it("takes the cross-tab lock without queueing behind another tab", async () => {
    const requests: Array<{ name: string; options: unknown }> = [];
    const original = (globalThis.navigator as { locks?: unknown }).locks;
    Object.defineProperty(globalThis.navigator, "locks", {
      value: {
        request: async (
          name: string,
          options: unknown,
          fn: (lock: unknown) => Promise<unknown>,
        ) => {
          requests.push({ name, options });
          return fn({ name });
        },
      },
      configurable: true,
    });

    const deps = createDefaultResyncDeps();
    await expect(deps.withLock("docmost-offline-resync", async () => 7)).resolves.toBe(
      7,
    );

    // `ifAvailable` is what makes a second tab decline instead of running the
    // same work again a moment later.
    expect(requests).toEqual([
      { name: "docmost-offline-resync", options: { ifAvailable: true } },
    ]);

    Object.defineProperty(globalThis.navigator, "locks", {
      value: original,
      configurable: true,
    });
  });

  it("reports a declined lock as undefined, not as an empty pass", async () => {
    const original = (globalThis.navigator as { locks?: unknown }).locks;
    Object.defineProperty(globalThis.navigator, "locks", {
      value: {
        request: async (
          _name: string,
          _options: unknown,
          fn: (lock: unknown) => Promise<unknown>,
        ) => fn(null),
      },
      configurable: true,
    });

    const deps = createDefaultResyncDeps();
    await expect(deps.withLock("x", async () => 7)).resolves.toBeUndefined();

    Object.defineProperty(globalThis.navigator, "locks", {
      value: original,
      configurable: true,
    });
  });

  it("still runs in a browser with no Web Locks API", async () => {
    const original = (globalThis.navigator as { locks?: unknown }).locks;
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const deps = createDefaultResyncDeps();
    await expect(deps.withLock("x", async () => 7)).resolves.toBe(7);

    Object.defineProperty(globalThis.navigator, "locks", {
      value: original,
      configurable: true,
    });
  });

  it("wires the registry functions themselves", () => {
    const deps = createDefaultResyncDeps();

    expect(deps.listDirtyPages).toBe(dirtyPages.listDirtyPages);
    expect(deps.clearDirtyPage).toBe(dirtyPages.clearDirtyPage);
    expect(deps.markDirtyPageBlocked).toBe(dirtyPages.markDirtyPageBlocked);
  });
});

describe("clearOfflineData — the real cleanup calls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls the actual stores, not just whatever a test passed in", async () => {
    await clearOfflineData({ indexedDB: null, caches: null });

    expect(persistedStore.stopPersistingQueryCache).toHaveBeenCalledOnce();
    expect(persistedStore.deletePersistedQueryCache).toHaveBeenCalledOnce();
    expect(syncMarkers.clearPageSyncMarkers).toHaveBeenCalledOnce();
    expect(dirtyPages.clearDirtyPages).toHaveBeenCalledOnce();
  });

  it("narrows the marker store instead of clearing it when pages are preserved", async () => {
    await clearOfflineData({
      indexedDB: null,
      caches: null,
      preservePageIds: ["p1"],
      preserveDirtyPages: true,
    });

    expect(syncMarkers.clearPageSyncMarkersExcept).toHaveBeenCalledWith(["p1"]);
    expect(syncMarkers.clearPageSyncMarkers).not.toHaveBeenCalled();
    expect(dirtyPages.clearDirtyPages).not.toHaveBeenCalled();
  });

  it("still clears the registry when preservation names no pages", async () => {
    // `preserveDirtyPages` on its own would leave an index with nothing to
    // index, which is worse than clearing both.
    await clearOfflineData({
      indexedDB: null,
      caches: null,
      preserveDirtyPages: true,
    });

    expect(dirtyPages.clearDirtyPages).toHaveBeenCalledOnce();
    expect(syncMarkers.clearPageSyncMarkers).toHaveBeenCalledOnce();
  });
});
