import { describe, expect, it } from "vitest";
import { isMissingOverwriteTarget } from "./attachment-repair";

/** Shape of a rejected axios request, as `api-client.ts` re-throws it. */
function httpError(status: number, message: unknown) {
  return { response: { status, data: { message } } };
}

describe("isMissingOverwriteTarget", () => {
  it("repairs a dangling attachment id (the copy-to-space case)", () => {
    expect(
      isMissingOverwriteTarget(
        httpError(404, "Existing attachment to overwrite not found"),
      ),
    ).toBe(true);
  });

  it("repairs an attachment owned by another page (the copy-paste case)", () => {
    expect(
      isMissingOverwriteTarget(httpError(400, "File attachment does not match")),
    ).toBe(true);
  });

  it("does not care about the server's casing", () => {
    expect(
      isMissingOverwriteTarget(
        httpError(404, "EXISTING ATTACHMENT TO OVERWRITE NOT FOUND"),
      ),
    ).toBe(true);
  });

  // Everything below must surface to the user rather than silently forking a
  // second attachment: re-uploading would either fail identically or hide a
  // real refusal.
  it.each([
    ["a size limit", httpError(400, "File too large. Exceeds the 50MB limit")],
    ["a generic upload failure", httpError(400, "Error processing file upload.")],
    ["a malformed attachment id", httpError(400, "Invalid attachment id")],
    ["a missing page", httpError(404, "Page not found")],
    ["the fork's page lock", httpError(403, "Forbidden")],
    ["an expired session", httpError(401, "Unauthorized")],
    ["a server fault", httpError(500, "Internal server error")],
  ])("refuses to repair %s", (_label, err) => {
    expect(isMissingOverwriteTarget(err)).toBe(false);
  });

  it("refuses to repair a transport failure, which carries no response", () => {
    // `error.response` is undefined for DNS/connect/TLS/timeout failures —
    // reading into it unguarded is how `useCollabToken` threw during the #21
    // verification. Offline saves must retry, never fork a new attachment.
    expect(isMissingOverwriteTarget(new Error("Network Error"))).toBe(false);
    expect(isMissingOverwriteTarget(undefined)).toBe(false);
    expect(isMissingOverwriteTarget(null)).toBe(false);
  });

  it("tolerates a non-string message body", () => {
    expect(isMissingOverwriteTarget(httpError(404, { nested: true }))).toBe(
      false,
    );
    expect(isMissingOverwriteTarget(httpError(404, undefined))).toBe(false);
  });
});
