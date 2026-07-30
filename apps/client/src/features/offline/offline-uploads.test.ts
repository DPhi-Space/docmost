/**
 * The Excalidraw save seam (`saveExcalidrawOrQueue`), pinned where the #42
 * review looked: what a queued overwrite does to the node attrs (gap #3), and
 * what happens to a queued record when the *online* path meets it — a server
 * refusal must rethrow and must NOT delete the queued record, because the
 * queued blob may be the only copy of the drawing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadFile = vi.fn();
vi.mock("@/features/page/services/page-service.ts", () => ({
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("@/i18n.ts", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("@/lib", () => ({ formatBytes: (n: number) => `${n}B` }));
vi.mock("@/lib/config.ts", () => ({
  getFileUploadSizeLimit: () => 1024 * 1024,
}));
vi.mock("./dirty-page-link", () => ({
  resolveDirtyPageLink: () => undefined,
}));
vi.mock("./upload-replay", () => ({
  publishUploadState: vi.fn(),
}));

const shouldQueueUploadsOffline = vi.fn(() => false);
vi.mock("./upload-interception", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./upload-interception")>()),
  shouldQueueUploadsOffline: () => shouldQueueUploadsOffline(),
}));

const enqueueUpload = vi.fn(async () => true);
const deleteUploadRecord = vi.fn(async () => {});
const readUploadRecord = vi.fn(async () => undefined as unknown);
vi.mock("./upload-outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./upload-outbox")>()),
  enqueueUpload: (...args: unknown[]) => enqueueUpload(...(args as [])),
  deleteUploadRecord: (...args: unknown[]) =>
    deleteUploadRecord(...(args as [])),
  readUploadRecord: (...args: unknown[]) => readUploadRecord(...(args as [])),
  listUploadRecords: async () => [],
}));

const { saveExcalidrawOrQueue } = await import("./offline-uploads");

const svgFile = () =>
  new File(["<svg/>"], "diagram.excalidraw.svg", { type: "image/svg+xml" });

beforeEach(() => {
  vi.clearAllMocks();
  shouldQueueUploadsOffline.mockReturnValue(false);
  readUploadRecord.mockResolvedValue(undefined);
  enqueueUpload.mockResolvedValue(true);
});

describe("saveExcalidrawOrQueue — queued overwrite (offline)", () => {
  it("gap #3: returns refreshed attrs (same id and path, new ?t) so the preview re-fetches", async () => {
    shouldQueueUploadsOffline.mockReturnValue(true);

    const result = await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "real-id",
    });

    expect(result.queued).toBe(true);
    // Not null (the pre-fix behaviour): the node view re-assigns `el.src`
    // when it changes, and the SW serves the queued blob for this id, so a
    // fresh cache-buster is what makes the new drawing appear immediately.
    expect(result.attrs).not.toBeNull();
    expect(result.attrs?.attachmentId).toBe("real-id");
    expect(result.attrs?.src).toMatch(
      /^\/api\/files\/real-id\/diagram\.excalidraw\.svg\?t=\d+$/,
    );
    expect(enqueueUpload).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: "real-id", mode: "overwrite" }),
    );
  });

  it("a new diagram still gets pending attrs under its placeholder id", async () => {
    shouldQueueUploadsOffline.mockReturnValue(true);

    const result = await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: null,
    });

    expect(result.queued).toBe(true);
    expect(result.attrs?.attachmentId).toBeTruthy();
    expect(result.attrs?.src).toContain(`/api/files/${result.attrs?.attachmentId}/`);
    expect(enqueueUpload).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "create" }),
    );
  });
});

describe("saveExcalidrawOrQueue — online path against a queued record", () => {
  it("BUG 1 family: a server refusal rethrows and KEEPS the queued record", async () => {
    // The modal-open-across-reconnect case: a queued overwrite exists, the
    // session is back online, and the direct save is refused (locked page,
    // access revoked). The refusal must surface to the caller — and the
    // queued blob, the only copy of the drawing, must stay in the outbox for
    // the replay to surface as blocked.
    readUploadRecord.mockResolvedValue({
      attachmentId: "real-id",
      mode: "overwrite",
      status: "pending",
    });
    const refusal = Object.assign(new Error("Forbidden"), {
      response: { status: 403 },
    });
    uploadFile.mockRejectedValue(refusal);

    await expect(
      saveExcalidrawOrQueue({
        file: svgFile(),
        pageId: "page-1",
        attachmentId: "real-id",
      }),
    ).rejects.toBe(refusal);

    expect(deleteUploadRecord).not.toHaveBeenCalled();
  });

  it("a successful direct save supersedes (deletes) the queued record", async () => {
    readUploadRecord.mockResolvedValue({
      attachmentId: "real-id",
      mode: "overwrite",
      status: "pending",
    });
    uploadFile.mockResolvedValue({
      id: "real-id",
      fileName: "diagram.excalidraw.svg",
      fileSize: 6,
      mimeType: "image/svg+xml",
      updatedAt: new Date().toISOString(),
    });

    const result = await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "real-id",
    });

    expect(result.queued).toBe(false);
    expect(deleteUploadRecord).toHaveBeenCalledWith("real-id");
  });

  it("a placeholder id never reaches the server: the save uploads fresh", async () => {
    readUploadRecord.mockResolvedValue({
      attachmentId: "placeholder-id",
      mode: "create",
      status: "pending",
    });
    uploadFile.mockResolvedValue({
      id: "server-id",
      fileName: "diagram.excalidraw.svg",
      fileSize: 6,
      mimeType: "image/svg+xml",
      updatedAt: new Date().toISOString(),
    });

    await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "placeholder-id",
    });

    // Third argument (attachmentId) must be undefined for a placeholder.
    expect(uploadFile).toHaveBeenCalledWith(
      expect.anything(),
      "page-1",
      undefined,
    );
    expect(deleteUploadRecord).toHaveBeenCalledWith("placeholder-id");
  });
});
