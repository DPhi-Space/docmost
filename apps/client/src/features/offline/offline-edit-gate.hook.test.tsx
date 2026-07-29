/**
 * The phase-2/3 hook, tested against the arrangement it actually runs in.
 *
 * An earlier version of this file built `{ current: { remote } }` *inside* the
 * `renderHook` callback, so every render minted a fresh bundle already matching
 * the current props. A stale provider was structurally impossible — which is
 * precisely the hazard the design exists to defeat, so the suite could not fail
 * for the one reason that matters.
 *
 * What `page-editor.tsx` really does:
 *
 * - `providersRef` is **one stable object** for the life of the component; only
 *   `.current` moves;
 * - `.current` is swapped from an **effect**, i.e. out of band and after the
 *   render that reads it — so the ref is null on the first pass and lags a
 *   `pageId` change;
 * - `connectionStatus` comes from the global `yjsConnectionStatusAtom`, which is
 *   **never reset** when the page changes, so a new page inherits the old page's
 *   `Connected`;
 * - the document is a real `Y.Doc`, and its emptiness is now load-bearing.
 *
 * Every case below uses that shape. "does not vouch for a new page with the
 * previous page's provider" is the probe that fails against a hook without the
 * provenance check.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const markers = new Map<string, number>();
const dirty = new Map<string, number>();

// The real modules open IndexedDB, which jsdom does not implement. Their own
// semantics are covered by `sync-markers.test.ts` and `dirty-pages.test.ts`;
// here the maps stand in for the disk so the *hook's* decisions are under test.
vi.mock("./sync-markers", () => ({
  hasPageRemoteSynced: vi.fn(async (pageId: string) => markers.has(pageId)),
  markPageRemoteSynced: vi.fn(async (pageId: string) => {
    if (!markers.has(pageId)) markers.set(pageId, 1);
  }),
  clearPageSyncMarkers: vi.fn(async () => markers.clear()),
}));

vi.mock("./dirty-pages", () => ({
  recordDirtyPage: vi.fn(async (pageId: string) => {
    dirty.set(pageId, (dirty.get(pageId) ?? 0) + 1);
  }),
  clearDirtyPage: vi.fn(async (pageId: string) => void dirty.delete(pageId)),
  readDirtyPages: vi.fn(async () => ({ readable: true, records: [] }) as const),
}));

import { markPageRemoteSynced } from "./sync-markers";
import { clearDirtyPage, recordDirtyPage } from "./dirty-pages";
import { getOpenPage, resetOpenPageForTests } from "./open-page-registry";
import {
  reconcileOfflineDataOwnership,
  resetOwnershipForTests,
} from "./data-ownership";
import {
  useOfflineEditGate,
  UNSYNCED_POLL_MS,
  type PageProviders,
} from "./offline-edit-gate";
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

/** The y-indexeddb instance, which exists here only as an update origin. */
const localPersistence = { kind: "IndexeddbPersistence" };
/** y-prosemirror commits editor changes with this as the transaction origin. */
const editorOrigin = { key: "y-sync$" };

interface BundleOptions {
  synced?: boolean;
  unsyncedChanges?: number;
  /** False builds the empty shell an orphaned sync marker leaves behind. */
  populated?: boolean;
}

/**
 * One provider bundle, as `page-editor.tsx` builds it: a real `Y.Doc`, the
 * persistence instance, and the page it was constructed for.
 */
function bundleFor(pageId: string, options: BundleOptions = {}) {
  const doc = new Y.Doc();
  if (options.populated !== false) {
    doc.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
  }
  const bundle: PageProviders = {
    pageId,
    local: localPersistence,
    remote: {
      synced: options.synced ?? false,
      unsyncedChanges: options.unsyncedChanges ?? 0,
      document: doc,
    },
  };
  return { bundle, doc };
}

