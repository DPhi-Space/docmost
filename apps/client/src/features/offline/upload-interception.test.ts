import { describe, expect, it } from "vitest";
import {
  classifyUploadFailure,
  mediaNodeTypeForFile,
  shouldQueueAfterFailure,
  shouldQueueUploads,
  uploadBlockedReason,
} from "./upload-interception";

describe("shouldQueueUploads", () => {
  const base = {
    featureEnabled: true,
    serverReachable: false,
    dataIsOurs: true,
  };

  it("queues only when the switch is on, the server is unreachable and ownership is settled", () => {
    expect(shouldQueueUploads(base)).toBe(true);
  });

  it("never queues with the switch off — phase 4 must be inert by default", () => {
    expect(shouldQueueUploads({ ...base, featureEnabled: false })).toBe(false);
  });

  it("never queues while the server is reachable — online sessions take the upstream path", () => {
    expect(shouldQueueUploads({ ...base, serverReachable: true })).toBe(false);
  });

  it("never queues onto a disk whose offline data is not provably ours", () => {
    // Queued blobs are pushed under the current session's cookie on reconnect;
    // an unowned disk is the cross-account leak surface data-ownership.ts
    // exists to close.
    expect(shouldQueueUploads({ ...base, dataIsOurs: false })).toBe(false);
  });
});

describe("classifyUploadFailure", () => {
  it("reads no response at all as transport", () => {
    expect(classifyUploadFailure(new Error("network"))).toBe("transport");
    expect(classifyUploadFailure({ response: {} })).toBe("transport");
    expect(classifyUploadFailure(undefined)).toBe("transport");
  });

  it("maps the status families", () => {
    expect(classifyUploadFailure({ response: { status: 401 } })).toBe("auth");
    expect(classifyUploadFailure({ response: { status: 403 } })).toBe(
      "no-access",
    );
    expect(classifyUploadFailure({ response: { status: 404 } })).toBe(
      "no-access",
    );
    expect(classifyUploadFailure({ response: { status: 400 } })).toBe(
      "rejected",
    );
    expect(classifyUploadFailure({ response: { status: 413 } })).toBe(
      "rejected",
    );
    expect(classifyUploadFailure({ response: { status: 500 } })).toBe("server");
    expect(classifyUploadFailure({ response: { status: 502 } })).toBe("server");
  });
});

describe("shouldQueueAfterFailure", () => {
  it("reroutes only transport failures, and only when queueing is available", () => {
    expect(shouldQueueAfterFailure("transport", true)).toBe(true);
    expect(shouldQueueAfterFailure("transport", false)).toBe(false);
  });

  it("never hides a server answer behind an enqueue", () => {
    // A server that answered has made a decision; converting "no" into "it
    // will upload later" would be lying to the user.
    expect(shouldQueueAfterFailure("rejected", true)).toBe(false);
    expect(shouldQueueAfterFailure("no-access", true)).toBe(false);
    expect(shouldQueueAfterFailure("auth", true)).toBe(false);
    expect(shouldQueueAfterFailure("server", true)).toBe(false);
  });
});

describe("uploadBlockedReason", () => {
  it("marks server refusals blocked", () => {
    expect(uploadBlockedReason("no-access")).toBe("no-access");
    expect(uploadBlockedReason("rejected")).toBe("rejected");
  });

  it("retries everything that is not a server refusal", () => {
    // A dead network must never be reported to the user as "the server
    // refused this upload" — the same rule as #35 for page resync.
    expect(uploadBlockedReason("transport")).toBeNull();
    expect(uploadBlockedReason("server")).toBeNull();
    // 401 belongs to the session-expiry path, which preserves the outbox.
    expect(uploadBlockedReason("auth")).toBeNull();
  });
});

describe("mediaNodeTypeForFile", () => {
  it("mirrors the upstream validators' claims", () => {
    expect(mediaNodeTypeForFile("image/png")).toBe("image");
    expect(mediaNodeTypeForFile("video/mp4")).toBe("video");
    expect(mediaNodeTypeForFile("application/pdf")).toBe("pdf");
    expect(mediaNodeTypeForFile("application/zip")).toBe("attachment");
    // No audio action is wired into the paste path; audio is an attachment.
    expect(mediaNodeTypeForFile("audio/mpeg")).toBe("attachment");
    expect(mediaNodeTypeForFile("")).toBe("attachment");
  });
});
