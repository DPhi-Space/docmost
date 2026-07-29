/**
 * What background sync looks like: a progress pill, a success toast, and a
 * standing list of what could not be pushed.
 *
 * The third one is the part that matters. A page the server refused holds work
 * that exists **only on this device**, and nothing else in the product will
 * ever mention it — the user is not on that page, and may never go back to it.
 * So the affordance is persistent rather than a notification: it stays until
 * the page syncs or the user acts on it, and it links straight to the page,
 * where phase 2's warning banner explains the same thing in context.
 *
 * Rendered from `OfflineIndicator`, which `Layout` already mounts, so phase 3
 * adds no diff to any upstream file. This component also owns the manager's
 * lifetime (`use-offline-resync.ts`).
 */

import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Anchor,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockedReason, DirtyPageRecord } from "./dirty-pages";
import { dirtyPageHref } from "./dirty-page-link";
import { useOfflineEditingEnabled } from "./offline-editing-settings";
import { useOnlineStatus } from "./online-state";
import { useResyncState } from "./resync-state";
import { useOfflineResync } from "./use-offline-resync";
import classes from "./resync-indicator.module.css";

export function ResyncIndicator() {
  const { t } = useTranslation();
  const enabled = useOfflineEditingEnabled();
  const isOnline = useOnlineStatus();
  const { phase, total, completed, blocked, lastPass } = useResyncState();
  const [reviewOpen, { open: openReview, close: closeReview }] =
    useDisclosure(false);

  // One toast per pass. `lastPass` changes identity exactly once per pass, so
  // the effect cannot re-fire on an unrelated re-render.
  const toastedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!lastPass || lastPass.synced === 0) return;
    if (toastedRef.current === lastPass.at) return;
    toastedRef.current = lastPass.at;
    notifications.show({
      color: "green",
      message: t("Offline changes synced ({{count}} pages)", {
        count: lastPass.synced,
      }),
    });
  }, [lastPass, t]);

  if (!enabled) return null;

  const stacked = !isOnline ? classes.stacked : undefined;

  if (phase === "syncing") {
    return (
      <Paper
        className={`${classes.pill} ${stacked ?? ""}`}
        radius="xl"
        shadow="sm"
        role="status"
        aria-live="polite"
      >
        <Group gap={8} wrap="nowrap">
          <Loader size={14} />
          <Text size="sm" c="dimmed">
            {t("Syncing offline changes ({{completed}}/{{total}})…", {
              completed,
              total,
            })}
          </Text>
        </Group>
      </Paper>
    );
  }

  if (blocked.length === 0) return null;

  return (
    <>
      <Paper
        className={`${classes.pill} ${stacked ?? ""}`}
        radius="xl"
        shadow="sm"
        role="status"
      >
        <UnstyledButton
          className={classes.reviewButton}
          onClick={openReview}
          aria-label={t("Review pages that could not sync")}
        >
          <Group gap={8} wrap="nowrap">
            <IconAlertTriangle size={16} stroke={1.5} color="orange" />
            <Text size="sm" c="dimmed">
              {t("{{count}} pages could not sync — review", {
                count: blocked.length,
              })}
            </Text>
          </Group>
        </UnstyledButton>
      </Paper>

      <Modal
        opened={reviewOpen}
        onClose={closeReview}
        title={t("Pages that could not sync")}
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t(
              "These pages hold changes that are saved on this device but that the server would not accept. Nothing has been discarded — open a page to see and copy its changes.",
            )}
          </Text>
          <List spacing="xs">
            {blocked.map((record) => (
              <List.Item key={record.pageId}>
                <BlockedPageRow record={record} onNavigate={closeReview} />
              </List.Item>
            ))}
          </List>
        </Stack>
      </Modal>
    </>
  );
}

function BlockedPageRow({
  record,
  onNavigate,
}: {
  record: DirtyPageRecord;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={2}>
      <Anchor
        component={Link}
        to={dirtyPageHref(record)}
        onClick={onNavigate}
        size="sm"
      >
        {record.link?.title || t("Untitled")}
      </Anchor>
      <Text size="xs" c="dimmed">
        {blockedReasonText(record.blocked?.reason, t)}
      </Text>
    </Stack>
  );
}

function blockedReasonText(
  reason: BlockedReason | undefined,
  t: (key: string) => string,
): string {
  switch (reason) {
    case "no-access":
      return t(
        "The page is no longer available to you — it may have been deleted, or your access removed.",
      );
    case "not-accepted":
      return t(
        "The server did not accept the changes — the page may be locked, in the trash, or read-only for you.",
      );
    default:
      return t("The changes could not be saved to the server.");
  }
}

/**
 * Started even when nothing is on screen: the manager has to run in a session
 * that has no blocked pages and no sync in progress, which is most of them.
 * Kept as a separate zero-render component so the hook's lifetime is the
 * session's rather than the pill's.
 */
export function ResyncManagerHost() {
  const enabled = useOfflineEditingEnabled();
  useOfflineResync(enabled);
  return null;
}