/** The stable `providersRef`; `.current` is only ever assigned outside render. */
function providersRef(initial: PageProviders | null = null) {
  return { current: initial };
}

interface Props {
  pageId: string;
  connectionStatus: string;
  isLocalSynced: boolean;
}

const PAGE_2: Props = {
  pageId: "page-2",
  connectionStatus: "connected",
  isLocalSynced: true,
};

function mountGate(
  providers: { current: PageProviders | null },
  initial: Partial<Props> = {},
) {
  const props: Props = {
    pageId: "page-1",
    connectionStatus: "disconnected",
    isLocalSynced: true,
    ...initial,
  };
  return renderHook(
    (p: Props) => ({
      gate: useOfflineEditGate({ ...p, providers }),
      state: useOfflineEditState(),
    }),
    { initialProps: props },
  );
}

/** Let the marker read (a resolved promise) and the resulting render land. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Run one or more sampling ticks. Requires fake timers. */
async function tick(times = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UNSYNCED_POLL_MS * times);
  });
}

function emitUpdate(doc: Y.Doc, origin: unknown) {
  doc.transact(() => {
    doc.getText("probe").insert(0, "x");
  }, origin);
}

/**
 * Settle ownership the way the authenticated shell does, so the gate is
 * allowed to open at all. Deliberately explicit in each test that needs it:
 * the default is refusal, and that default is itself under test below.
 */
async function ownershipSettled() {
  await act(async () => {
    await reconcileOfflineDataOwnership("user-1", {
      readOfflineDataOwner: async () => ({ status: "none" }),
      clearOfflineData: async () => {},
    });
  });
}

function reset() {
  markers.clear();
  dirty.clear();
  vi.clearAllMocks();
  resetOwnershipForTests();
  resetOpenPageForTests();
  resetOfflineEditStateForTests();
  localStorage.removeItem(OFFLINE_EDITING_STORAGE_KEY);
  setOnline(true);
}

describe("useOfflineEditGate — the offline editing gate", () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it("stays closed and touches no storage while the switch is off", async () => {
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1", { synced: true });

    const { result } = mountGate(providersRef(bundle), {
      connectionStatus: "connected",
    });
    await settle();

    expect(result.current.gate.canEditOffline).toBe(false);
    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("opens for a marked, populated page on an offline device", async () => {
    await ownershipSettled();
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1");

    const { result } = mountGate(providersRef(bundle));
    await settle();

    expect(result.current.gate.canEditOffline).toBe(true);
  });

  it("stays closed offline for a page that was never synced here", async () => {
    setOfflineEditingEnabled(true);
    setOnline(false);
    const { bundle } = bundleFor("never-opened");

    const { result } = mountGate(providersRef(bundle), {
      pageId: "never-opened",
    });
    await settle();

    expect(result.current.gate.canEditOffline).toBe(false);
  });

  it("stays closed when the marker survives but the document does not", async () => {
    // The defect: the marker store and `page.<pageId>` are separate databases
    // and can disagree. Opening here gives a live, blank editor above the words
    // "changes are saved locally and will sync when you reconnect".
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1", { populated: false });

    const { result } = mountGate(providersRef(bundle));
    await settle();

    expect(result.current.gate.canEditOffline).toBe(false);
  });

  it("opens as soon as the emptied document is repopulated", async () => {
    await ownershipSettled();
    // The same page, once the replay actually delivers something: the gate
    // closes on emptiness, it does not latch shut on a page.
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle, doc } = bundleFor("page-1", { populated: false });

    const { result } = mountGate(providersRef(bundle));
    await settle();
    expect(result.current.gate.canEditOffline).toBe(false);

    doc.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
    await tick();

    expect(result.current.gate.canEditOffline).toBe(true);
  });

  it("stays closed until ownership of the offline data is settled", async () => {
    // The default is refusal. A browser holding a previous user's preserved
    // documents must not open one in a live editor while the cleanup that
    // decides whose they are is still running.
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1");

    const { result } = mountGate(providersRef(bundle));
    await settle();
    expect(result.current.gate.canEditOffline).toBe(false);

    await ownershipSettled();

    expect(result.current.gate.canEditOffline).toBe(true);
  });

  it("does not carry one page's marker over to the next", async () => {
    // The marker is held as *which page* is known synced, never as a boolean:
    // a boolean survives a route change and hands a never-synced page the
    // previous page's permission. Page 2 arrives with its own populated
    // bundle, so emptiness cannot be what closes the gate here — only the
    // absence of page-2's own marker can.
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    await ownershipSettled();
    markers.set("page-1", 1);
    setOnline(false);
    const providers = providersRef(bundleFor("page-1").bundle);

    const { result, rerender } = mountGate(providers);
    await settle();
    expect(result.current.gate.canEditOffline).toBe(true);

    rerender({ ...PAGE_2, connectionStatus: "disconnected" });
    providers.current = bundleFor("page-2").bundle;
    await settle();
    await tick(2);

    expect(result.current.gate.canEditOffline).toBe(false);
  });

  it("stays closed while y-indexeddb has not finished loading", async () => {
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1");

    const { result } = mountGate(providersRef(bundle), {
      isLocalSynced: false,
    });
    await settle();

    expect(result.current.gate.canEditOffline).toBe(false);
  });

  it("publishes the offline-editing state the banner renders from", async () => {
    await ownershipSettled();
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1");

    const { result, unmount } = mountGate(providersRef(bundle));
    await settle();
    expect(result.current.state.offlineEditingActive).toBe(true);

    unmount();

    // Nothing should keep claiming the editor is offline once it is gone.
    const { result: after } = renderHook(() => useOfflineEditState());
    expect(after.current.offlineEditingActive).toBe(false);
  });
});

