import { describe, expect, it } from "vitest";
import {
  canEditWithoutConnection,
  type OfflineEditGateInput,
} from "./offline-edit-gate";

/**
 * The safety invariant, enumerated rather than sampled.
 *
 * Every one of the sixteen combinations is listed, because the property that
 * matters is not "the happy path works" — it is that *fifteen* of them refuse.
 * In particular the row that must never flip is `hasSyncedBefore: false`: a
 * document that has never completed a real remote sync is never editable, which
 * is what keeps this out of the class of upstream's data-loss regression
 * (docmost#2353).
 */
const ALL = [false, true];

function expected(input: OfflineEditGateInput): boolean {
  return (
    input.featureEnabled &&
    input.isLocalSynced &&
    input.hasSyncedBefore &&
    !input.isOnline
  );
}

describe("canEditWithoutConnection", () => {
  it("permits exactly one combination out of sixteen", () => {
    const permitted: OfflineEditGateInput[] = [];
    for (const featureEnabled of ALL)
      for (const isLocalSynced of ALL)
        for (const hasSyncedBefore of ALL)
          for (const isOnline of ALL) {
            const input = {
              featureEnabled,
              isLocalSynced,
              hasSyncedBefore,
              isOnline,
            };
            if (canEditWithoutConnection(input)) permitted.push(input);
          }

    expect(permitted).toEqual([
      {
        featureEnabled: true,
        isLocalSynced: true,
        hasSyncedBefore: true,
        isOnline: false,
      },
    ]);
  });

  it.each([
    [
      "the switch is off",
      {
        featureEnabled: false,
        isLocalSynced: true,
        hasSyncedBefore: true,
        isOnline: false,
      },
    ],
    [
      "y-indexeddb has not loaded the document yet",
      {
        featureEnabled: true,
        isLocalSynced: false,
        hasSyncedBefore: true,
        isOnline: false,
      },
    ],
    [
      "the page has never completed a real remote sync",
      {
        featureEnabled: true,
        isLocalSynced: true,
        hasSyncedBefore: false,
        isOnline: false,
      },
    ],
    [
      "the browser believes it is online",
      {
        featureEnabled: true,
        isLocalSynced: true,
        hasSyncedBefore: true,
        isOnline: true,
      },
    ],
    [
      "nothing at all is true",
      {
        featureEnabled: false,
        isLocalSynced: false,
        hasSyncedBefore: false,
        isOnline: true,
      },
    ],
  ])("refuses when %s", (_why, input) => {
    expect(canEditWithoutConnection(input)).toBe(false);
  });

  it("permits a previously-synced page on an offline device with the switch on", () => {
    expect(
      canEditWithoutConnection({
        featureEnabled: true,
        isLocalSynced: true,
        hasSyncedBefore: true,
        isOnline: false,
      }),
    ).toBe(true);
  });

  it("agrees with its specification on every input", () => {
    for (const featureEnabled of ALL)
      for (const isLocalSynced of ALL)
        for (const hasSyncedBefore of ALL)
          for (const isOnline of ALL) {
            const input = {
              featureEnabled,
              isLocalSynced,
              hasSyncedBefore,
              isOnline,
            };
            expect(canEditWithoutConnection(input)).toBe(expected(input));
          }
  });
});
