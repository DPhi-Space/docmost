import { describe, expect, it } from "vitest";
import {
  outboxCandidateIdFromPath,
  outboxResponseHeaders,
} from "./outbox-serving";
import { pendingFileSrc } from "../upload-outbox";
import { resolveRoute } from "./routes";

const ORIGIN = "https://docs.example.com";
const ID = "11111111-2222-4333-8444-555555555555";

describe("outboxCandidateIdFromPath", () => {
  it("extracts the id from the exact URL shape pendingFileSrc produces", () => {
    // Pinned from the constant, like the health-probe route test: if the URL
    // shape ever changes, this fails instead of the render silently breaking.
    const src = pendingFileSrc(ID, "photo.png");
    expect(outboxCandidateIdFromPath(src)).toBe(ID);
  });

  it("handles encoded file names and nested tails", () => {
    expect(outboxCandidateIdFromPath(`/api/files/${ID}/a%20b.png`)).toBe(ID);
  });

  it("never matches the file API sub-routes", () => {
    // `/api/files/upload` and `/api/files/info` are POST-only, but the guard
    // must not depend on the method reaching this function.
    expect(outboxCandidateIdFromPath("/api/files/upload")).toBeNull();
    expect(outboxCandidateIdFromPath("/api/files/info")).toBeNull();
    expect(outboxCandidateIdFromPath("/api/files/")).toBeNull();
  });

  it("requires an id-shaped first segment", () => {
    expect(outboxCandidateIdFromPath("/api/files/not-an-id/f.png")).toBeNull();
    expect(outboxCandidateIdFromPath(`/api/files/${ID}/`)).toBeNull();
  });

  it("ignores non-file paths entirely", () => {
    expect(outboxCandidateIdFromPath("/api/pages/info")).toBeNull();
    expect(outboxCandidateIdFromPath(`/assets/${ID}/f.png`)).toBeNull();
  });
});

describe("the pending URL reaches the worker's api-file route", () => {
  it("classifies pendingFileSrc as api-file, so the outbox lookup can run", () => {
    // If routing ever stopped intercepting these, pending nodes would render
    // as 404s and offline reopening of a queued diagram would show stale data.
    const kind = resolveRoute(
      { method: "GET", url: ORIGIN + pendingFileSrc(ID, "photo.png") },
      ORIGIN,
    );
    expect(kind).toBe("api-file");
  });
});

describe("outboxResponseHeaders", () => {
  it("labels the body and forbids HTTP caching", () => {
    expect(
      outboxResponseHeaders({ mimeType: "image/png", blob: { size: 12 } }),
    ).toMatchObject({
      "content-type": "image/png",
      "content-length": "12",
      "cache-control": "no-store",
    });
  });

  it("falls back to octet-stream for an unlabelled blob", () => {
    expect(
      outboxResponseHeaders({ mimeType: "", blob: { size: 0 } })["content-type"],
    ).toBe("application/octet-stream");
  });
});