describe("useOfflineEditGate — provenance", () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it("writes a marker once the provider itself reports a completed handshake", async () => {
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();

    expect(markPageRemoteSynced).toHaveBeenCalledWith("page-1");
  });

  it("refuses to write a marker on a connection whose document has not synced", async () => {
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: false });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();

    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("refuses to write a marker while the socket is not connected", async () => {
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true });

    mountGate(providersRef(bundle), { connectionStatus: "disconnected" });
    await settle();

    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("does not vouch for a new page with the previous page's provider", async () => {
    // The probe. `page-editor.tsx` swaps the bundle from an effect, so between
    // a `pageId` change and that swap the ref still holds the *old* page's
    // provider — which reports `synced === true` — while the global connection
    // atom still reads `connected` because nothing resets it. Acting then marks
    // a page the server has never acknowledged.
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true });
    const providers = providersRef(bundle);

    const { rerender } = mountGate(providers, { connectionStatus: "connected" });
    await settle();
    expect(markPageRemoteSynced).toHaveBeenCalledWith("page-1");

    // Route change: props move, the ref does not.
    rerender(PAGE_2);
    await settle();
    await tick(3);

    expect(markPageRemoteSynced).not.toHaveBeenCalledWith("page-2");
  });

  it("does not forget a new page's unpushed edits off the old provider", async () => {
    // Same hazard, worse consequence: `clearDirtyPage` on a page whose edits
    // have never been pushed drops the only index of work that exists solely on
    // this device.
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 0 });
    const providers = providersRef(bundle);

    const { rerender } = mountGate(providers, { connectionStatus: "connected" });
    await settle();

    rerender(PAGE_2);
    await settle();
    await tick(3);

    expect(clearDirtyPage).not.toHaveBeenCalledWith("page-2");
  });

  it("does not let the old page's content vouch for the new page", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    markers.set("page-2", 1);
    setOnline(false);
    const { bundle } = bundleFor("page-1");
    const providers = providersRef(bundle);

    await ownershipSettled();
    const { result, rerender } = mountGate(providers);
    await settle();
    expect(result.current.gate.canEditOffline).toBe(true);

    rerender({ ...PAGE_2, connectionStatus: "disconnected" });
    await settle();
    await tick(3);

    // page-2's own providers have not been built yet, so nothing in hand is
    // evidence that page-2's document holds anything.
    expect(result.current.gate.canEditOffline).toBe(false);
  });

  it("acts again as soon as the matching provider arrives", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const providers = providersRef(bundleFor("page-1", { synced: true }).bundle);

    const { rerender } = mountGate(providers, { connectionStatus: "connected" });
    await settle();

    rerender(PAGE_2);
    await settle();
    await tick();
    expect(markPageRemoteSynced).not.toHaveBeenCalledWith("page-2");

    // The provider effect finally runs.
    providers.current = bundleFor("page-2", { synced: true }).bundle;
    await tick();

    expect(markPageRemoteSynced).toHaveBeenCalledWith("page-2");
  });

  it("does nothing at all while the ref is still empty", async () => {
    // The first render of every mount: the hook runs before the effect that
    // builds the providers.
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    markers.set("page-1", 1);
    setOnline(false);

    const { result } = mountGate(providersRef(null));
    await settle();
    await tick(2);

    expect(result.current.gate.canEditOffline).toBe(false);
    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });

  it("refuses a bundle that offers no provenance", async () => {
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true });
    delete bundle.pageId;

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();

    expect(markPageRemoteSynced).not.toHaveBeenCalled();
  });
});

