import { describe, expect, it } from "vitest";
import { isCollabTokenExpired } from "./collab-auth";

/** Minimal unsigned JWT — `jwt-decode` only reads the payload segment. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

describe("isCollabTokenExpired", () => {
  it("is false for a token whose expiry is still ahead", () => {
    expect(isCollabTokenExpired(jwt({ exp: 2_000 }), 1_000_000)).toBe(false);
  });

  it("is true once the expiry has passed", () => {
    expect(isCollabTokenExpired(jwt({ exp: 1_000 }), 2_000_000)).toBe(true);
  });

  it("is true exactly at the expiry second", () => {
    expect(isCollabTokenExpired(jwt({ exp: 1_000 }), 1_000_000)).toBe(true);
  });

  // The regression this function exists for: `jwtDecode(undefined)` throws
  // `Invalid token specified`, and the token *is* undefined on an offline boot
  // because `["collab-token"]` is never persisted.
  it.each([undefined, null, ""])("is true for a missing token (%p)", (token) => {
    expect(() => isCollabTokenExpired(token)).not.toThrow();
    expect(isCollabTokenExpired(token)).toBe(true);
  });

  it.each(["not-a-jwt", "a.b", "..", "eyJhbGciOiJIUzI1NiJ9.@@@.sig"])(
    "is true for an unreadable token (%p)",
    (token) => {
      expect(() => isCollabTokenExpired(token)).not.toThrow();
      expect(isCollabTokenExpired(token)).toBe(true);
    },
  );

  it("is true for a token carrying no usable expiry", () => {
    expect(isCollabTokenExpired(jwt({ sub: "user" }))).toBe(true);
    expect(isCollabTokenExpired(jwt({ exp: "soon" }))).toBe(true);
    expect(isCollabTokenExpired(jwt({ exp: null }))).toBe(true);
  });

  it("defaults to the current clock", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 3600;

    expect(isCollabTokenExpired(jwt({ exp: future }))).toBe(false);
    expect(isCollabTokenExpired(jwt({ exp: past }))).toBe(true);
  });
});
