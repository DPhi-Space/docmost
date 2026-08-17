import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import { findParentNode, posToDOMRect, useEditorState } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Node as PMNode } from "@tiptap/pm/model";
import { isEditorReady } from "@docmost/editor-ext";
import {
  EditorMenuProps,
  ShouldShowProps,
} from "@/features/editor/components/table/types/types.ts";
import {
  ActionIcon,
  LoadingOverlay,
  Modal,
  Text,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
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
import { getDrawioUrl, getFileUrl } from "@/lib/config.ts";
import { uploadFile } from "@/features/page/services/page-service.ts";
import {
  DrawIoEmbed,
  DrawIoEmbedRef,
  EventExit,
  EventExport,
  EventSave,
} from "react-drawio";
import { decodeBase64ToSvgString, svgStringToFile } from "@/lib/utils";
import { IAttachment } from "@/features/attachments/types/attachment.types";
import { modals } from "@mantine/modals";
import { useAltTextControl } from "@/features/editor/components/common/use-alt-text-control.tsx";
import { isMissingOverwriteTarget } from "@/features/attachments/attachment-repair.ts";
import classes from "../common/toolbar-menu.module.css";

/**
 * Promise wrapper around `FileReader`, so the caller can await the scene
 * before opening the modal. The callback form let `open()` run first, which
 * mounted the embed with the *previous* diagram's XML until the read landed.
 */
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result || "") as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error("drawio: could not read the diagram"));
    reader.readAsDataURL(blob);
  });
}

