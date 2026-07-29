import { Editor, Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  createVimPlugin,
  defaultVimState,
  vimPluginKey,
  type Mode,
  type VimState,
} from "vim-prosemirror";
import { isApplePlatform } from "@/lib";
import "vim-prosemirror/style.css";
import "@/features/editor/styles/vim-mode.css";

/**
 * Vim keybindings for the page editor, wrapping `vim-prosemirror`'s raw
 * ProseMirror plugin rather than the extension it ships.
 *
 * We wrap instead of using `vim-prosemirror/tiptap` for three reasons:
 *
 * 1. Its wrapper calls `editor.commands.undo()` unguarded. Undo/redo only
 *    exist here when the Collaboration extension is loaded, so the same
 *    extension array would throw in the pre-sync static editor, the readonly
 *    editor and the history editor — all of which share `mainExtensions`.
 * 2. Its `>>`/`<<` hardcodes `sinkListItem("listItem")` and never reaches our
 *    `Indent` extension or task items.
 * 3. Vim has to be switchable per user preference *without* rebuilding the
 *    extension array — that would tear down and recreate the collaborative
 *    editor mid-page, which is exactly the code path this fork keeps away from.
 *    So the plugin is always registered and gated at runtime instead.
 */

type VimRuntime = {
  enabled: boolean;
};

/**
 * Per-editor runtime state. A WeakMap rather than `editor.storage` because the
 * extension instance is shared across every editor built from
 * `mainExtensions`, and only the page editor may ever turn vim on.
 */
const runtimes = new WeakMap<Editor, VimRuntime>();

/** Soft keyboards emit keydown with keyCode 229 and no usable `key`, so modal
 *  editing silently degrades to "always insert". Don't offer it there. */
export function isVimSupportedDevice(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return !window.matchMedia("(pointer: coarse)").matches;
}

function getRuntime(editor: Editor | null | undefined): VimRuntime | undefined {
  return editor ? runtimes.get(editor) : undefined;
}

function isVimEnabled(editor: Editor | null | undefined): boolean {
  return Boolean(getRuntime(editor)?.enabled);
}

/**
 * Ctrl chords the browser and the app keep on non-Apple platforms, where Ctrl
 * is both the vim modifier and the OS one: clipboard, select-all, undo/redo,
 * and our find dialog. vim loses Ctrl-f (page forward) there; everything else
 * it binds (Ctrl-r/d/u/b) still reaches it.
 */
const RESERVED_CTRL_KEYS = new Set(["a", "c", "v", "x", "z", "y", "f"]);

/**
 * Keys the vim layer must not swallow, whatever mode it is in.
 */
function shouldBypassVim(event: KeyboardEvent): boolean {
  // vim-prosemirror never looks at metaKey — it reads Cmd-V as a bare "v"
  // (enter visual mode), Cmd-C as the change operator and Cmd-X as delete-
  // character, so on macOS copy/cut/paste silently do the wrong thing in
  // normal mode. Nothing in vim binds Cmd or Alt, so hand those back whole.
  if (event.metaKey || event.altKey) return true;

  if (
    event.ctrlKey &&
    !isApplePlatform &&
    RESERVED_CTRL_KEYS.has(event.key.toLowerCase())
  ) {
    return true;
  }

  // Suggestion popups own the keyboard while they are open.
  if (
    document.querySelector("#slash-command") ||
    document.querySelector("#emoji-command")
  ) {
    return true;
  }

  return false;
}

function safeRun(fn: () => boolean | undefined): boolean {
  try {
    return fn() ?? false;
  } catch {
    return false;
  }
}

