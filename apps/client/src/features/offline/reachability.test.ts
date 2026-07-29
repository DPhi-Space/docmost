import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_PROBE_PATH,
  createReachabilityMonitor,
  probeServerOnce,
  type BrowserEventHandlers,
  type ReachabilityMonitor,
} from "./reachability";
import {
  CONFIRM_FAILURES,
  HEARTBEAT_MS,
  OFFLINE_BACKOFF_MS,
  RECHECK_DELAY_MS,
} from "./reachability-policy";
import { resolveRoute } from "./sw/routes";

interface Harness {
  monitor: ReachabilityMonitor;
  /** Number of probes actually sent. */
  probes: () => number;
  /** What the next probe answers. */
  setProbeResult: (reached: boolean) => void;
  setBrowserOnline: (online: boolean) => void;
  setVisible: (visible: boolean) => void;
  advance: (ms: number) => void;
  /** The single pending timer, as the monitor never keeps more than one. */
  pending: () => { ms: number } | null;
  fire: () => void;
  events: BrowserEventHandlers;
  changes: () => number;
}

function harness(options: { online?: boolean; reached?: boolean } = {}): Harness {
  let online = options.online ?? true;
  let visible = true;
  let reached = options.reached ?? true;
  let clock = 1_000;
  let probes = 0;
  let changes = 0;
  let pending: { fn: () => void; ms: number } | null = null;
  let handle = 0;
  let events!: BrowserEventHandlers;

  const monitor = createReachabilityMonitor({
    probe: async () => {
      probes += 1;
      return reached;
    },
    browserOnline: () => online,
    isVisible: () => visible,
    now: () => clock,
    setTimer: (fn, ms) => {
      pending = { fn, ms };
      handle += 1;
      return handle;
    },
    clearTimer: () => {
      pending = null;
    },
    subscribeBrowserEvents: (handlers) => {
      events = handlers;
      return () => {
        events = {
          onBrowserOnline: () => {
            throw new Error("listener fired after unsubscribe");
          },
          onBrowserOffline: () => {
            throw new Error("listener fired after unsubscribe");
          },
          onWake: () => {
            throw new Error("listener fired after unsubscribe");
          },
        };
      };
    },
  });

  monitor.subscribe(() => {
    changes += 1;
  });

  return {
    monitor,
    probes: () => probes,
    setProbeResult: (next) => {
      reached = next;
    },
    setBrowserOnline: (next) => {
      online = next;
    },
    setVisible: (next) => {
      visible = next;
    },
    advance: (ms) => {
      clock += ms;
    },
    pending: () => (pending ? { ms: pending.ms } : null),
    fire: () => {
      const current = pending;
      pending = null;
      current?.fn();
    },
    get events() {
      return events;
    },
    changes: () => changes,
  };
}

