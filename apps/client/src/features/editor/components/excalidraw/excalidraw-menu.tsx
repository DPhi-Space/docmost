import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import { findParentNode, posToDOMRect, useEditorState } from "@tiptap/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Node as PMNode } from "@tiptap/pm/model";
import { isEditorReady } from "@docmost/editor-ext";
import {
  EditorMenuProps,
  ShouldShowProps,
} from "@/features/editor/components/table/types/types.ts";
import {
  ActionIcon,
  Button,
  Group,
  Text,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useDisclosure } from "@mantine/hooks";
import clsx from "clsx";
import {
  IconLayoutAlignCenter,
  IconLayoutAlignLeft,
  IconLayoutAlignRight,
  IconDownload,
  IconEdit,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getFileUrl } from "@/lib/config.ts";
import {
  notifyDiagramLoadFailed,
  notifyDiagramSaveFailed,
  saveExcalidrawOrQueue,
} from "@/features/offline/offline-uploads";
import { svgStringToFile } from "@/lib";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ReactClearModal from "react-clear-modal";
import { useHandleLibrary } from "@excalidraw/excalidraw";
import { localStorageLibraryAdapter } from "@/features/editor/components/excalidraw/excalidraw-utils.ts";
import { useAltTextControl } from "@/features/editor/components/common/use-alt-text-control.tsx";
import classes from "../common/toolbar-menu.module.css";

const ExcalidrawComponent = lazy(() =>
  import("@excalidraw/excalidraw").then((module) => ({
    default: module.Excalidraw,
  })),
);

