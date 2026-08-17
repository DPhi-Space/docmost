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

describe("saveExcalidrawOrQueue — dangling attachment id", () => {
  const missingTarget = () =>
    Object.assign(new Error("Not Found"), {
      response: {
        status: 404,
        data: { message: "Existing attachment to overwrite not found" },
      },
    });

  const uploadedAttachment = {
    id: "new-server-id",
    fileName: "diagram.excalidraw.svg",
    fileSize: 6,
    mimeType: "image/svg+xml",
    updatedAt: new Date().toISOString(),
  };

  it("re-uploads as a new attachment and re-points the node", async () => {
    // The copy-to-space case: the node points at an id the server never
    // received, so the overwrite can only ever 404. Upstream left the diagram
    // permanently unsaveable and said nothing.
    uploadFile
      .mockRejectedValueOnce(missingTarget())
      .mockResolvedValueOnce(uploadedAttachment);

    const result = await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "dangling-id",
    });

    expect(uploadFile).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "page-1",
      "dangling-id",
    );
    // The retry must not send the dangling id again.
    expect(uploadFile).toHaveBeenNthCalledWith(2, expect.anything(), "page-1");
    expect(result.queued).toBe(false);
    expect(result.attrs?.attachmentId).toBe("new-server-id");
  });

  it("repairs the 400 twin (an attachment owned by another page)", async () => {
    uploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error("Bad Request"), {
          response: {
            status: 400,
            data: { message: "File attachment does not match" },
          },
        }),
      )
      .mockResolvedValueOnce(uploadedAttachment);

    const result = await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "other-pages-id",
    });

    expect(result.attrs?.attachmentId).toBe("new-server-id");
  });

  it("does not repair a refusal — those still rethrow and keep the record", async () => {
    readUploadRecord.mockResolvedValue({
      attachmentId: "real-id",
      mode: "overwrite",
      status: "pending",
    });
    const refusal = Object.assign(new Error("Forbidden"), {
      response: { status: 403, data: { message: "Forbidden" } },
    });
    uploadFile.mockRejectedValue(refusal);

    await expect(
      saveExcalidrawOrQueue({
        file: svgFile(),
        pageId: "page-1",
        attachmentId: "real-id",
      }),
    ).rejects.toBe(refusal);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(deleteUploadRecord).not.toHaveBeenCalled();
  });

  it("still queues on a transport failure rather than forking an attachment", async () => {
    // `isMissingOverwriteTarget` is checked first, so it must not swallow the
    // offline case: no `response` at all means the network died, and the save
    // belongs in the outbox under its existing id.
    shouldQueueUploadsOffline.mockReturnValue(true);
    uploadFile.mockRejectedValue(new Error("Network Error"));

    const result = await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "real-id",
    });

    expect(result.queued).toBe(true);
    expect(enqueueUpload).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: "real-id", mode: "overwrite" }),
    );
  });

  it("deletes a superseded queued record after repairing", async () => {
    readUploadRecord.mockResolvedValue({
      attachmentId: "dangling-id",
      mode: "overwrite",
      status: "pending",
    });
    uploadFile
      .mockRejectedValueOnce(missingTarget())
      .mockResolvedValueOnce(uploadedAttachment);

    await saveExcalidrawOrQueue({
      file: svgFile(),
      pageId: "page-1",
      attachmentId: "dangling-id",
    });

    // The record's id names an attachment that does not exist, so replaying it
    // could only 404 forever; the drawing it held was just uploaded.
    expect(deleteUploadRecord).toHaveBeenCalledWith("dangling-id");
  });
});
