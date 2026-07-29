/**
 * The provider lifecycle, pinned.
 *
 * `resync-session.ts` is the file on this branch closest to the code the fork's
 * v0.95.0 pin exists to protect, and it had no coverage: jsdom has neither a
 * WebSocket server nor IndexedDB. What can be checked without either is exactly
 * what makes it risky — the **order** things are built and torn down, and the
 * mapping from four independent signals onto one sample — so the constructors
 * are injected and those are what these tests assert.
 */

import { describe, expect, it, vi } from "vitest";
import {
  openResyncSession,
  pageDocumentName,
  realSessionDeps,
  type ResyncSessionDeps,
  type SessionProviderConfig,
} from "./resync-session";

interface Recorder {
  deps: ResyncSessionDeps;
  events: string[];
  provider: { synced: boolean; unsyncedChanges: number };
  persistence: { synced: boolean };
  config: SessionProviderConfig | null;
  fireLocalSynced: () => void;
  fireStatus: (status: string) => void;
  fireAuthFailure: () => void;
}

function recorder(
  overrides: { throwOn?: "persistence" | "socket" | "provider" } = {},
): Recorder {
  const events: string[] = [];
  const provider = { synced: false, unsyncedChanges: 0 };
  const persistence = { synced: false };
  let localSyncedHandler: (() => void) | null = null;
  const rec: Recorder = {
    events,
    provider,
    persistence,
    config: null,
    fireLocalSynced: () => localSyncedHandler?.(),
    fireStatus: (status) => rec.config?.onStatus({ status }),
    fireAuthFailure: () => rec.config?.onAuthenticationFailed(),
    deps: {
      collaborationUrl: () => "ws://collab.test/collab",
      createDoc: () => {
        events.push("doc:create");
        return { destroy: () => events.push("doc:destroy") };
      },
      createPersistence: (name) => {
        if (overrides.throwOn === "persistence") throw new Error("no indexeddb");
        events.push(`persistence:create(${name})`);
        return {
          get synced() {
            return persistence.synced;
          },
          on: (_event, handler) => {
            localSyncedHandler = handler;
          },
          destroy: () => events.push("persistence:destroy"),
        };
      },
      createSocket: (url) => {
        if (overrides.throwOn === "socket") throw new Error("bad url");
        events.push(`socket:create(${url})`);
        return { destroy: () => events.push("socket:destroy") };
      },
      createProvider: (config) => {
        if (overrides.throwOn === "provider") throw new Error("no provider");
        events.push(`provider:create(${config.name},${config.token})`);
        rec.config = config;
        return {
          get synced() {
            return provider.synced;
          },
          get unsyncedChanges() {
            return provider.unsyncedChanges;
          },
          attach: () => events.push("provider:attach"),
          destroy: () => events.push("provider:destroy"),
        };
      },
    },
  };
  return rec;
}

describe("pageDocumentName", () => {
  it("matches the name page-editor.tsx uses, which is also the database name", () => {
    expect(pageDocumentName("019fadf3-3252")).toBe("page.019fadf3-3252");
  });
});

describe("openResyncSession — construction", () => {
  it("builds the four objects in the editor's order and attaches last", async () => {
    // Any other order is a different lifecycle from the one the fork's pin
    // protects. `attach()` last is what makes the socket connect at all.
    const rec = recorder();

    await openResyncSession("p1", "tok", rec.deps);

    expect(rec.events).toEqual([
      "doc:create",
      "persistence:create(page.p1)",
      "socket:create(ws://collab.test/collab)",
      "provider:create(page.p1,tok)",
      "provider:attach",
    ]);
  });

  it("gives the provider the same document the persistence was given", async () => {
    // Two documents here would mean the replayed offline edits never reach the
    // handshake — the whole push would silently do nothing.
    const seen: unknown[] = [];
    const rec = recorder();
    const deps: ResyncSessionDeps = {
      ...rec.deps,
      createPersistence: (name, doc) => {
        seen.push(doc);
        return rec.deps.createPersistence(name, doc);
      },
      createProvider: (config) => {
        seen.push(config.document);
        return rec.deps.createProvider(config);
      },
    };

    await openResyncSession("p1", "tok", deps);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("names the document and the database identically", async () => {
    const names: string[] = [];
    const rec = recorder();
    const deps: ResyncSessionDeps = {
      ...rec.deps,
      createPersistence: (name, doc) => {
        names.push(name);
        return rec.deps.createPersistence(name, doc);
      },
      createProvider: (config) => {
        names.push(config.name);
        return rec.deps.createProvider(config);
      },
    };

    await openResyncSession("p1", "tok", deps);

    expect(names).toEqual(["page.p1", "page.p1"]);
  });
});

describe("openResyncSession — sampling", () => {
  it("starts with nothing claimed", async () => {
    const rec = recorder();

    const session = await openResyncSession("p1", "tok", rec.deps);

    expect(session.sample()).toEqual({
      localSynced: false,
      connected: false,
      synced: false,
      unsyncedChanges: 0,
      authenticationFailed: false,
    });
  });

  it("reports the local replay from the event", async () => {
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);

    rec.fireLocalSynced();

    expect(session.sample().localSynced).toBe(true);
  });

  it("reports the local replay from the instance when the event was missed", async () => {
    // y-indexeddb emits `synced` from a promise chain that can resolve before
    // the handler is attached; the flag on the instance is the record of it.
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);

    rec.persistence.synced = true;

    expect(session.sample().localSynced).toBe(true);
  });

  it("treats only Connected as connected", async () => {
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);

    rec.fireStatus("connecting");
    expect(session.sample().connected).toBe(false);

    rec.fireStatus("connected");
    expect(session.sample().connected).toBe(true);

    rec.fireStatus("disconnected");
    expect(session.sample().connected).toBe(false);
  });

  it("passes the provider's own handshake and counter straight through", async () => {
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);

    rec.provider.synced = true;
    rec.provider.unsyncedChanges = 4;

    expect(session.sample()).toMatchObject({ synced: true, unsyncedChanges: 4 });
  });

  it("latches an authentication failure", async () => {
    // It fires once; the verdict is read later, on the next poll.
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);

    rec.fireAuthFailure();

    expect(session.sample().authenticationFailed).toBe(true);
    expect(session.sample().authenticationFailed).toBe(true);
  });

  it("does not try to reconnect on an authentication failure", async () => {
    // Unlike the editor's handler. `resync-page.ts` owns that decision, and a
    // second reconnect path here would be a second lifecycle.
    const rec = recorder();
    await openResyncSession("p1", "tok", rec.deps);
    const before = [...rec.events];

    rec.fireAuthFailure();

    expect(rec.events).toEqual(before);
  });
});