export function ExcalidrawMenu({ editor }: EditorMenuProps) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI>(null);
  useHandleLibrary({
    excalidrawAPI,
    adapter: localStorageLibraryAdapter,
  });
  const [excalidrawData, setExcalidrawData] = useState<any>(null);
  const computedColorScheme = useComputedColorScheme();
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);
  const autosaveErrorNotifiedRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isInitialLoadRef = useRef(true);
  const lastFingerprintRef = useRef("");

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) {
        return null;
      }

      const excalidrawAttr = ctx.editor.getAttributes("excalidraw");
      return {
        isExcalidraw: ctx.editor.isActive("excalidraw"),
        isAlignLeft: ctx.editor.isActive("excalidraw", { align: "left" }),
        isAlignCenter: ctx.editor.isActive("excalidraw", { align: "center" }),
        isAlignRight: ctx.editor.isActive("excalidraw", { align: "right" }),
        src: excalidrawAttr?.src || null,
        attachmentId: excalidrawAttr?.attachmentId || null,
        alt: excalidrawAttr?.alt || "",
      };
    },
  });

  const shouldShow = useCallback(
    ({ state }: ShouldShowProps) => {
      if (!state) {
        return false;
      }

      return (
        editor.isActive("excalidraw") && editor.getAttributes("excalidraw")?.src
      );
    },
    [editor],
  );

  const getReferencedVirtualElement = useCallback(() => {
    if (!isEditorReady(editor)) return;
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "excalidraw";
    const parent = findParentNode(predicate)(selection);

    if (parent) {
      const dom = editor.view.nodeDOM(parent?.pos) as HTMLElement;
      const domRect = dom.getBoundingClientRect();
      return {
        getBoundingClientRect: () => domRect,
        getClientRects: () => [domRect],
      };
    }

    const domRect = posToDOMRect(editor.view, selection.from, selection.to);
    return {
      getBoundingClientRect: () => domRect,
      getClientRects: () => [domRect],
    };
  }, [editor]);

  const alignLeft = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setExcalidrawAlign("left")
      .run();
  }, [editor]);

  const alignCenter = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setExcalidrawAlign("center")
      .run();
  }, [editor]);

  const alignRight = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setExcalidrawAlign("right")
      .run();
  }, [editor]);

  const handleDownload = useCallback(() => {
    if (!editorState?.src) return;
    const url = getFileUrl(editorState.src);
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  }, [editorState?.src]);

  const handleDelete = useCallback(() => {
    editor.commands.deleteSelection();
  }, [editor]);

  const {
    button: altTextButton,
    panel: altTextPanel,
    isEditing: isEditingAlt,
  } = useAltTextControl({
    editor,
    nodeName: "excalidraw",
    currentAlt: editorState?.alt || "",
  });

  const handleOpen = useCallback(async () => {
    if (!editorState?.src) return;

    setIsLoading(true);
    try {
      const url = getFileUrl(editorState.src);
      const request = await fetch(url, {
        credentials: "include",
        cache: "no-store",
      });

      const { loadFromBlob } = await import("@excalidraw/excalidraw");
      const data = await loadFromBlob(await request.blob(), null, null);
      setExcalidrawData(data);
    } catch (err) {
      // Do NOT open on a failed load: this menu only opens EXISTING diagrams
      // (`editorState.src` is required above), so an empty canvas here is
      // never right — saving from it would overwrite the real drawing with a
      // blank scene. Seen offline/reconnect during the #21 verification as an
      // apparent "Uncaught TypeError: Failed to fetch" from this chunk.
      console.error(err);
      notifyDiagramLoadFailed();
      setIsLoading(false);
      return;
    }
    setIsLoading(false);
    isDirtyRef.current = false;
    isInitialLoadRef.current = true;
    autosaveErrorNotifiedRef.current = false;
    open();
  }, [editorState?.src, open]);

  const saveData = useCallback(async () => {
    if (!excalidrawAPI || isSavingRef.current) {
      return;
    }

    isSavingRef.current = true;
    setIsSaving(true);

    try {
      const { exportToSvg } = await import("@excalidraw/excalidraw");

      const svg = await exportToSvg({
        elements: excalidrawAPI?.getSceneElements(),
        appState: {
          exportEmbedScene: true,
          exportWithDarkMode: false,
        },
        files: excalidrawAPI?.getFiles(),
      });

      const serializer = new XMLSerializer();
      let svgString = serializer.serializeToString(svg);

      svgString = svgString.replace(
        /https:\/\/unpkg\.com\/@excalidraw\/excalidraw@undefined/g,
        "https://unpkg.com/@excalidraw/excalidraw@latest",
      );

      const fileName = "diagram.excalidraw.svg";
      const excalidrawSvgFile = await svgStringToFile(svgString, fileName);

      // @ts-ignore
      const pageId = editor.storage?.pageId;
      const attachmentId = editorState?.attachmentId;

      const saved = await saveExcalidrawOrQueue({
        file: excalidrawSvgFile,
        pageId,
        attachmentId,
      });

      if (saved.attrs) {
        editor.commands.updateAttributes("excalidraw", saved.attrs);
      }

      isDirtyRef.current = false;
      autosaveErrorNotifiedRef.current = false;
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [editor, excalidrawAPI, editorState?.attachmentId]);

  const handleSaveAndExit = useCallback(async () => {
    try {
      await saveData();
      close();
    } catch (error) {
      // The modal stays open — upstream behaviour, and correct, the drawing
      // must not be discarded — but upstream also said *nothing*, which is
      // indistinguishable from a save that worked. A dangling attachment id
      // (a page copied to another space) refuses every save forever.
      console.error(error);
      notifyDiagramSaveFailed(error);
    }
  }, [saveData, close]);

  const handleClose = useCallback(() => {
    if (!isDirtyRef.current) {
      close();
      return;
    }

    modals.openConfirmModal({
      title: t("Unsaved changes"),
      children: (
        <Text size="sm">
          {t("You have unsaved changes that will be lost.")}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Discard"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        isDirtyRef.current = false;
        close();
      },
    });
  }, [close, t]);

  useEffect(() => {
    if (!opened) return;

    const interval = setInterval(() => {
      if (isDirtyRef.current && !isSavingRef.current) {
        // Fires every 60 s while the diagram stays dirty, so it reports the
        // first failure of a session and then stays quiet.
        saveData().catch((error) => {
          console.error(error);
          if (autosaveErrorNotifiedRef.current) return;
          autosaveErrorNotifiedRef.current = true;
          notifyDiagramSaveFailed(error);
        });
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [opened, saveData]);

  return (
    <>
      <BaseBubbleMenu
        editor={editor}
        pluginKey={`excalidraw-menu`}
        updateDelay={0}
        getReferencedVirtualElement={getReferencedVirtualElement}
        options={{
          placement: "top",
          offset: 8,
          flip: false,
        }}
        shouldShow={shouldShow}
      >
        {isEditingAlt ? (
          altTextPanel
        ) : (
          <div className={classes.toolbar}>
          <Tooltip position="top" label={t("Align left")} withinPortal={false}>
            <ActionIcon
              onClick={alignLeft}
              size="lg"
              aria-label={t("Align left")}
              variant="subtle"
              className={clsx({
                [classes.active]: editorState?.isAlignLeft,
              })}
            >
              <IconLayoutAlignLeft size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip
            position="top"
            label={t("Align center")}
            withinPortal={false}
          >
            <ActionIcon
              onClick={alignCenter}
              size="lg"
              aria-label={t("Align center")}
              variant="subtle"
              className={clsx({
                [classes.active]: editorState?.isAlignCenter,
              })}
            >
              <IconLayoutAlignCenter size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Align right")} withinPortal={false}>
            <ActionIcon
              onClick={alignRight}
              size="lg"
              aria-label={t("Align right")}
              variant="subtle"
              className={clsx({
                [classes.active]: editorState?.isAlignRight,
              })}
            >
              <IconLayoutAlignRight size={18} />
            </ActionIcon>
          </Tooltip>

          <div className={classes.divider} />

          {altTextButton}

          <div className={classes.divider} />

          <Tooltip position="top" label={t("Edit")} withinPortal={false}>
            <ActionIcon
              onClick={handleOpen}
              size="lg"
              aria-label={t("Edit")}
              variant="subtle"
              loading={isLoading}
            >
              <IconEdit size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Download")} withinPortal={false}>
            <ActionIcon
              onClick={handleDownload}
              size="lg"
              aria-label={t("Download")}
              variant="subtle"
            >
              <IconDownload size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Delete")} withinPortal={false}>
            <ActionIcon
              onClick={handleDelete}
              size="lg"
              aria-label={t("Delete")}
              variant="subtle"
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
          </div>
        )}
      </BaseBubbleMenu>

      <ReactClearModal
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          padding: 0,
          zIndex: 200,
        }}
        isOpen={opened}
        onRequestClose={handleClose}
        disableCloseOnBgClick={true}
        contentProps={{
          style: {
            padding: 0,
            width: "90vw",
          },
        }}
      >
        <Group
          justify="flex-end"
          wrap="nowrap"
          bg="var(--mantine-color-body)"
          p="xs"
        >
          <Button onClick={handleSaveAndExit} size={"compact-sm"} loading={isSaving}>
            {t("Save & Exit")}
          </Button>
          <Button onClick={handleClose} color="red" size={"compact-sm"}>
            {t("Exit")}
          </Button>
        </Group>
        <div style={{ height: "90vh" }}>
          <Suspense fallback={null}>
            <ExcalidrawComponent
              excalidrawAPI={(api) => setExcalidrawAPI(api)}
              onChange={(elements, _appState, files) => {
                const fingerprint = `${elements.length}:${elements.reduce((s, e) => s + (e.version || 0), 0)}:${Object.keys(files).length}`;
                if (isInitialLoadRef.current) {
                  lastFingerprintRef.current = fingerprint;
                  isInitialLoadRef.current = false;
                  return;
                }
                if (fingerprint !== lastFingerprintRef.current) {
                  lastFingerprintRef.current = fingerprint;
                  isDirtyRef.current = true;
                }
              }}
              initialData={{
                ...excalidrawData,
                scrollToContent: true,
              }}
              theme={computedColorScheme}
            />
          </Suspense>
        </div>
      </ReactClearModal>
    </>
  );
}

export default ExcalidrawMenu;
