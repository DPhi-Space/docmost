import { userAtom } from "@/features/user/atoms/current-user-atom";
import { updateUser } from "@/features/user/services/user-service";
import { Badge, Group, Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveSettingsRow,
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
} from "@/components/ui/responsive-settings-row";
import { isVimSupportedDevice } from "@/features/editor/extensions/vim-mode";

export default function VimModePref() {
  const { t } = useTranslation();
  const [user, setUser] = useAtom(userAtom);
  const [checked, setChecked] = useState(
    user.settings?.preferences?.vimMode ?? false,
  );
  const supported = isVimSupportedDevice();

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setChecked(value);
    try {
      const updatedUser = await updateUser({ vimMode: value });
      setUser(updatedUser);
    } catch {
      setChecked(!value);
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Group gap="xs">
          <Text size="md">{t("Vim keybindings")}</Text>
          <Badge size="xs" color="gray" variant="light">
            {t("Experimental")}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {t(
            "Modal editing in the page editor: normal, insert, visual and replace modes, with motions, operators and text objects.",
          )}
        </Text>
        {!supported && (
          <Text size="sm" c="dimmed">
            {t(
              "Not available on touch devices — on-screen keyboards do not report the key events modal editing needs.",
            )}
          </Text>
        )}
      </ResponsiveSettingsContent>

      <ResponsiveSettingsControl>
        <Switch
          labelPosition="left"
          defaultChecked={checked}
          onChange={handleChange}
          disabled={!supported}
          aria-label={t("Toggle vim keybindings")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
