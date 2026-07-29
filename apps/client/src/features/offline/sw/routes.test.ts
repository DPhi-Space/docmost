import { describe, it, expect } from "vitest";
import {
  RoutableRequest,
  isNavigationRequest,
  isRealtimePath,
  resolveRoute,
} from "./routes";

const ORIGIN = "https://docs.example.com";

const isAbsolute = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url);

const req = (
  url: string,
  extra: Partial<RoutableRequest> = {},
): RoutableRequest => ({
  method: "GET",
  url: isAbsolute(url) ? url : `${ORIGIN}${url}`,
  mode: "cors",
  destination: "empty",
  ...extra,
});

const nav = (path: string): RoutableRequest =>
  req(path, { mode: "navigate", destination: "document" });

describe("resolveRoute — methods", () => {
  it("never intercepts non-GET requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(resolveRoute(req("/api/pages/update", { method }), ORIGIN)).toBe(
        "passthrough",
      );
      expect(resolveRoute(req("/assets/index-abc.js", { method }), ORIGIN)).toBe(
        "passthrough",
      );
    }
  });

  it("never intercepts range requests", () => {
    expect(
      resolveRoute(req("/api/files/vid.mp4", { hasRangeHeader: true }), ORIGIN),
    ).toBe("passthrough");
  });
});

describe("resolveRoute — realtime transports", () => {
  it("passes /collab and /socket.io straight through", () => {
    expect(resolveRoute(req("/collab"), ORIGIN)).toBe("passthrough");
    expect(resolveRoute(req("/collab/page-123"), ORIGIN)).toBe("passthrough");
    expect(resolveRoute(req("/socket.io/?EIO=4&transport=websocket"), ORIGIN)).toBe(
      "passthrough",
    );
  });

  it("does not treat a lookalike prefix as realtime", () => {
    expect(isRealtimePath("/collaborators")).toBe(false);
    expect(isRealtimePath("/collab")).toBe(true);
    expect(isRealtimePath("/collab/x")).toBe(true);
  });

  it("keeps a navigation to a lookalike path a normal navigation", () => {
    expect(resolveRoute(nav("/collaborators"), ORIGIN)).toBe("navigation");
  });
});

describe("resolveRoute — navigations", () => {
  it("routes top-level navigations to the navigation strategy", () => {
    expect(resolveRoute(nav("/"), ORIGIN)).toBe("navigation");
    expect(resolveRoute(nav("/s/engineering/p/design-doc-abc123"), ORIGIN)).toBe(
      "navigation",
    );
    expect(resolveRoute(nav("/share/custom-slug"), ORIGIN)).toBe("navigation");
  });

  it("detects navigations by mode or by destination", () => {
    expect(isNavigationRequest(req("/", { mode: "navigate" }))).toBe(true);
    expect(isNavigationRequest(req("/", { destination: "document" }))).toBe(true);
    expect(isNavigationRequest(req("/"))).toBe(false);
  });
});

describe("resolveRoute — assets", () => {
  it("routes hashed build assets to the asset strategy", () => {
    expect(resolveRoute(req("/assets/index-CmTnhK4F.js"), ORIGIN)).toBe("asset");
    expect(resolveRoute(req("/assets/index-V9vAIF2h.css"), ORIGIN)).toBe("asset");
    expect(resolveRoute(req("/assets/KaTeX_Main-Regular-B22.woff2"), ORIGIN)).toBe(
      "asset",
    );
  });

  it("routes shell public files to the asset strategy", () => {
    expect(resolveRoute(req("/manifest.json"), ORIGIN)).toBe("asset");
    expect(resolveRoute(req("/icons/favicon-32x32.png"), ORIGIN)).toBe("asset");
  });
});

describe("resolveRoute — locales and files", () => {
  it("routes i18next locale fetches to the locale strategy", () => {
    expect(resolveRoute(req("/locales/en-US/translation.json"), ORIGIN)).toBe(
      "locale",
    );
  });

  it("routes GET /api/files/* to the file strategy", () => {
    expect(
      resolveRoute(req("/api/files/abc/def/diagram.svg"), ORIGIN),
    ).toBe("api-file");
  });

  it("leaves every other API route untouched", () => {
    expect(resolveRoute(req("/api/users/me"), ORIGIN)).toBe("passthrough");
    expect(resolveRoute(req("/api/pages/info"), ORIGIN)).toBe("passthrough");
    expect(resolveRoute(req("/api/search"), ORIGIN)).toBe("passthrough");
  });
});

describe("resolveRoute — origins and oddities", () => {
  it("ignores cross-origin requests", () => {
    expect(
      resolveRoute(req("https://cdn.example.net/assets/x.js"), ORIGIN),
    ).toBe("passthrough");
    expect(
      resolveRoute(req("https://embed.diagrams.net/index.html"), ORIGIN),
    ).toBe("passthrough");
  });

  it("ignores non-http schemes", () => {
    expect(resolveRoute(req("chrome-extension://abc/x.js"), ORIGIN)).toBe(
      "passthrough",
    );
    expect(resolveRoute(req("data:text/plain,hi"), ORIGIN)).toBe("passthrough");
  });

  it("ignores unparseable urls", () => {
    expect(resolveRoute({ method: "GET", url: "http://[::1" }, ORIGIN)).toBe(
      "passthrough",
    );
  });

  it("does not let a query string change the decision", () => {
    expect(resolveRoute(req("/assets/index-abc.js?v=2"), ORIGIN)).toBe("asset");
  });

  it("does not serve an unknown top-level path as an asset", () => {
    expect(resolveRoute(req("/robots.txt"), ORIGIN)).toBe("passthrough");
  });
});
