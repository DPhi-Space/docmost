import { describe, expect, it } from "vitest";
import { pendingNodeAttrs, uploadedNodeAttrs } from "./pending-media";
import type { UploadedAttachmentInfo } from "./upload-outbox";

const input = {
  attachmentId: "11111111-2222-4333-8444-555555555555",
  fileName: "photo.png",
  fileSize: 1234,
  mimeType: "image/png",
};

const uploaded: UploadedAttachmentInfo = {
  id: "real-id",
  fileName: "photo.png",
  fileSize: 1234,
  mimeType: "image/png",
  updatedAt: "2026-01-02T03:04:05.000Z",
};

describe("pendingNodeAttrs", () => {
  it("gives every node a real-shaped attachment URL", () => {
    // The whole design: the service worker's existing api-file route serves
    // these URLs from the outbox blob, so no node view needs patching and the
    // render survives reload (an object URL would not).
    for (const nodeType of ["image", "video", "pdf"] as const) {
      const attrs = pendingNodeAttrs(nodeType, input);
      expect(attrs.src).toBe(
        "/api/files/11111111-2222-4333-8444-555555555555/photo.png",
      );
      expect(attrs.attachmentId).toBe(input.attachmentId);
    }
  });

  it("uses `url` for attachment nodes, matching attachment-upload.ts", () => {
    const attrs = pendingNodeAttrs("attachment", input);
    expect(attrs.url).toBe(
      "/api/files/11111111-2222-4333-8444-555555555555/photo.png",
    );
    expect(attrs.name).toBe("photo.png");
    expect(attrs.mime).toBe("image/png");
    expect(attrs.size).toBe(1234);
  });

  it("carries probed dimensions on image and video nodes", () => {
    const attrs = pendingNodeAttrs("image", {
      ...input,
      dimensions: { width: 100, height: 50, aspectRatio: 2 },
    });
    expect(attrs).toMatchObject({ width: 100, height: 50, aspectRatio: 2 });
  });

  it("stamps the excalidraw cache-buster", () => {
    const attrs = pendingNodeAttrs("excalidraw", { ...input, timestamp: 42 });
    expect(attrs.src).toMatch(/\?t=42$/);
    expect(attrs.title).toBe("photo.png");
  });

  it("percent-encodes file names so the URL stays one path segment", () => {
    const attrs = pendingNodeAttrs("image", {
      ...input,
      fileName: "a b?.png",
    });
    expect(attrs.src).toBe(
      "/api/files/11111111-2222-4333-8444-555555555555/a%20b%3F.png",
    );
  });
});

describe("uploadedNodeAttrs", () => {
  it("rewrites to the server id, mirroring the upstream final attrs", () => {
    expect(uploadedNodeAttrs("image", uploaded)).toEqual({
      src: "/api/files/real-id/photo.png",
      attachmentId: "real-id",
      size: 1234,
    });
    expect(uploadedNodeAttrs("attachment", uploaded)).toEqual({
      url: "/api/files/real-id/photo.png",
      name: "photo.png",
      mime: "image/png",
      size: 1234,
      attachmentId: "real-id",
    });
  });

  it("derives the excalidraw ?t= from the server's updatedAt", () => {
    const attrs = uploadedNodeAttrs("excalidraw", uploaded);
    expect(attrs.src).toBe(
      `/api/files/real-id/photo.png?t=${new Date(uploaded.updatedAt!).getTime()}`,
    );
  });

  it("never includes layout attrs, so a merge cannot clobber width or align", () => {
    for (const nodeType of ["image", "video", "pdf", "attachment"] as const) {
      const attrs = uploadedNodeAttrs(nodeType, uploaded);
      expect(attrs).not.toHaveProperty("width");
      expect(attrs).not.toHaveProperty("align");
    }
  });
});
