import { describe, expect, it } from "vitest";
import { resolveBuildId } from "./build-id";

const never = () => {
  throw new Error("must not be consulted");
};

describe("resolveBuildId", () => {
  it("prefers the BUILD_ID env var (the CI/Docker path)", () => {
    expect(
      resolveBuildId({ env: "abc123", gitShortSha: never, timestamp: never }),
    ).toBe("abc123");
  });

  it("treats an empty env var as absent, not as an id", () => {
    // Dockerfile declares `ARG BUILD_ID=""`; a constant "" as the id would be
    // the never-rotating buster all over again.
    expect(
      resolveBuildId({
        env: "",
        gitShortSha: () => "deadbee",
        timestamp: never,
      }),
    ).toBe("deadbee");
  });

  it("falls back to the git short SHA (local builds)", () => {
    expect(
      resolveBuildId({
        env: undefined,
        gitShortSha: () => "f00dcafe",
        timestamp: never,
      }),
    ).toBe("f00dcafe");
  });

  it("rotates by timestamp when neither exists (arg-less Docker builds)", () => {
    const at = (ms: number) =>
      resolveBuildId({ env: undefined, gitShortSha: () => null, timestamp: () => ms });

    expect(at(1_000)).not.toBe(at(2_000));
    expect(at(1_000)).toBe(at(1_000));
  });
});
