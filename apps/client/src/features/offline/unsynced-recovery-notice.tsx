/**
 * "Your session expired and some of your work is still only on this device."
 *
 * Rendered on the login page, which is where a 401 puts the user a fraction of
 * a second after `clearOfflineDataOnSessionExpiry()` decides to keep their
 * offline edits. Saying so matters as much as keeping them: a user who thinks
 * the work is gone may clear site data, switch browsers, or simply retype it —
 * and a user who is *not* told that unpushed work is sitting on a machine they
 * are walking away from has been told something less than the truth.
 *
 * It renders nothing in the overwhelmingly common case, where the session
 * expired with everything already pushed.
 */

import { Alert, List, Text } from "@mantine/core";
import { IconCloudUpload } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { readPendingRecovery } from "./session-expiry";

export function UnsyncedRecoveryNotice() {
  const { t } = useTranslation();
  // Read once, at render. The notice is written by a handler that immediately
  // navigates here, so it is already on disk before this component exists and
  // cannot change while the login page is open.
  const notice = readPendingRecovery();
  if (!notice) return null;

  return (
    <Alert
      variant="light"
      color="blue"
      icon={<IconCloudUpload size={18} />}
      role="status"
      mb="md"
      title={t("Unsent changes are still saved on this device")}
    >
      <Text size="sm">
        {t(
          "Your session ended before some changes reached the server. They have been kept on this device and will be sent automatically when you sign back in with the same account.",
        )}
      </Text>
      <List size="sm" mt="xs">
        {notice.pages.map((page) => (
          <List.Item key={page.pageId}>{page.title || t("Untitled")}</List.Item>
        ))}
      </List>
    </Alert>
  );
}