/**
 * Let every pending microtask run.
 *
 * Deliberately not `vi.waitFor(() => expect(probes()).toBe(n))`: the harness's
 * probe counter increments *synchronously* when the probe is called, which is
 * before its answer has been applied to the state or a new timer scheduled. A
 * suite waiting on that counter reads the state one step early — every case in
 * this file failed that way first time round.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.unstubAllGlobals());

describe("the VPN case", () => {
  it("declares the server unreachable while the browser insists it is online", async () => {
    // The reported failure, and the reason this module exists: Wi-Fi off, VPN
    // configured, `navigator.onLine === true` in both Chrome and Safari.
    const h = harness({ online: true, reached: false });

    h.monitor.start();
    await flush();

    // One failure decides nothing.
    expect(h.monitor.isReachable()).toBe(true);
    expect(h.pending()?.ms).toBe(RECHECK_DELAY_MS);

    h.fire();
    await flush();
    expect(h.monitor.isReachable()).toBe(false);
    expect(h.probes()).toBe(CONFIRM_FAILURES);
    expect(h.changes()).toBe(1);
  });

  it("then finds its way back on the backoff schedule", async () => {
    const h = harness({ reached: false });
    h.monitor.start();
    await flush();
    h.fire();
    await flush();
    expect(h.monitor.isReachable()).toBe(false);

    expect(h.pending()?.ms).toBe(OFFLINE_BACKOFF_MS[0]);
    h.setProbeResult(true);
    h.fire();
    await flush();

    expect(h.monitor.isReachable()).toBe(true);
  });
});

describe("evidence, strongest first", () => {
  it("believes ordinary application traffic over its own probes", async () => {
    // `lib/api-client.ts` calls this on every response. It is what stops a wrong
    // offline verdict — which pauses every query in the app — from persisting.
    const h = harness({ reached: false });
    h.monitor.start();
    await flush();
    h.fire();
    await flush();
    expect(h.monitor.isReachable()).toBe(false);

    h.monitor.reportReached();

    expect(h.monitor.isReachable()).toBe(true);
    expect(h.monitor.state().failures).toBe(0);
  });

  it("costs nothing when the app is healthy and busy", () => {
    const h = harness();
    h.monitor.start();

    for (let i = 0; i < 50; i += 1) h.monitor.reportReached();

    expect(h.changes()).toBe(0);
  });

  it("treats a transport failure as a request to check, not as an answer", async () => {
    const h = harness();
    h.monitor.start();
    await flush();

    h.monitor.reportSuspect();

    expect(h.monitor.isReachable()).toBe(true);
    // Asked for immediately rather than on the heartbeat.
    expect(h.pending()?.ms).toBe(0);
  });

  it("believes the browser outright when it says there is no route", () => {
    const h = harness();
    h.monitor.start();

    h.setBrowserOnline(false);
    h.events.onBrowserOffline();

    expect(h.monitor.isReachable()).toBe(false);
  });

  it("never reports reachable while the browser says there is no route", () => {
    // The veto is read live on every call, so a browser that flips the property
    // without dispatching an event still cannot be believed.
    const h = harness();
    h.monitor.start();
    h.monitor.reportReached();
    expect(h.monitor.isReachable()).toBe(true);

    h.setBrowserOnline(false);

    expect(h.monitor.isReachable()).toBe(false);
    expect(h.monitor.state().reachable).toBe(true);
  });

  it("does not take an interface reappearing as evidence", async () => {
    const h = harness({ reached: false });
    h.monitor.start();
    await flush();
    h.fire();
    await flush();
    expect(h.monitor.isReachable()).toBe(false);

    h.events.onBrowserOnline();

    expect(h.monitor.isReachable()).toBe(false);
    expect(h.pending()?.ms).toBe(0);
  });
});

describe("the idle heartbeat", () => {
  it("skips the probe while ordinary traffic is answering the question", async () => {
    const h = harness();
    h.monitor.start();
    await flush();

    expect(h.pending()?.ms).toBe(HEARTBEAT_MS);
    h.fire();

    // Nothing has gone quiet: the last success is inside the window.
    expect(h.probes()).toBe(1);
    expect(h.pending()?.ms).toBe(HEARTBEAT_MS);
  });

  it("probes once the tab has gone quiet", async () => {
    const h = harness();
    h.monitor.start();
    await flush();

    h.advance(HEARTBEAT_MS);
    h.fire();
    await flush();

    expect(h.probes()).toBe(2);
  });

  it("does not probe for a tab nobody is looking at", async () => {
    const h = harness();
    h.monitor.start();
    await flush();

    h.setVisible(false);
    h.advance(HEARTBEAT_MS * 10);
    h.fire();

    expect(h.probes()).toBe(1);
    // Still scheduled, so becoming visible again is not required to recover.
    expect(h.pending()?.ms).toBe(HEARTBEAT_MS);
  });

  it("checks when a hidden tab comes back on screen", async () => {
    const h = harness({ reached: false });
    h.monitor.start();
    await flush();
    h.fire();
    await flush();
    expect(h.monitor.isReachable()).toBe(false);

    h.events.onWake();

    expect(h.pending()?.ms).toBe(0);
  });
});

describe("sending nothing until asked", () => {
  it("probes only once started", () => {
    // Constructing the monitor must never send a request: it is a module
    // singleton, so otherwise every unit test in the app that renders a
    // component would.
    const h = harness();

    h.monitor.reportSuspect();
    h.monitor.state();

    expect(h.probes()).toBe(0);
    expect(h.pending()).toBeNull();
  });

  it("keeps one probe in flight at a time", async () => {
    const h = harness();
    h.monitor.start();

    void h.monitor.check();
    void h.monitor.check();
    await flush();

    expect(h.probes()).toBe(1);
  });

  it("stops scheduling and stops listening once stopped", async () => {
    const h = harness();
    h.monitor.start();
    await flush();

    h.monitor.stop();

    expect(h.pending()).toBeNull();
    expect(() => h.events.onBrowserOffline()).toThrow();
  });
});

describe("settled — the first evidence-backed verdict", () => {
  it("resolves false with no round trips when the browser says there is no route", async () => {
    const h = harness({ online: false });
    h.monitor.start();

    await expect(h.monitor.settled()).resolves.toBe(false);
    expect(h.probes()).toBe(0);
  });

  it("waits for a definitive verdict rather than reporting the assumption", async () => {
    const h = harness({ reached: false });
    let resolved: boolean | null = null;
    h.monitor.start();
    void h.monitor.settled().then((value) => {
      resolved = value;
    });

    // The optimistic state is still `reachable`, and an unconfirmed failure does
    // not change that. A caller asking this question must not be handed either —
    // `use-offline-resync.ts` decides whose data is on this disk from the answer,
    // and "probably online" resolves to a request that fails and an identity it
    // then refuses.
    await flush();
    expect(h.monitor.isReachable()).toBe(true);
    expect(resolved).toBeNull();

    h.fire();
    await flush();

    expect(resolved).toBe(false);
  });

  it("resolves immediately once a verdict exists", async () => {
    const h = harness();
    h.monitor.start();
    await flush();

    await expect(h.monitor.settled()).resolves.toBe(true);
  });

  it("resolves rather than hanging when nothing will ever probe", async () => {
    const h = harness();

    await expect(h.monitor.settled()).resolves.toBe(true);
  });
});

describe("probeServerOnce", () => {
  it("counts any HTTP response as reachable, including a failure status", async () => {
    // The question is whether packets completed a round trip to our origin, not
    // whether the server is well — and a reverse proxy that does not forward
    // this one path must not be able to convince the app it is offline.
    for (const status of [200, 401, 404, 500, 502]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status, ok: status < 400 })),
      );
      await expect(probeServerOnce()).resolves.toBe(true);
    }
  });

  it("counts a transport failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(probeServerOnce()).resolves.toBe(false);
  });

  it("gives up on a request that never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );

    await expect(probeServerOnce(5)).resolves.toBe(false);
  });

  it("asks our own origin, uncacheably, carrying the session", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await probeServerOnce();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url.startsWith(`${HEALTH_PROBE_PATH}?`)).toBe(true);
    expect(init.cache).toBe("no-store");
    expect(init.method).toBe("GET");
    /**
     * **Not `"omit"`.** The endpoint needs no session, so omitting looks like
     * hygiene — but behind an authenticating reverse proxy (Cloudflare Access,
     * oauth2-proxy, Authelia) a cookie-less request is redirected to the identity
     * provider, the redirect is followed cross-origin, and the fetch rejects on
     * CORS. Every probe would fail forever on a perfectly healthy deployment, and
     * the verdict pauses React Query. This assertion is the guard against the
     * hygiene argument being made again.
     */
    expect(init.credentials).toBe("same-origin");
  });
});

describe("the probe and the service worker", () => {
  it("is never a request the worker may answer", () => {
    /**
     * The invariant the whole module rests on. `cache: "no-store"` governs the
     * HTTP cache and says nothing about Cache Storage, so a probe the worker
     * could answer would report a server that has been unreachable for a week as
     * up — and every consumer of the verdict would believe it.
     */
    expect(
      resolveRoute(
        { method: "GET", url: `${HEALTH_PROBE_PATH}?_=1` },
        "https://docs.example.com",
      ),
    ).toBe("passthrough");
  });
});
