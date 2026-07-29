import { describe, it, expect } from "vitest";
import {
  CACHE_PREFIX,
  cacheNames,
  cachesToDelete,
  isCacheableResponse,
  isExpired,
  keysToEvict,
} from "./cache-policy";

describe("cacheNames", () => {
  it("scopes the precache to the build so a deploy replaces it wholesale", () => {
    expect(cacheNames("a").precache).not.toBe(cacheNames("b").precache);
  });

  it("keeps content-addressed and runtime caches stable across builds", () => {
    const a = cacheNames("a");
    const b = cacheNames("b");
    expect(a.assets).toBe(b.assets);
    expect(a.shell).toBe(b.shell);
    expect(a.locales).toBe(b.locales);
    expect(a.files).toBe(b.files);
  });

  it("namespaces every cache it owns", () => {
    for (const name of Object.values(cacheNames("x"))) {
      expect(name.startsWith(CACHE_PREFIX)).toBe(true);
    }
  });
});

describe("cachesToDelete", () => {
  const keep = cacheNames("build-2");

  it("prunes precaches from older builds", () => {
    const existing = [cacheNames("build-1").precache, keep.precache, keep.assets];
    expect(cachesToDelete(existing, keep)).toEqual([
      cacheNames("build-1").precache,
    ]);
  });

  it("keeps every cache the current build still uses", () => {
    expect(cachesToDelete(Object.values(keep), keep)).toEqual([]);
  });

  it("never touches caches this feature does not own", () => {
    expect(cachesToDelete(["workbox-precache-v1", "some-other-cache"], keep)).toEqual(
      [],
    );
  });
});

describe("keysToEvict", () => {
  it("evicts the oldest entries when over the bound", () => {
    expect(keysToEvict(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
  });

  it("evicts nothing at or under the bound", () => {
    expect(keysToEvict(["a", "b"], 2)).toEqual([]);
    expect(keysToEvict([], 2)).toEqual([]);
  });

  it("evicts everything when the bound is zero", () => {
    expect(keysToEvict(["a", "b"], 0)).toEqual(["a", "b"]);
  });
});

describe("isExpired", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 1_000_000_000_000;

  it("expires entries past the max age", () => {
    expect(isExpired(String(now - 31 * day), now, 30 * day)).toBe(true);
  });

  it("keeps entries within the max age", () => {
    expect(isExpired(String(now - 29 * day), now, 30 * day)).toBe(false);
  });

  it("keeps entries of unknown age rather than dropping offline content", () => {
    expect(isExpired(null, now, 30 * day)).toBe(false);
    expect(isExpired(undefined, now, 30 * day)).toBe(false);
    expect(isExpired("not-a-number", now, 30 * day)).toBe(false);
  });
});

describe("isCacheableResponse", () => {
  const res = (over: Partial<Parameters<typeof isCacheableResponse>[0]>) => ({
    ok: true,
    status: 200,
    type: "basic",
    redirected: false,
    ...over,
  });

  it("accepts a normal successful response", () => {
    expect(isCacheableResponse(res({}))).toBe(true);
  });

  it("rejects errors", () => {
    expect(isCacheableResponse(res({ ok: false, status: 404 }))).toBe(false);
    expect(isCacheableResponse(res({ ok: false, status: 503 }))).toBe(false);
  });

  it("rejects partial content — a cached 206 corrupts media playback", () => {
    expect(isCacheableResponse(res({ status: 206 }))).toBe(false);
  });

  it("rejects opaque responses", () => {
    expect(isCacheableResponse(res({ type: "opaque" }))).toBe(false);
    expect(isCacheableResponse(res({ type: "opaqueredirect" }))).toBe(false);
  });
});
