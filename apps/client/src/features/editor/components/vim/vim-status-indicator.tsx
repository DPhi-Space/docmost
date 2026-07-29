import { Editor, useEditorState } from "@tiptap/react";
import {
  getVimMode,
  getVimStatusMessage,
} from "@/features/editor/extensions/vim-mode";

const MODE_LABELS: Record<string, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
  "visual-line": "V-LINE",
  replace: "REPLACE",
};

interface VimStatusIndicatorProps {
  editor: Editor;
}

export default function VimStatusIndicator({
  editor,
}: VimStatusIndicatorProps) {
  const vim = useEditorState({
    editor,
    selector: (ctx) => ({
      mode: getVimMode(ctx.editor),
      message: getVimStatusMessage(ctx.editor),
    }),
  });

  if (!vim?.mode) return null;

  return (
    <div className="vim-status-indicator" data-mode={vim.mode}>
      <span>-- {MODE_LABELS[vim.mode] ?? vim.mode.toUpperCase()} --</span>
      {vim.message && <span className="vim-status-message">{vim.message}</span>}
    </div>
  );
}
