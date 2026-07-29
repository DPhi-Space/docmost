import { describe, expect, it } from "vitest";
import {
  canEditWithoutConnection,
  type OfflineEditGateInput,
} from "./offline-edit-gate";

/**
 * The safety invariant, enumerated rather than sampled.
 *
 * Every one of the thirty-two combinations is generated, because the property
 * that matters is not "the happy path works" — it is that *thirty-one* of them
 * refuse. Two rows carry the weight:
 *
 * - `hasSyncedBefore: false` — a document that has never completed a real
 *   remote sync is never editable, which is what keeps this out of the class of
 *   upstream's data-loss regression (docmost#2353);
 * - `hasLocalContent: false` — a marker whose `page.<pageId>` database has gone
 *   missing must not open a live, blank editor claiming the user's changes are
 *   saved locally.
 *
 * There is deliberately no "agrees with its specification" case restating the
 * boolean expression: a test that re-implements the implementation cannot fail
 * for any reason worth knowing about.
 */
const ALL = [false, true];

function everyCombination(): OfflineEditGateInput[] {
  const rows: OfflineEditGateInput[] = [];
  for (const featureEnabled of ALL)
    for (const isLocalSynced of ALL)
      for (const hasSyncedBefore of ALL)
        for (const hasLocalContent of ALL)
          for (const isOnline of ALL)
            rows.push({
              featureEnabled,
              isLocalSynced,
              hasSyncedBefore,
              hasLocalContent,
              isOnline,
            });
  return rows;
}

const PERMITTED: OfflineEditGateInput = {
  featureEnabled: true,
  isLocalSynced: true,
  hasSyncedBefore: true,
  hasLocalContent: true,
  isOnline: false,
};

describe("canEditWithoutConnection", () => {
  it("enumerates thirty-two combinations", () => {
    expect(everyCombination()).toHaveLength(32);
  });

  it("permits exactly one of them", () => {
    const permitted = everyCombination().filter(canEditWithoutConnection);

    expect(permitted).toEqual([PERMITTED]);
  });

  it.each([
    ["the switch is off", { featureEnabled: false }],
    ["y-indexeddb has not loaded the document yet", { isLocalSynced: false }],
    ["the page has never completed a real remote sync", { hasSyncedBefore: false }],
    ["the local document is an empty shell", { hasLocalContent: false }],
    ["the browser believes it is online", { isOnline: true }],
  ])("refuses when %s, with everything else in its favour", (_why, override) => {
    expect(canEditWithoutConnection({ ...PERMITTED, ...override })).toBe(false);
  });

  it("refuses when nothing at all is true", () => {
    expect(
      canEditWithoutConnection({
        featureEnabled: false,
        isLocalSynced: false,
        hasSyncedBefore: false,
        hasLocalContent: false,
        isOnline: true,
      }),
    ).toBe(false);
  });

  it("permits a previously-synced, populated page on an offline device", () => {
    expect(canEditWithoutConnection(PERMITTED)).toBe(true);
  });
});
