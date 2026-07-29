import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { VimMode, getVimMode, setVimModeEnabled } from "./vim-mode";

/**
 * These cover the gate we own — that vim is inert until an editor opts in, that
 * insert mode gets out of the way, and that find-and-replace keeps its
 * shortcut. The vim semantics themselves belong to vim-prosemirror.
 */

let editor: Editor;

/** Run the key through ProseMirror's handleKeyDown chain, as a real keypress
 *  would. Returns true when something claimed the key. */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  return Boolean(
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, event),
    ),
  );
}

function cursor(): number {
  return editor.state.selection.from;
}

beforeEach(() => {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, VimMode],
    content: "<p>first line</p><p>second line</p>",
  });
  editor.commands.setTextSelection(2); // start of "first line"
});

afterEach(() => {
  editor.destroy();
});

describe("vim mode gating", () => {
  it("is inert until the editor opts in", () => {
    expect(getVimMode(editor)).toBeNull();
    expect(press("j")).toBe(false);
    expect(press("d")).toBe(false);
  });

  it("starts in normal mode once enabled", () => {
    setVimModeEnabled(editor, true);
    expect(getVimMode(editor)).toBe("normal");
  });

  it("claims motion keys in normal mode instead of typing them", () => {
    setVimModeEnabled(editor, true);
    const before = editor.getText();

    expect(press("j")).toBe(true);
    expect(cursor()).toBeGreaterThan(2);
    expect(editor.getText()).toBe(before);
  });

  it("gets out of the way in insert mode", () => {
    setVimModeEnabled(editor, true);
    expect(press("i")).toBe(true);
    expect(getVimMode(editor)).toBe("insert");

    // Plain characters must reach the browser's normal input handling.
    expect(press("j")).toBe(false);

    expect(press("Escape")).toBe(true);
    expect(getVimMode(editor)).toBe("normal");
  });

  it("deletes a line with dd", () => {
    setVimModeEnabled(editor, true);
    expect(press("d")).toBe(true);
    expect(press("d")).toBe(true);
    expect(editor.getText()).not.toContain("first line");
    expect(editor.getText()).toContain("second line");
  });

  it("leaves the find-and-replace shortcut alone", () => {
    setVimModeEnabled(editor, true);
    // On a non-Apple platform (jsdom reports none) Mod-f is Ctrl-f, which
    // vim-prosemirror would otherwise swallow as page-forward.
    expect(press("f", { ctrlKey: true })).toBe(false);
  });

  it("goes inert again when switched off, and resets on re-enable", () => {
    setVimModeEnabled(editor, true);
    press("v"); // enter visual mode
    expect(getVimMode(editor)).toBe("visual");

    setVimModeEnabled(editor, false);
    expect(getVimMode(editor)).toBeNull();
    expect(press("j")).toBe(false);

    setVimModeEnabled(editor, true);
    expect(getVimMode(editor)).toBe("normal");
  });

  it("does not throw when no history extension is loaded", () => {
    setVimModeEnabled(editor, true);
    // StarterKit here has undo/redo, but the readonly and pre-sync editors
    // share mainExtensions with no history at all; the wrapper must degrade
    // to a no-op rather than a TypeError.
    expect(() => press("u")).not.toThrow();
    expect(() => press("r", { ctrlKey: true })).not.toThrow();
  });
});