export function DrawioMenu({ editor }: EditorMenuProps) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const [initialXML, setInitialXML] = useState<string>("");
  const drawioRef = useRef<DrawIoEmbedRef>(null);
  const computedColorScheme = useComputedColorScheme();
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);
  const autosaveErrorNotifiedRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) {
        return null;
      }

      const drawioAttr = ctx.editor.getAttributes("drawio");
      return {
        isDrawio: ctx.editor.isActive("drawio"),
        isAlignLeft: ctx.editor.isActive("drawio", { align: "left" }),
        isAlignCenter: ctx.editor.isActive("drawio", { align: "center" }),
        isAlignRight: ctx.editor.isActive("drawio", { align: "right" }),
        src: drawioAttr?.src || null,
        attachmentId: drawioAttr?.attachmentId || null,
        alt: drawioAttr?.alt || "",
      };
    },
  });

  const shouldShow = useCallback(
    ({ state }: ShouldShowProps) => {
      if (!state) {
        return false;
      }

      return editor.isActive("drawio") && editor.getAttributes("drawio")?.src;
    },
    [editor],
  );

  const getReferencedVirtualElement = useCallback(() => {
    if (!isEditorReady(editor)) return;
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "drawio";
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
      .setDrawioAlign("left")
      .run();
  }, [editor]);

  const alignCenter = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setDrawioAlign("center")
      .run();
  }, [editor]);

  const alignRight = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setDrawioAlign("right")
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
    nodeName: "drawio",
    currentAlt: editorState?.alt || "",
  });

  const saveData = useCallback(async (svgXml: string) => {
    if (isSavingRef.current) return;

    isSavingRef.current = true;
    setIsSaving(true);

    try {
      const svgString = decodeBase64ToSvgString(svgXml);
      const fileName = "diagram.drawio.svg";
      const drawioSVGFile = await svgStringToFile(svgString, fileName);

      // @ts-ignore
      const pageId = editor.storage?.pageId;
      const attachmentId = editorState?.attachmentId;

      let attachment: IAttachment = null;
      if (attachmentId) {
        try {
          attachment = await uploadFile(drawioSVGFile, pageId, attachmentId);
        } catch (err) {
          if (!isMissingOverwriteTarget(err)) throw err;
          // Repair a dangling pointer instead of failing forever: upload a
          // fresh attachment and let `updateAttributes` below re-point the
          // node at it. See `isMissingOverwriteTarget`.
          attachment = await uploadFile(drawioSVGFile, pageId);
        }
      } else {
        attachment = await uploadFile(drawioSVGFile, pageId);
      }

      editor.commands.updateAttributes("drawio", {
        src: `/api/files/${attachment.id}/${attachment.fileName}?t=${new Date(attachment.updatedAt).getTime()}`,
        title: attachment.fileName,
        size: attachment.fileSize,
        attachmentId: attachment.id,
      });

      isDirtyRef.current = false;
      autosaveErrorNotifiedRef.current = false;
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [editor, editorState?.attachmentId]);

  /**
   * Both call sites used to discard this entirely (`.catch(() => {})`): the
   * modal sat there, nothing was written, and the 60 s autosave retried in
   * silence forever. Prefer the server's own message, which names the refusal.
   */
  const notifySaveFailed = useCallback(
    (err: unknown) => {
      console.error(err);
      notifications.show({
        color: "red",
        message:
          (err as { response?: { data?: { message?: string } } })?.response?.data
            ?.message ||
          t("The diagram could not be saved. Please try again."),
      });
    },
    [t],
  );

  /**
   * Autosave fires every 60 s while the diagram stays dirty, so it reports the
   * first failure of a session and then stays quiet; an explicit save always
   * reports. Reset on a successful save and on reopen.
   */
  const notifyAutosaveFailed = useCallback(
    (err: unknown) => {
      if (autosaveErrorNotifiedRef.current) {
        console.error(err);
        return;
      }
      autosaveErrorNotifiedRef.current = true;
      notifySaveFailed(err);
    },
    [notifySaveFailed],
  );

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

  const handleOpen = useCallback(async () => {
    if (!editorState?.src) return;

    setIsLoading(true);
    try {
      const url = getFileUrl(editorState.src);
      const request = await fetch(url, {
        credentials: "include",
        cache: "no-store",
      });
      // `fetch` rejects only on transport failure: a 404 resolves normally and
      // `blob()` turns the JSON error body into a perfectly valid-looking
      // "scene". Without this check a missing attachment reaches drawio as
      // garbage rather than as a failure.
      if (!request.ok) {
        throw new Error(`drawio: scene fetch failed with ${request.status}`);
      }
      setInitialXML(await readAsDataUrl(await request.blob()));
    } catch (err) {
      // Do NOT open on a failed load: this menu only ever opens an EXISTING
      // diagram (`editorState.src` is required above), so an empty canvas here
      // is never right — saving from it, or the 60 s autosave, would overwrite
      // the real drawing with a blank one. Same failure the Excalidraw menu
      // had (#21); the drawing itself is safe where it is.
      console.error(err);
      notifications.show({
        color: "red",
        message: t("Could not load the diagram. Please try again."),
      });
      setIsLoading(false);
      return;
    }
    setIsLoading(false);
    isDirtyRef.current = false;
    autosaveErrorNotifiedRef.current = false;
    open();
  }, [editorState?.src, open, t]);

  useEffect(() => {
    if (!opened) return;

    const interval = setInterval(() => {
      if (isDirtyRef.current && !isSavingRef.current && drawioRef.current) {
        drawioRef.current.exportDiagram({ format: "xmlsvg" });
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [opened]);

  useEffect(() => {
    if (!opened) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [opened, handleClose]);

  return (
    <>
      <BaseBubbleMenu
        editor={editor}
        pluginKey={`drawio-menu`}
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
              className={clsx({ [classes.active]: editorState?.isAlignLeft })}
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
              className={clsx({ [classes.active]: editorState?.isAlignCenter })}
            >
              <IconLayoutAlignCenter size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Align right")}>
            <ActionIcon
              onClick={alignRight}
              size="lg"
              aria-label={t("Align right")}
              variant="subtle"
              className={clsx({ [classes.active]: editorState?.isAlignRight })}
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

      <Modal.Root opened={opened} onClose={handleClose} fullScreen closeOnEscape={false}>
        <Modal.Overlay />
        <Modal.Content style={{ overflow: "hidden" }}>
          <Modal.Body pos="relative">
            <LoadingOverlay visible={isSaving} />
            <div style={{ height: "100vh" }}>
              <DrawIoEmbed
                ref={drawioRef}
                xml={initialXML}
                baseUrl={getDrawioUrl()}
                autosave
                urlParameters={{
                  ui: computedColorScheme === "light" ? "kennedy" : "dark",
                  spin: true,
                  libraries: true,
                  saveAndExit: true,
                  noSaveBtn: true,
                }}
                onSave={(data: EventSave) => {
                  if (data.parentEvent !== "save") {
                    return;
                  }
                  // Close only on success — a failed save must keep the
                  // modal, and the drawing in it, rather than discarding both.
                  saveData(data.xml)
                    .then(() => close())
                    .catch(notifySaveFailed);
                }}
                onClose={(data: EventExit) => {
                  if (data.parentEvent) {
                    return;
                  }
                  handleClose();
                }}
                onAutoSave={() => {
                  isDirtyRef.current = true;
                }}
                onExport={(data: EventExport) => {
                  // Reached by the 60 s autosave interval above.
                  saveData(data.data).catch(notifyAutosaveFailed);
                }}
              />
            </div>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}

export default DrawioMenu;
