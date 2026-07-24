import { Button, Checkbox, Group, Modal, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface LockPageModalProps {
  opened: boolean;
  isLocked: boolean;
  onClose: () => void;
  onConfirm: (recursive: boolean) => void;
}

export default function LockPageModal({
  opened,
  isLocked,
  onClose,
  onConfirm,
}: LockPageModalProps) {
  const { t } = useTranslation();
  const [recursive, setRecursive] = useState(false);

  // The checkbox is a per-invocation choice, not a saved preference.
  useEffect(() => {
    if (opened) setRecursive(false);
  }, [opened]);

  const handleConfirm = () => {
    onConfirm(recursive);
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isLocked ? t("Unlock page") : t("Lock page")}
      size={450}
      padding="xl"
      closeButtonProps={{ "aria-label": t("Close") }}
      onClick={(e) => e.stopPropagation()}
    >
      <Text c="dimmed" size="sm">
        {isLocked
          ? t("Anyone with edit access will be able to edit this page again.")
          : t(
              "A locked page is read-only for everyone, including you, until it is unlocked.",
            )}
      </Text>

      <Checkbox
        mt="md"
        checked={recursive}
        onChange={(event) => setRecursive(event.currentTarget.checked)}
        label={t("Also apply to all sub-pages")}
      />

      <Group justify="end" mt="lg">
        <Button onClick={onClose} variant="default">
          {t("Cancel")}
        </Button>
        <Button onClick={handleConfirm}>
          {isLocked ? t("Unlock") : t("Lock")}
        </Button>
      </Group>
    </Modal>
  );
}
