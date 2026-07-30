import { describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

// The services module reaches api-client, whose import graph opens IndexedDB
// (persisted-store) — not available under jsdom. The retry policy under test
// never touches it.
vi.mock("../services/auth-service", () => ({
  getCollabToken: vi.fn(),
  verifyUserToken: vi.fn(),
}));

import { collabTokenRetry } from "./auth-query";

function axiosErrorWithStatus(status: number): AxiosError {
  const error = new AxiosError("Request failed", "ERR_BAD_REQUEST");
  error.response = {
    status,
    statusText: "",
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

/** What axios produces when nothing came back at all: `response` is absent. */
function transportError(): AxiosError {
  return new AxiosError("Network Error", "ERR_NETWORK");
}

describe("collabTokenRetry", () => {
  it("BUG regression (#42 review): a transport failure must not crash the retry callback", () => {
    // `error.response` is undefined here; the previous implementation threw
    // `TypeError: Cannot read properties of undefined (reading 'status')`
    // inside React Query's retry evaluation — an uncaught error on every
    // offline/reconnect boundary, reproduced in a real browser.
    expect(() => collabTokenRetry(0, transportError())).not.toThrow();
    // And a dead network is a reason to retry, not to give up.
    expect(collabTokenRetry(0, transportError())).toBe(true);
  });

  it("never retries a 404 (upstream behaviour, kept)", () => {
    expect(collabTokenRetry(0, axiosErrorWithStatus(404))).toBe(false);
  });

  it("retries other server answers", () => {
    expect(collabTokenRetry(0, axiosErrorWithStatus(500))).toBe(true);
    expect(collabTokenRetry(0, axiosErrorWithStatus(401))).toBe(true);
  });

  it("retries non-axios errors rather than crashing on them", () => {
    expect(collabTokenRetry(0, new Error("boom"))).toBe(true);
    expect(collabTokenRetry(0, undefined)).toBe(true);
  });
});
