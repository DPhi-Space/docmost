/**
 * Render regression test for the share modal's Publish tab.
 *
 * `3fe1f6ba` folded the slug input's two `useState`s into one derived
 * `slugDraft`, and the derivation compared `slugDraft?.shareId === share?.id`
 * before dereferencing `slugDraft.sourceSlug`. With no draft and no share both
 * sides are `undefined`, so the comparison is *true* and the next term throws
 * `null is not an object (evaluating 'sourceSlug')` — which is every first
 * render of this component, since the share query has no data yet. The whole
 * page went to the error boundary ("Failed to load page").
 *
 * These cases pin the two states where `share` is absent: still loading, and
 * a page that is not shared at all.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

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

const shareData = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ pageSlug: "page-slug", spaceSlug: "space-slug" }),
}));
vi.mock("@/features/share/queries/share-query", () => ({
  useShareForPageQuery: () => ({ data: shareData.current }),
  useCreateShareMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateShareMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteShareMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/ee/hooks/use-trial", () => ({
  default: () => ({ isTrial: false }),
}));
vi.mock("@/lib/config", () => ({
  getAppUrl: () => "https://docs.example.com",
  isCloud: () => false,
}));
vi.mock("@/lib", () => ({ getPageIcon: () => null }));
vi.mock("@/components/common/copy", () => ({ default: () => null }));

import { PublishTab } from "./publish-tab";

function renderTab() {
  return render(
    <MantineProvider>
      <PublishTab pageId="page-id" />
    </MantineProvider>,
  );
}

describe("PublishTab", () => {
  it("renders while the share query has no data yet", () => {
    shareData.current = undefined;
    renderTab();
    expect(screen.getByText("Share to web")).toBeTruthy();
  });

  it("renders for a page that is not shared", () => {
    shareData.current = null;
    renderTab();
    expect(screen.getByText("Share to web")).toBeTruthy();
  });

  it("shows the existing slug for a shared page", () => {
    shareData.current = { id: "share-id", level: 0, slug: "my-slug" };
    renderTab();
    expect(
      (screen.getByDisplayValue("my-slug") as HTMLInputElement).value,
    ).toBe("my-slug");
  });
});
