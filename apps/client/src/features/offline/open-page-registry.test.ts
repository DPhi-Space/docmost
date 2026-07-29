import { beforeEach, describe, expect, it } from "vitest";
import {
  claimOpenPage,
  getOpenPage,
  releaseOpenPage,
  resetOpenPageForTests,
} from "./open-page-registry";

describe("open page registry", () => {
  beforeEach(resetOpenPageForTests);

  it("starts with no document claimed", () => {
    expect(getOpenPage()).toBeNull();
  });

  it("reports the document the editor has taken", () => {
    claimOpenPage("page-1");

    expect(getOpenPage()).toBe("page-1");
  });

  it("lets the editor take a new document without releasing the old one first", () => {
    claimOpenPage("page-1");
    claimOpenPage("page-2");

    expect(getOpenPage()).toBe("page-2");
  });

  it("does not let a late release clear a claim that has moved on", () => {
    // `PageEditor` is not remounted across navigation: page-2's effect can run
    // before page-1's cleanup, and an unconditional clear would then leave the
    // page actually on screen unclaimed — and resyncable.
    claimOpenPage("page-1");
    claimOpenPage("page-2");

    releaseOpenPage("page-1");

    expect(getOpenPage()).toBe("page-2");
  });

  it("releases the document when the editor unmounts", () => {
    claimOpenPage("page-1");

    releaseOpenPage("page-1");

    expect(getOpenPage()).toBeNull();
  });
});
