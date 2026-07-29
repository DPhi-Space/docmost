import { describe, expect, it, vi } from "vitest";
import {
  isLocalEditOrigin,
  trackDirtyEdits,
  type DocUpdateSource,
} from "./dirty-tracking";

function fakeDoc() {
  const handlers = new Set<(update: Uint8Array, origin: unknown) => void>();
  const doc: DocUpdateSource = {
    on: (_event, handler) => void handlers.add(handler),
    off: (_event, handler) => void handlers.delete(handler),
  };
  return {
    doc,
    emit: (origin: unknown) => {
      for (const handler of [...handlers]) handler(new Uint8Array(), origin);
    },
    get listenerCount() {
      return handlers.size;
    },
  };
}

describe("isLocalEditOrigin", () => {
  const persistence = { kind: "IndexeddbPersistence" };
  const provider = { kind: "HocuspocusProvider" };

  it("rejects the y-indexeddb replay, which uses the persistence as its origin", () => {
    expect(isLocalEditOrigin(persistence, [persistence, provider])).toBe(false);
  });

  it("rejects an update applied by the collaboration provider", () => {
    expect(isLocalEditOrigin(provider, [persistence, provider])).toBe(false);
  });

  it("accepts the editor's own transactions", () => {
    const ySyncPluginKey = { key: "y-sync$" };
    expect(isLocalEditOrigin(ySyncPluginKey, [persistence, provider])).toBe(true);
  });

  it("accepts an update with no origin at all", () => {
    // Fails towards recording: a spurious entry costs one redundant sync, a
    // missed one costs the user their work.
    expect(isLocalEditOrigin(null, [persistence, provider])).toBe(true);
    expect(isLocalEditOrigin(undefined, [persistence, provider])).toBe(true);
  });

  it("ignores nullish entries in the exclusion set", () => {
    // A caller holding only one of the two must still get that one's benefit.
    expect(isLocalEditOrigin(null, [null, undefined])).toBe(true);
    expect(isLocalEditOrigin(persistence, [null, persistence])).toBe(false);
  });
});

describe("trackDirtyEdits", () => {
  const persistence = { kind: "IndexeddbPersistence" };
  const provider = { kind: "HocuspocusProvider" };
  const editor = { key: "y-sync$" };

  const setup = (connected: () => boolean) => {
    const { doc, emit, ...rest } = fakeDoc();
    const onDirty = vi.fn();
    const stop = trackDirtyEdits({
      doc,
      ignoredOrigins: () => [persistence, provider],
      isConnected: connected,
      onDirty,
    });
    return { emit, onDirty, stop, source: rest };
  };

  it("records an edit made while the provider is not connected", () => {
    const { emit, onDirty } = setup(() => false);

    emit(editor);

    expect(onDirty).toHaveBeenCalledOnce();
  });

  it("records nothing while the provider is connected", () => {
    const { emit, onDirty } = setup(() => true);

    emit(editor);

    expect(onDirty).not.toHaveBeenCalled();
  });

  it("re-reads connectivity on every update rather than capturing it", () => {
    let connected = true;
    const { emit, onDirty } = setup(() => connected);

    emit(editor);
    connected = false;
    emit(editor);

    expect(onDirty).toHaveBeenCalledOnce();
  });

  it("records nothing for the offline replay of the stored document", () => {
    const { emit, onDirty } = setup(() => false);

    emit(persistence);

    expect(onDirty).not.toHaveBeenCalled();
  });

  it("detaches its listener when stopped", () => {
    const { emit, onDirty, stop, source } = setup(() => false);

    stop();
    emit(editor);

    expect(onDirty).not.toHaveBeenCalled();
    expect(source.listenerCount).toBe(0);
  });
});
