import { describe, expect, it } from "vitest";
import {
  htmlApiResponseError,
  isHtmlApiResponse,
} from "./api-response-guard";

describe("isHtmlApiResponse", () => {
  // The field incident: an auth proxy answered an /api POST with 200 + its
  // login page. The envelope unwrap turned that into `undefined`, which an
  // infinite query committed as a page and the offline cache then persisted.
  it("flags a text/html content type regardless of body shape", () => {
    expect(isHtmlApiResponse("text/html", "<!doctype html>…")).toBe(true);
    expect(isHtmlApiResponse("text/html; charset=utf-8", {})).toBe(true);
    expect(isHtmlApiResponse("TEXT/HTML", "")).toBe(true);
  });

  it("flags an HTML body even when the content type lies", () => {
    // axios leaves the raw text in `data` when JSON.parse fails, so an HTML
    // body mislabelled as JSON arrives as a string starting with "<".
    expect(isHtmlApiResponse("application/json", "<!doctype html>")).toBe(true);
    expect(isHtmlApiResponse(undefined, "  <html><body>portal</body>")).toBe(
      true,
    );
  });

  it("accepts the JSON envelope every real endpoint answers", () => {
    expect(
      isHtmlApiResponse("application/json; charset=utf-8", {
        data: { items: [] },
        success: true,
        status: 200,
      }),
    ).toBe(false);
  });

  // The guard must never reject a response a legitimate endpoint produces:
  // empty bodies and odd-but-not-HTML payloads are the callers' business.
  it.each([
    ["an empty body", ""],
    ["a null body", null],
    ["an undefined body", undefined],
    ["a non-HTML string", "ok"],
    ["an array body", [1, 2]],
  ])("does not flag %s under a JSON content type", (_name, data) => {
    expect(isHtmlApiResponse("application/json", data)).toBe(false);
  });

  it("does not flag a missing content type with an object body", () => {
    expect(isHtmlApiResponse(undefined, { data: {} })).toBe(false);
  });
});

describe("htmlApiResponseError", () => {
  it("names the URL when it has one", () => {
    expect(htmlApiResponseError("https://x/api/pages/recent").message).toContain(
      "/api/pages/recent",
    );
    expect(htmlApiResponseError().message).toContain("received HTML");
  });
});