export const VimMode = Extension.create({
  name: "vimMode",

  addProseMirrorPlugins() {
    const editor = this.editor;
    const runtime: VimRuntime = { enabled: false };
    runtimes.set(editor, runtime);

    // Resolved per keypress, never captured. `addProseMirrorPlugins` runs
    // while the editor is still being constructed, so the command map read
    // here would be a stale, empty one — which is what silently broke `u`.
    const command = (name: string) =>
      (editor.commands as Record<string, any> | undefined)?.[name];

    const plugin = createVimPlugin({
      // Undo/redo belong to whoever owns history. With collaboration that is
      // the Yjs UndoManager; without it there is no history at all and vim's
      // `u` / `Ctrl-r` are correctly inert instead of a TypeError.
      undo: () => safeRun(() => command("undo")?.()),
      redo: () => safeRun(() => command("redo")?.()),
      indent: () =>
        safeRun(() => command("sinkListItem")?.("listItem")) ||
        safeRun(() => command("sinkListItem")?.("taskItem")) ||
        safeRun(() => command("indent")?.()),
      outdent: () =>
        safeRun(() => command("liftListItem")?.("listItem")) ||
        safeRun(() => command("liftListItem")?.("taskItem")) ||
        safeRun(() => command("outdent")?.()),
    });

    // `plugin.props` holds the handlers already bound to the plugin, so they
    // can be wrapped in place. Anything the gate rejects falls through to
    // ProseMirror's normal behaviour, leaving the editor untouched when vim is
    // off.
    const props = plugin.props as any;
    const original = {
      handleKeyDown: props.handleKeyDown,
      handleTextInput: props.handleTextInput,
      decorations: props.decorations,
      attributes: props.attributes,
      mouseup: props.handleDOMEvents?.mouseup,
    };

    props.handleKeyDown = (view: EditorView, event: KeyboardEvent) => {
      if (!runtime.enabled || shouldBypassVim(event)) return false;
      return original.handleKeyDown?.(view, event) ?? false;
    };

    props.handleTextInput = (
      view: EditorView,
      from: number,
      to: number,
      text: string,
    ) => {
      if (!runtime.enabled) return false;
      return original.handleTextInput?.(view, from, to, text) ?? false;
    };

    props.decorations = (state: EditorState) =>
      runtime.enabled ? original.decorations?.(state) : null;

    props.attributes = (state: EditorState) =>
      runtime.enabled ? original.attributes?.(state) : {};

    if (props.handleDOMEvents) {
      props.handleDOMEvents.mouseup = (
        view: EditorView,
        event: MouseEvent,
      ) => {
        if (!runtime.enabled) return false;
        return original.mouseup?.(view, event) ?? false;
      };
    }

    return [plugin];
  },
});

/**
 * Turn vim on/off for a single editor. Cheap enough to call on every render —
 * it no-ops unless the value actually changed.
 */
export function setVimModeEnabled(
  editor: Editor | null | undefined,
  enabled: boolean,
): void {
  if (!editor || editor.isDestroyed) return;

  const runtime = getRuntime(editor);
  if (!runtime || runtime.enabled === enabled) return;

  runtime.enabled = enabled;

  // vim-prosemirror keeps one mutable state object for the plugin's lifetime,
  // so reset it here: re-enabling should always land in normal mode with no
  // half-typed operator or stale register pending.
  const state = vimPluginKey.getState(editor.state) as VimState | undefined;
  if (state) {
    Object.assign(state, defaultVimState(), {
      mode: enabled ? "normal" : "insert",
    });
  }

  // Empty transaction: no doc change, so no collab traffic and no `onUpdate`.
  // It just forces decorations and editor attributes to recompute.
  editor.view.dispatch(editor.state.tr);
}

export function getVimMode(editor: Editor | null | undefined): Mode | null {
  if (!editor || editor.isDestroyed || !isVimEnabled(editor)) return null;
  return vimPluginKey.getState(editor.state)?.mode ?? null;
}

export function getVimStatusMessage(editor: Editor | null | undefined): string {
  if (!editor || editor.isDestroyed || !isVimEnabled(editor)) return "";
  const state = vimPluginKey.getState(editor.state) as VimState | undefined;
  if (state?.searchActive) return `/${state.searchQuery}`;
  return state?.statusMessage ?? "";
}

export default VimMode;
