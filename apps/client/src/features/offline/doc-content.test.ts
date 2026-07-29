import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { hasDocContent } from "./doc-content";

describe("hasDocContent", () => {
  it("rejects a document nothing has ever been written to", () => {
    // The empty shell an orphaned sync marker used to open a live editor on.
    expect(hasDocContent(new Y.Doc())).toBe(false);
  });

  it("rejects a document that has only been read from", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment("default");
    doc.getMap("meta");

    expect(hasDocContent(doc)).toBe(false);
  });

  it("accepts a document carrying page content", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    fragment.insert(0, [new Y.XmlElement("paragraph")]);

    expect(hasDocContent(doc)).toBe(true);
  });

  it("accepts a document restored from a stored update", () => {
    // The real offline path: y-indexeddb replays an update into a fresh doc.
    const source = new Y.Doc();
    source.getText("body").insert(0, "server content");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));

    expect(hasDocContent(restored)).toBe(true);
  });

  it("still accepts a synced page whose content was all deleted", () => {
    // "Synced and empty" is not "never synced". Refusing this would make a
    // genuinely blank page uneditable offline for no reason.
    const doc = new Y.Doc();
    const text = doc.getText("body");
    text.insert(0, "gone");
    text.delete(0, 4);

    expect(hasDocContent(doc)).toBe(true);
  });

  it("treats an absent document as empty", () => {
    expect(hasDocContent(undefined)).toBe(false);
    expect(hasDocContent(null)).toBe(false);
  });

  it("treats an unreadable document as empty rather than throwing", () => {
    const hostile = {
      get store() {
        throw new Error("destroyed");
      },
    } as unknown as Y.Doc;

    expect(hasDocContent(hostile)).toBe(false);
  });
});
