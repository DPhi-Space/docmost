/**
 * The user-facing half of the offline-editing kill switch.
 *
 * Lives in `features/offline/` rather than alongside the other account
 * preferences because it is not an account preference: it is stored per
 * browser, in localStorage, and never reaches the server (see
 * `offline-editing-settings.ts`). Keeping it here also keeps the whole phase-2
 * delta in one directory.
 */

import { Switch, Text } from "@mantine/core";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";
import {
  requestDurableStorage,
  useDurableStorageVerdict,
} from "./durable-storage";
import {
  setOfflineEditingEnabled,
  useOfflineEditingEnabled,
} from "./offline-editing-settings";

export default function OfflineEditingPref() {
  const { t } = useTranslation();

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Edit pages offline")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Keep editing pages you have already opened on this device when there is no connection. Changes are saved locally and merge with the server when you reconnect. Page titles still need a connection.",
          )}
        </Text>
        <DurableStorageNote />
      </ResponsiveSettingsContent>

      <ResponsiveSettingsControl>
        <OfflineEditingToggle />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}

export function OfflineEditingToggle() {
  const { t } = useTranslation();
  // Read through the subscription rather than local state: the setting is
  // shared with the editor and with other tabs, and a copy would drift.
  const checked = useOfflineEditingEnabled();

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = event.currentTarget.checked;
    setOfflineEditingEnabled(enabled);
    // Turning the feature on is the moment the disk starts holding the only
    // copy of work, so it is the moment to ask the browser not to evict it.
    // Never called with the switch off — Firefox shows a permission prompt —
    // and the module itself enforces that gate too (durable-storage.ts).
    if (enabled) void requestDurableStorage();
  };

  return (
    <Switch
      labelPosition="left"
      checked={checked}
      onChange={handleChange}
      aria-label={t("Toggle offline page editing")}
    />
  );
}

/**
 * The quiet denial note. Advisory only: the feature works the same on
 * best-effort storage — the browser is just allowed to evict it under disk
 * pressure — and a denial is worth a sentence here, not a modal.
 */
function DurableStorageNote() {
  const { t } = useTranslation();
  const enabled = useOfflineEditingEnabled();
  const verdict = useDurableStorageVerdict();

  if (!enabled || verdict !== "denied") return null;

  return (
    <Text size="xs" c="dimmed">
      {t(
        "Your browser declined persistent storage, so offline changes could be evicted if the device runs low on disk space.",
      )}
    </Text>
  );
}
