/**
 * The one piece of UI phase 1b adds: a quiet pill that explains why the app is
 * showing content it cannot refresh.
 *
 * Deliberately separate from the collaboration `ConnectionWarning`
 * (`features/page/components/header/page-header-menu.tsx`). That one reports the
 * state of a page's Yjs connection and is about *editing*; this one reports the
 * browser's connectivity and is about *the whole app*. Merging them would couple
 * offline mode to the collaboration code the fork keeps untouched.
 */

import { Group, Paper, Text, Transition } from "@mantine/core";
import { IconWifiOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useOnlineStatus } from "./use-online-status";
import classes from "./offline-indicator.module.css";

export function OfflineIndicator() {
  const { t } = useTranslation();
  const isOnline = useOnlineStatus();

  return (
    <Transition mounted={!isOnline} transition="slide-up" duration={150}>
      {(style) => (
        <Paper
          className={classes.pill}
          style={style}
          radius="xl"
          shadow="sm"
          role="status"
          aria-live="polite"
        >
          <Group gap={8} wrap="nowrap">
            <IconWifiOff size={16} stroke={1.5} />
            <Text size="sm" c="dimmed">
              {t("Offline — showing saved content")}
            </Text>
          </Group>
        </Paper>
      )}
    </Transition>
  );
}
