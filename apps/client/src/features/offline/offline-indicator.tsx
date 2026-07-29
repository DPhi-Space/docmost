/**
 * The one piece of UI phase 1b adds: a quiet pill that explains why the app is
 * showing content it cannot refresh.
 *
 * Deliberately separate from the collaboration `ConnectionWarning`
 * (`features/page/components/header/page-header-menu.tsx`). That one reports the
 * state of a page's Yjs connection and is about *editing*; this one reports the
 * browser's connectivity and is about *the whole app*. Merging them would couple
 * offline mode to the collaboration code the fork keeps untouched.
 *
 * Phase 3 extends it, as #20 asks, rather than adding a second mount point:
 * this component is already rendered once per authenticated session by
 * `layout.tsx`, so hosting background sync's own status here — and the manager
 * that produces it — costs the fork **zero further diff to upstream files**.
 */

import { Group, Paper, Text, Transition } from "@mantine/core";
import { IconWifiOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useCollabConnectionWatch } from "./collab-connection-watch";
import { useOnlineStatus } from "./online-state";
import { ResyncIndicator, ResyncManagerHost } from "./resync-indicator";
import classes from "./offline-indicator.module.css";

export function OfflineIndicator() {
  const { t } = useTranslation();
  const isOnline = useOnlineStatus();
  // Feeds the collaboration socket's own view of the network into the
  // reachability verdict this pill renders. Hosted here because this component is
  // already mounted once per authenticated session, so no collaboration file
  // gains a line (`collab-connection-watch.ts`).
  useCollabConnectionWatch();

  return (
    <>
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
      <ResyncManagerHost />
      <ResyncIndicator />
    </>
  );
}
