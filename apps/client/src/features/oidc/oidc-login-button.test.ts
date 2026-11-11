import { describe, expect, it } from "vitest";
import { buildOidcLoginUrl } from "./oidc-login-button";

describe("buildOidcLoginUrl", () => {
  it("passes a deep link through as an encoded redirect", () => {
    expect(buildOidcLoginUrl("/s/general/p/page-1?x=1")).toBe(
      "/api/oidc/login?redirect=%2Fs%2Fgeneral%2Fp%2Fpage-1%3Fx%3D1",
    );
    expect(buildOidcLoginUrl(null)).toBe("/api/oidc/login");
  });
});
