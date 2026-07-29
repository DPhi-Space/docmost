import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import i18n from "@/i18n";

export const SW_UPDATE_NOTIFICATION_ID = "docmost-sw-update";

/**
 * Persistent, user-driven update prompt. Deliberately not auto-closing and
 * deliberately not automatic: activating a new worker reloads the tab, and the
 * user is the only one who knows whether that is safe right now.
 */
export function showUpdateNotification(options: {
  onReload: () => void;
  onDismiss: () => void;
}) {
  notifications.show({
    id: SW_UPDATE_NOTIFICATION_ID,
    title: i18n.t("A new version is available"),
    message: (
      <Group justify="space-between" wrap="nowrap" gap="sm" mt={4}>
        <Text size="sm" c="dimmed">
          {i18n.t("Reload to get the latest version.")}
        </Text>
        <Button size="compact-sm" variant="light" onClick={options.onReload}>
          {i18n.t("Reload")}
        </Button>
      </Group>
    ),
    autoClose: false,
    withCloseButton: true,
    onClose: options.onDismiss,
  });
}

export function hideUpdateNotification() {
  notifications.hide(SW_UPDATE_NOTIFICATION_ID);
}
