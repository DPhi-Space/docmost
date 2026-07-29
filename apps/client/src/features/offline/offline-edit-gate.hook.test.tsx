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

const dirty = new Map<string, number>();

// Same reasoning as the sync-marker stub above: the registry's own semantics
// are `dirty-pages.test.ts`; here the map stands in for the disk so the hook's
// record/clear *decisions* are what is under test.
vi.mock("./dirty-pages", () => ({
  recordDirtyPage: vi.fn(async (pageId: string) => {
    dirty.set(pageId, (dirty.get(pageId) ?? 0) + 1);
  }),
  clearDirtyPage: vi.fn(async (pageId: string) => void dirty.delete(pageId)),
}));

import { markPageRemoteSynced } from "./sync-markers";
import { clearDirtyPage, recordDirtyPage } from "./dirty-pages";
import { getOpenPage, resetOpenPageForTests } from "./open-page-registry";
import type { DocUpdateSource } from "./dirty-tracking";
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

function providersRef(remote: RemoteSyncSource | null, local?: unknown) {
  return { current: remote ? { remote, local } : null };
}

/** A `Y.Doc` stand-in that lets a test emit updates with a chosen origin. */
function fakeDoc() {
  const handlers = new Set<(update: Uint8Array, origin: unknown) => void>();
  const doc: DocUpdateSource = {
    on: (_e, handler) => void handlers.add(handler),
    off: (_e, handler) => void handlers.delete(handler),
  };
  return {
    doc,
    emit: (origin: unknown) => {
      for (const handler of [...handlers]) handler(new Uint8Array(), origin);
    },
  };
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
    dirty.clear();
    vi.clearAllMocks();
    resetOpenPageForTests();
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

describe("useOfflineEditGate — dirty tracking (phase 3)", () => {
  const local = { kind: "IndexeddbPersistence" };
  const editor = { key: "y-sync$" };

  beforeEach(() => {
    markers.clear();
    dirty.clear();
    vi.clearAllMocks();
    resetOpenPageForTests();
    resetOfflineEditStateForTests();
    localStorage.removeItem(OFFLINE_EDITING_STORAGE_KEY);
    setOnline(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  const mount = (
    overrides: {
      connectionStatus?: string;
      synced?: boolean;
      unsyncedChanges?: number;
      pageId?: string;
    } = {},
  ) => {
    const { doc, emit } = fakeDoc();
    const remote: RemoteSyncSource = {
      synced: overrides.synced ?? false,
      unsyncedChanges: overrides.unsyncedChanges ?? 0,
      document: doc,
    };
    const refs = providersRef(remote, local);
    const view = renderHook(
      (pageId: string) =>
        useOfflineEditGate({
          pageId,
          providers: refs,
          isLocalSynced: true,
          connectionStatus: overrides.connectionStatus ?? "disconnected",
        }),
      { initialProps: overrides.pageId ?? "page-1" },
    );
    return { emit, view, remote, refs };
  };

  it("records a page the user edits while its provider is disconnected", async () => {
    setOfflineEditingEnabled(true);
    const { emit } = mount();
    await settle();

    act(() => emit(editor));

    expect(recordDirtyPage).toHaveBeenCalledWith("page-1", undefined);
  });

  it("records nothing while the switch is off", async () => {
    // Phase 2's promise: off means no new behaviour, and no database created.
    const { emit } = mount();
    await settle();

    act(() => emit(editor));

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("records nothing for the y-indexeddb replay of a page opened offline", async () => {
    // Otherwise every page merely *read* offline would queue for a background
    // sync — and, if locked, be reported to the user as blocked.
    setOfflineEditingEnabled(true);
    const { emit } = mount();
    await settle();

    act(() => emit(local));

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("records nothing while the page's own provider is connected", async () => {
    setOfflineEditingEnabled(true);
    const { emit } = mount({ connectionStatus: "connected", synced: true });
    await settle();

    act(() => emit(editor));

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("clears the entry once a real handshake drains the counter", async () => {
    setOfflineEditingEnabled(true);
    mount({ connectionStatus: "connected", synced: true, unsyncedChanges: 0 });
    await settle();

    expect(clearDirtyPage).toHaveBeenCalledWith("page-1");
  });

  it("does not clear while the counter is still above zero", async () => {
    // The read-only signature: the server took the connection and dropped the
    // writes. Forgetting the page here would lose the only pointer to them.
    setOfflineEditingEnabled(true);
    mount({ connectionStatus: "connected", synced: true, unsyncedChanges: 2 });
    await settle();

    expect(clearDirtyPage).not.toHaveBeenCalled();
  });

  it("does not clear on a connected socket whose document has not synced", async () => {
    setOfflineEditingEnabled(true);
    mount({ connectionStatus: "connected", synced: false, unsyncedChanges: 0 });
    await settle();

    expect(clearDirtyPage).not.toHaveBeenCalled();
  });

  it("clears once per page rather than once per second", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    mount({ connectionStatus: "connected", synced: true, unsyncedChanges: 0 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(clearDirtyPage).toHaveBeenCalledTimes(1);
  });

  it("re-aims tracking at the new page after a navigation, exactly once", async () => {
    // `PageEditor` is not remounted across navigation, so the subscription has
    // to follow `pageId` — and a stale listener left behind would record the
    // previous page a second time on every keystroke.
    setOfflineEditingEnabled(true);
    const { emit, view } = mount();
    await settle();

    view.rerender("page-2");
    await settle();
    act(() => emit(editor));

    expect(recordDirtyPage).toHaveBeenCalledTimes(1);
    expect(recordDirtyPage).toHaveBeenCalledWith("page-2", undefined);
  });

  it("unsubscribes when the editor unmounts", async () => {
    setOfflineEditingEnabled(true);
    const { emit, view } = mount();
    await settle();

    view.unmount();
    emit(editor);

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });
});

describe("useOfflineEditGate — open-document claim (phase 3)", () => {
  beforeEach(() => {
    markers.clear();
    dirty.clear();
    resetOpenPageForTests();
    resetOfflineEditStateForTests();
    localStorage.removeItem(OFFLINE_EDITING_STORAGE_KEY);
  });

  const render = (pageId: string) =>
    renderHook(
      (id: string) =>
        useOfflineEditGate({
          pageId: id,
          providers: providersRef(fakeProvider()),
          isLocalSynced: true,
          connectionStatus: "disconnected",
        }),
      { initialProps: pageId },
    );

  it("claims the document the editor is showing, switch or no switch", () => {
    // Unconditional on purpose: a missing claim would let the resync manager
    // open a second provider on a document the editor already holds.
    const { unmount } = render("page-1");

    expect(getOpenPage()).toBe("page-1");
    unmount();
  });

  it("follows the editor across a navigation", () => {
    const { rerender, unmount } = render("page-1");

    rerender("page-2");

    expect(getOpenPage()).toBe("page-2");
    unmount();
  });

  it("releases the document when the editor unmounts", () => {
    const { unmount } = render("page-1");

    unmount();

    expect(getOpenPage()).toBeNull();
  });
});