describe("useOfflineEditGate — dropped writes and availability", () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it("clears a page-unavailable report once the page syncs again", async () => {
    setOfflineEditingEnabled(true);
    reportPageUnavailable("page-1");
    const { bundle } = bundleFor("page-1", { synced: true });

    const { result } = mountGate(providersRef(bundle), {
      connectionStatus: "connected",
    });
    await settle();

    expect(result.current.state.unavailablePageId).toBeNull();
  });

  it("raises the warning when the provider's counter will not drain", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 3 });

    const { result } = mountGate(providersRef(bundle), {
      connectionStatus: "connected",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS - 1_000);
    });
    expect(result.current.state.unsyncedChangesWarning).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.state.unsyncedChangesWarning).toBe(true);
  });

  it("raises no warning while the counter drains normally", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 0 });

    const { result } = mountGate(providersRef(bundle), {
      connectionStatus: "connected",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS * 3);
    });

    expect(result.current.state.unsyncedChangesWarning).toBe(false);
  });

  it("raises no warning for edits made while offline", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    setOnline(false);
    const { bundle } = bundleFor("page-1", {
      synced: false,
      unsyncedChanges: 12,
    });

    const { result } = mountGate(providersRef(bundle));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS * 5);
    });

    expect(result.current.state.unsyncedChangesWarning).toBe(false);
  });
});

