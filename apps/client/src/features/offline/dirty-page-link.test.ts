import { afterEach, describe, expect, it } from "vitest";
import {
  dirtyPageHref,
  pageLinkFields,
  resolveDirtyPageLink,
  setDirtyPageLinkResolver,
} from "./dirty-page-link";
import type { DirtyPageRecord } from "./dirty-pages";

const record = (link?: DirtyPageRecord["link"]): DirtyPageRecord => ({
  pageId: "uuid-1",
  dirtySince: 1,
  updatedAt: 1,
  link,
});

afterEach(() => setDirtyPageLinkResolver(null));

describe("pageLinkFields", () => {
  it("projects the fields the registry stores", () => {
    expect(
      pageLinkFields({
        slugId: "abc",
        title: "Release notes",
        space: { slug: "eng" },
      }),
    ).toEqual({ slugId: "abc", title: "Release notes", spaceSlug: "eng" });
  });

  it("is undefined when nothing useful is known", () => {
    expect(pageLinkFields(undefined)).toBeUndefined();
    expect(pageLinkFields({})).toBeUndefined();
    expect(pageLinkFields({ space: {} })).toBeUndefined();
  });
});

describe("resolveDirtyPageLink", () => {
  it("answers undefined before a resolver has been installed", () => {
    // The state every unit test — and the app before it mounts — is in.
    expect(resolveDirtyPageLink("uuid-1")).toBeUndefined();
  });

  it("uses the installed resolver", () => {
    setDirtyPageLinkResolver(() => ({ slugId: "abc", title: "Notes" }));

    expect(resolveDirtyPageLink("uuid-1")).toEqual({
      slugId: "abc",
      title: "Notes",
      spaceSlug: undefined,
    });
  });

  it("never lets a broken resolver reach the editing hot path", () => {
    setDirtyPageLinkResolver(() => {
      throw new Error("cache exploded");
    });

    expect(resolveDirtyPageLink("uuid-1")).toBeUndefined();
  });
});

describe("dirtyPageHref", () => {
  it("builds a space-scoped URL when the space is known", () => {
    expect(
      dirtyPageHref(record({ slugId: "abc", title: "Release notes", spaceSlug: "eng" })),
    ).toBe("/s/eng/p/release-notes-abc");
  });

  it("falls back to the space-less redirect route", () => {
    expect(dirtyPageHref(record({ slugId: "abc", title: "Release notes" }))).toBe(
      "/p/release-notes-abc",
    );
  });

  it("uses the page id when even the slug was never captured", () => {
    // Not a working link, but a stable identifier — better than hiding an
    // entry that points at work living only on this device.
    expect(dirtyPageHref(record())).toContain("uuid-1");
  });
});
