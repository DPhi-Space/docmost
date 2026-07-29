import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const markers = new Map<string, number>();

// The real module opens IndexedDB, which jsdom does not implement. The store's
// own semantics are covered by `sync-markers.test.ts`; here the map stands in
// for the disk so the *hook's* read/write decisions are what is under test.
vi.mock("./sync-markers", () => ({
  hasPageRemoteSynced: vi.fn(async (pageId: string) => markers.has(pageId)),
  markPageRemoteSynced: vi.fn(async (pageId: string) => {
    if (!markers.has(pageId)) markers.set(pageId, 1);
  }),
  clearPageSyncMarkers: vi.fn(async () => markers.clear()),
}));

import { markPageRemoteSynced } from "./sync-markers";
import { useOfflineEditGate, type RemoteSyncSource } from "./offline-edit-gate";
import {
  OFFLINE_EDITING_STORAGE_KEY,
  setOfflineEditingEnabled,
} from "./offline-editing-settings";
import {
  reportPageUnavailable,
  resetOfflineEditStateForTests,
  useOfflineEditState,
} from "./offline-edit-state";
import { UNSYNCED_GRACE_MS } from "./unsynced-changes";

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    value: online,
    configurable: true,
  });
}

function fakeProvider(
  overrides: Partial<RemoteSyncSource> = {},
): RemoteSyncSource {
  return { synced: false, unsyncedChanges: 0, ...overrides };
}

function providersRef(remote: RemoteSyncSource | null) {
  return { current: remote ? { remote } : null };
}

/** Let the marker read (a resolved promise) land. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useOfflineEditGate", () => {
  beforeEach(() => {
    markers.clear();
    vi.clearAllMocks();
    resetOfflineEditStateForTests();
    localStorage.removeItem(OFFLINE_EDITING_STORAGE_KEY);
    setOnline(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it("stays closed and touches no storage while the switch is off", async () => {
    markers.set("page-1", 1);
    setOnline(false);

    const { result } = renderHook(() =>
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider({ synced: true })),
        isLocalSynced: true,
        connectionStatus: "connected",
      }),
    );
    await settle();

    expect(result.current.canEditOffline).toBe(false);
    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("opens for a marked page on an offline device", async () => {
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);

    const { result } = renderHook(() =>
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider()),
        isLocalSynced: true,
        connectionStatus: "disconnected",
      }),
    );
    await settle();

    expect(result.current.canEditOffline).toBe(true);
  });

  it("stays closed offline for a page that was never synced here", async () => {
    setOfflineEditingEnabled(true);
    setOnline(false);

    const { result } = renderHook(() =>
      useOfflineEditGate({
        pageId: "never-opened",
        providers: providersRef(fakeProvider()),
        isLocalSynced: true,
        connectionStatus: "disconnected",
      }),
    );
    await settle();

    expect(result.current.canEditOffline).toBe(false);
  });

  it("does not carry one page's permission over to the next", async () => {
    // `PageEditor` is not remounted on navigation, so the hook is re-rendered
    // with a new `pageId` while every piece of its state survives.
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);

    const { result, rerender } = renderHook(
      (pageId: string) =>
        useOfflineEditGate({
          pageId,
          providers: providersRef(fakeProvider()),
          isLocalSynced: true,
          connectionStatus: "disconnected",
        }),
      { initialProps: "page-1" },
    );
    await settle();
    expect(result.current.canEditOffline).toBe(true);

    rerender("page-2");
    await settle();

    expect(result.current.canEditOffline).toBe(false);
  });

  it("writes a marker once the provider itself reports a completed handshake", async () => {
    setOfflineEditingEnabled(true);

    renderHook(() =>
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider({ synced: true })),
        isLocalSynced: true,
        connectionStatus: "connected",
      }),
    );
    await settle();

    expect(markPageRemoteSynced).toHaveBeenCalledWith("page-1");
  });

  it("refuses to write a marker on a connection whose document has not synced", async () => {
    // The exact hazard the provider is read through a ref for: a stale
    // `Connected` status plus a provider that has not handshaked must not be
    // mistaken for a real remote sync.
    setOfflineEditingEnabled(true);

    renderHook(() =>
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider({ synced: false })),
        isLocalSynced: true,
        connectionStatus: "connected",
      }),
    );
    await settle();

    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("refuses to write a marker while the socket is not connected", async () => {
    setOfflineEditingEnabled(true);

    renderHook(() =>
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider({ synced: true })),
        isLocalSynced: true,
        connectionStatus: "disconnected",
      }),
    );
    await settle();

    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("clears a page-unavailable report once the page syncs again", async () => {
    setOfflineEditingEnabled(true);
    reportPageUnavailable("page-1");

    const { result } = renderHook(() => {
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider({ synced: true })),
        isLocalSynced: true,
        connectionStatus: "connected",
      });
      return useOfflineEditState();
    });
    await settle();

    expect(result.current.unavailablePageId).toBeNull();
  });

  it("raises the warning when the provider's counter will not drain", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const provider = fakeProvider({ synced: true, unsyncedChanges: 3 });

    const { result } = renderHook(() => {
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(provider),
        isLocalSynced: true,
        connectionStatus: "connected",
      });
      return useOfflineEditState();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS - 1_000);
    });
    expect(result.current.unsyncedChangesWarning).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.unsyncedChangesWarning).toBe(true);
  });

  it("raises no warning while the counter drains normally", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const provider = { synced: true, unsyncedChanges: 0 };

    const { result } = renderHook(() => {
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(provider),
        isLocalSynced: true,
        connectionStatus: "connected",
      });
      return useOfflineEditState();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS * 3);
    });

    expect(result.current.unsyncedChangesWarning).toBe(false);
  });

  it("raises no warning for edits made while offline", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    setOnline(false);
    const provider = fakeProvider({ synced: false, unsyncedChanges: 12 });

    const { result } = renderHook(() => {
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(provider),
        isLocalSynced: true,
        connectionStatus: "disconnected",
      });
      return useOfflineEditState();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS * 5);
    });

    expect(result.current.unsyncedChangesWarning).toBe(false);
  });

  it("publishes the offline-editing state the banner renders from", async () => {
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);

    const { result, unmount } = renderHook(() => {
      useOfflineEditGate({
        pageId: "page-1",
        providers: providersRef(fakeProvider()),
        isLocalSynced: true,
        connectionStatus: "disconnected",
      });
      return useOfflineEditState();
    });
    await settle();
    expect(result.current.offlineEditingActive).toBe(true);

    unmount();

    // Nothing should keep claiming the editor is offline once it is gone.
    const { result: after } = renderHook(() => useOfflineEditState());
    expect(after.current.offlineEditingActive).toBe(false);
  });
});
