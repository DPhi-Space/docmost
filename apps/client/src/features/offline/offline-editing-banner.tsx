/**
 * What phase 2 tells the user about the page they are editing.
 *
 * Three mutually exclusive states, most severe first. All of them are rendered
 * from `full-editor.tsx` rather than from `page-editor.tsx`, so the
 * collaboration-adjacent file carries no UI at all.
 *
 * Every state is also gated on the offline-editing switch: with the switch off
 * this component renders nothing, which is what "byte-identical to the base
 * release" has to mean visually as well as behaviourally.
 */

import { Alert } from "@mantine/core";
import {
  IconAlertTriangle,
  IconCloudOff,
  IconLockExclamation,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useOfflineEditingEnabled } from "./offline-editing-settings";
import { useOfflineEditState } from "./offline-edit-state";

export interface OfflineEditingBannerProps {
  pageId: string;
}

export function OfflineEditingBanner({ pageId }: OfflineEditingBannerProps) {
  const { t } = useTranslation();
  const enabled = useOfflineEditingEnabled();
  const { offlineEditingActive, unsyncedChangesWarning, unavailablePageId } =
    useOfflineEditState();

  if (!enabled) return null;

  // Authentication succeeded for a token that is *not* expired and the server
  // still refused: the page was hard-deleted, or access was revoked. Worth
  // saying before the softer "could not save" message, because reconnecting
  // will not fix it.
  if (unavailablePageId === pageId) {
    return (
      <Alert
        variant="light"
        color="red"
        icon={<IconLockExclamation size={18} />}
        role="alert"
        mb="md"
        title={t("This page is no longer available to you")}
      >
        {t(
          "It may have been deleted, or your access to it may have changed. Anything you type here cannot be saved. Copy your changes before leaving.",
        )}
      </Alert>
    );
  }

  // The connection is up and the handshake completed, yet the server has not
  // acknowledged our updates. See `unsynced-changes.ts`: read-only connections
  // are answered with `SyncStatus(false)` and the writes are discarded.
  if (unsyncedChangesWarning) {
    return (
      <Alert
        variant="light"
        color="orange"
        icon={<IconAlertTriangle size={18} />}
        role="alert"
        mb="md"
        title={t("Your changes could not be saved to the server")}
      >
        {t(
          "The page may be locked, or your access may have changed. Your edits are still here and on this device, but they are not saved to the server. Copy your changes before leaving.",
        )}
      </Alert>
    );
  }

  if (offlineEditingActive) {
    return (
      <Alert
        variant="light"
        color="gray"
        icon={<IconCloudOff size={18} />}
        role="status"
        mb="md"
      >
        {t(
          "Offline — changes are saved locally and will sync when you reconnect.",
        )}
      </Alert>
    );
  }

  return null;
}
