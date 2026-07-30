/**
 * Render-path regression tests for the blocked-work UI (#42 review, BUG 1).
 *
 * The verification pass reported the pill/review surface failing to present a
 * blocked upload. The replay side is pinned by `upload-replay.test.ts`; this
 * suite pins the presentation side against the exact record shapes a pass can
 * produce — above all a blocked record with **no `link`** (recorded before the
 * resolver was installed, or for a page the query cache never held) and a
 * `lastPass` without `uploadedFiles` (the pre-#21 shape) — so no render or
 * effect can crash over them, and the Download affordance actually offers the
 * blob.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import type { UploadOutboxRecord } from "./upload-outbox";
import { resetResyncState, setResyncState } from "./resync-state";

/* ---- jsdom polyfills Mantine needs ---- */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? "")),
  }),
}));
vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
}));
// The manager hooks need a QueryClientProvider and real timers; the pill's
// rendering does not. `ResyncManagerHost` is exercised by its own suites.
vi.mock("./use-offline-resync", () => ({
  useOfflineDataOwnership: () => {},
  useOfflineResync: () => {},
}));
vi.mock("./offline-editing-settings", () => ({
  useOfflineEditingEnabled: () => true,
}));
let onlineForTest = true;
vi.mock("./online-state", () => ({
  useOnlineStatus: () => onlineForTest,
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

const { ResyncIndicator } = await import("./resync-indicator");

/** The exact shape the locked/trashed repro leaves behind: blocked, no link. */
function blockedRecordWithoutLink(): UploadOutboxRecord {
  return {
    attachmentId: "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001",
    pageId: "page-1",
    kind: "excalidraw",
    nodeType: "excalidraw",
    mode: "overwrite",
    blob: new Blob(["<svg/>"], { type: "image/svg+xml" }),
    fileName: "diagram.excalidraw.svg",
    mimeType: "image/svg+xml",
    createdAt: 1,
    updatedAt: 2,
    status: "pending",
    blocked: { reason: "no-access", at: 3 },
    // No `link`, no `uploaded`: both legitimately absent.
  };
}

function renderPill() {
  return render(
    <MantineProvider>
      <ResyncIndicator />
    </MantineProvider>,
  );
}

describe("ResyncIndicator with a blocked upload", () => {
  beforeEach(() => {
    resetResyncState();
  });

  it("shows the review pill for a blocked upload that has no link metadata", () => {
    act(() => {
      setResyncState({ blockedUploads: [blockedRecordWithoutLink()] });
    });
    renderPill();
    expect(screen.getByText("1 item could not sync — review")).toBeTruthy();
  });

  it("lists the record in the review modal with a working Download", async () => {
    const createObjectURL = vi.fn(() => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    const record = blockedRecordWithoutLink();
    act(() => {
      setResyncState({ blockedUploads: [record] });
    });
    renderPill();

    fireEvent.click(screen.getByText("1 item could not sync — review"));
    // Mantine mounts the modal through a transition; wait for its content.
    expect(await screen.findByText("diagram.excalidraw.svg")).toBeTruthy();
    // Without a link the row falls back to a generic page anchor built from
    // the pageId — present, never a crash.
    expect(screen.getByText("Open page")).toBeTruthy();
    expect(
      screen.getByText(
        "The upload was refused — the page may have been deleted, or your access removed.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Download"));
    expect(createObjectURL).toHaveBeenCalledWith(record.blob);
  });

  it("mixes blocked pages and blocked uploads into one count", () => {
    act(() => {
      setResyncState({
        blocked: [
          {
            pageId: "p1",
            dirtySince: 1,
            updatedAt: 2,
            blocked: { reason: "not-accepted", at: 3 },
          },
        ],
        blockedUploads: [blockedRecordWithoutLink()],
      });
    });
    renderPill();
    expect(screen.getByText("2 items could not sync — review")).toBeTruthy();
  });

  it("survives a lastPass without uploadedFiles (pre-#21 shape / half-finished pass)", () => {
    act(() => {
      setResyncState({
        blockedUploads: [blockedRecordWithoutLink()],
        lastPass: { at: 99, synced: 1, blocked: 0 },
      });
    });
    // The toast effect reads lastPass.uploadedFiles; absence must not throw.
    expect(() => renderPill()).not.toThrow();
  });

  it("shows the waiting pill for pending uploads while offline (what gap #4's boot publish feeds)", () => {
    onlineForTest = false;
    try {
      act(() => {
        setResyncState({ pendingUploads: 2 });
      });
      renderPill();
      expect(screen.getByText("2 uploads waiting for connection")).toBeTruthy();
    } finally {
      onlineForTest = true;
    }
  });
});