describe("useOfflineEditGate — dirty tracking", () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it("records a page the user edits while its provider is not connected", async () => {
    setOfflineEditingEnabled(true);
    const { bundle, doc } = bundleFor("page-1");

    mountGate(providersRef(bundle));
    await settle();
    act(() => emitUpdate(doc, editorOrigin));

    expect(recordDirtyPage).toHaveBeenCalledWith("page-1", undefined);
  });

  it("records nothing while the switch is off", async () => {
    const { bundle, doc } = bundleFor("page-1");

    mountGate(providersRef(bundle));
    await settle();
    act(() => emitUpdate(doc, editorOrigin));

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("records nothing for the y-indexeddb replay of a page opened offline", async () => {
    // Otherwise every page merely *read* offline would queue for a background
    // sync — and, if locked, be reported to the user as blocked.
    setOfflineEditingEnabled(true);
    const { bundle, doc } = bundleFor("page-1");

    mountGate(providersRef(bundle));
    await settle();
    act(() => emitUpdate(doc, localPersistence));

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("records nothing while the page's own provider is connected", async () => {
    setOfflineEditingEnabled(true);
    const { bundle, doc } = bundleFor("page-1", { synced: true });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();
    act(() => emitUpdate(doc, editorOrigin));

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("clears the entry once a real handshake drains the counter", async () => {
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 0 });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();

    expect(clearDirtyPage).toHaveBeenCalledWith("page-1");
  });

  it("does not clear while the counter is still above zero", async () => {
    // The read-only signature: the server took the connection and dropped the
    // writes. Forgetting the page here would lose the only pointer to them.
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 2 });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();

    expect(clearDirtyPage).not.toHaveBeenCalled();
  });

  it("does not clear on a connected socket whose document has not synced", async () => {
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: false, unsyncedChanges: 0 });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await settle();

    expect(clearDirtyPage).not.toHaveBeenCalled();
  });

  it("clears once per page rather than once per second", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 0 });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });
    await tick(10);

    expect(clearDirtyPage).toHaveBeenCalledTimes(1);
  });

  it("re-aims tracking at the new page once its provider arrives", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const providers = providersRef(bundleFor("page-1").bundle);

    const { rerender } = mountGate(providers);
    await settle();

    const second = bundleFor("page-2");
    rerender({ ...PAGE_2, connectionStatus: "disconnected" });
    providers.current = second.bundle;
    await tick();
    act(() => emitUpdate(second.doc, editorOrigin));

    expect(recordDirtyPage).toHaveBeenCalledTimes(1);
    expect(recordDirtyPage).toHaveBeenCalledWith("page-2", undefined);
  });

  it("registers a page whose writes the server is refusing", async () => {
    // The other shape of unpushed work: a live, synced connection the server
    // answers with SyncStatus(false). `dirty-tracking` never sees these — it
    // only watches disconnected providers — so without this the registry would
    // not know to preserve exactly the edits the banner calls safe.
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 3 });

    const { result } = mountGate(providersRef(bundle), {
      connectionStatus: "connected",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS + 1_000);
    });

    expect(result.current.state.unsyncedChangesWarning).toBe(true);
    expect(recordDirtyPage).toHaveBeenCalledWith("page-1", undefined);
  });

  it("registers the refused page once, not once per second", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 3 });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS * 4);
    });

    expect(recordDirtyPage).toHaveBeenCalledTimes(1);
  });

  it("registers nothing while the counter is draining normally", async () => {
    vi.useFakeTimers();
    setOfflineEditingEnabled(true);
    const { bundle } = bundleFor("page-1", { synced: true, unsyncedChanges: 0 });

    mountGate(providersRef(bundle), { connectionStatus: "connected" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSYNCED_GRACE_MS * 4);
    });

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });

  it("unsubscribes when the editor unmounts", async () => {
    setOfflineEditingEnabled(true);
    const { bundle, doc } = bundleFor("page-1");

    const { unmount } = mountGate(providersRef(bundle));
    await settle();

    unmount();
    emitUpdate(doc, editorOrigin);

    expect(recordDirtyPage).not.toHaveBeenCalled();
  });
});

describe("useOfflineEditGate — open-document claim", () => {
  beforeEach(reset);

  it("claims the document the editor is showing, switch or no switch", () => {
    const { unmount } = mountGate(providersRef(bundleFor("page-1").bundle));

    expect(getOpenPage()).toBe("page-1");
    unmount();
  });

  it("follows the editor across a navigation", () => {
    const { rerender, unmount } = mountGate(
      providersRef(bundleFor("page-1").bundle),
    );

    rerender({ ...PAGE_2, connectionStatus: "disconnected" });

    expect(getOpenPage()).toBe("page-2");
    unmount();
  });

  it("releases the document when the editor unmounts", () => {
    const { unmount } = mountGate(providersRef(bundleFor("page-1").bundle));

    unmount();

    expect(getOpenPage()).toBeNull();
  });
});