describe("openResyncSession — teardown", () => {
  it("tears down in the editor's order, then releases the document", async () => {
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);
    rec.events.length = 0;

    session.destroy();

    expect(rec.events).toEqual([
      "socket:destroy",
      "provider:destroy",
      "persistence:destroy",
      "doc:destroy",
    ]);
  });

  it("releases the document last, so nothing is torn down twice", async () => {
    // `IndexeddbPersistence` registers `doc.on("destroy", this.destroy)` and
    // removes it in `destroy()`. Destroying the doc first would run the
    // persistence teardown from inside the document's own destroy.
    const rec = recorder();
    const session = await openResyncSession("p1", "tok", rec.deps);
    rec.events.length = 0;

    session.destroy();

    expect(rec.events.indexOf("doc:destroy")).toBe(rec.events.length - 1);
  });
});

describe("openResyncSession — failed construction", () => {
  it("rejects rather than returning a half-built session", async () => {
    await expect(
      openResyncSession("p1", "tok", recorder({ throwOn: "persistence" }).deps),
    ).rejects.toThrow("no indexeddb");
  });

  it("releases the document when the persistence cannot be opened", async () => {
    const rec = recorder({ throwOn: "persistence" });

    await expect(openResyncSession("p1", "tok", rec.deps)).rejects.toThrow();

    expect(rec.events).toEqual(["doc:create", "doc:destroy"]);
  });

  it("does not leak a socket when the provider cannot be built", async () => {
    // A leaked socket is a WebSocket that keeps retrying for the life of the
    // tab, once per failed pass.
    const rec = recorder({ throwOn: "provider" });

    await expect(openResyncSession("p1", "tok", rec.deps)).rejects.toThrow();

    expect(rec.events).toContain("socket:destroy");
    expect(rec.events).toContain("persistence:destroy");
    expect(rec.events).toContain("doc:destroy");
  });

  it("does not leak the persistence when the socket cannot be built", async () => {
    const rec = recorder({ throwOn: "socket" });

    await expect(openResyncSession("p1", "tok", rec.deps)).rejects.toThrow();

    expect(rec.events).toContain("persistence:destroy");
    expect(rec.events).toContain("doc:destroy");
  });
});

describe("realSessionDeps", () => {
  it("is the default, so the production path is the one described above", async () => {
    // The persistence is *replaced*, not merely observed. Letting the real one
    // run reaches `new IndexeddbPersistence` in jsdom, which has no IndexedDB:
    // y-indexeddb then rejects from inside its own promise chain, and vitest
    // reports an unhandled error and **exits 1 with every test passing**. A red
    // build that says "413 passed" is worse than a missing test.
    const spy = vi
      .spyOn(realSessionDeps, "createPersistence")
      .mockImplementation(() => {
        throw new Error("stubbed: no IndexedDB in jsdom");
      });

    await expect(openResyncSession("p1", "tok")).rejects.toThrow("stubbed");

    expect(spy).toHaveBeenCalledWith("page.p1", expect.anything());
    spy.mockRestore();
  });

  it("names its document the same way the standalone helper does", () => {
    // The rest of the default bundle cannot be constructed under jsdom at all,
    // so what is pinned here is the part that can be: the naming both the
    // provider and the y-indexeddb database key off.
    expect(pageDocumentName("p1")).toBe("page.p1");
  });
});
