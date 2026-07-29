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
import { platformModifierKey } from "@/lib";
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
 * Keys the vim layer must not swallow, whatever mode it is in.
 */
function shouldBypassVim(event: KeyboardEvent): boolean {
  // Find & replace. vim-prosemirror consumes Ctrl-f (page forward) in normal
  // mode and only ever checks `ctrlKey`, so on Windows/Linux it would eat the
  // find dialog's shortcut. Give the dialog priority on every platform; on
  // macOS the modifier is Cmd, so Ctrl-f still reaches vim.
  if (platformModifierKey(event) && (event.key === "f" || event.key === "F")) {
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

    const commands = editor.commands as Record<string, any>;

    const plugin = createVimPlugin({
      // Undo/redo belong to whoever owns history. With collaboration that is
      // the Yjs UndoManager; without it there is no history at all and vim's
      // `u` / `Ctrl-r` are correctly inert instead of a TypeError.
      undo: () =>
        safeRun(() =>
          typeof commands.undo === "function" ? commands.undo() : false,
        ),
      redo: () =>
        safeRun(() =>
          typeof commands.redo === "function" ? commands.redo() : false,
        ),
      indent: () =>
        safeRun(() => commands.sinkListItem?.("listItem")) ||
        safeRun(() => commands.sinkListItem?.("taskItem")) ||
        safeRun(() => commands.indent?.()),
      outdent: () =>
        safeRun(() => commands.liftListItem?.("listItem")) ||
        safeRun(() => commands.liftListItem?.("taskItem")) ||
        safeRun(() => commands.outdent?.()),
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
