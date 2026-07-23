import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { IconExternalLink, IconLock } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getPageIcon } from "@/lib";
import CopyTextButton from "@/components/common/copy";
import { getAppUrl, isCloud } from "@/lib/config";
import { buildPageUrl } from "@/features/page/page.utils";
import {
  useCreateShareMutation,
  useDeleteShareMutation,
  useShareForPageQuery,
  useUpdateShareMutation,
} from "@/features/share/queries/share-query";
import useTrial from "@/ee/hooks/use-trial";
import type { TFunction } from "i18next";

// Keep in sync with the backend share-slug validation
// (apps/server/src/core/share/dto/share.dto.ts + share-slug.validator.ts).
const SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const NANOID_KEY_SHAPE = /^[0-9a-z]{10}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateSlug(value: string, t: TFunction): string | null {
  const v = value.trim();
  if (v.length === 0) return null; // empty clears the slug
  if (v.length < 2) return t("Slug must be at least 2 characters");
  if (v.length > 100) return t("Slug must be at most 100 characters");
  if (!SLUG_REGEX.test(v)) {
    return t(
      "Slug must start with a letter or number and may contain hyphens and underscores",
    );
  }
  if (UUID_REGEX.test(v) || NANOID_KEY_SHAPE.test(v.toLowerCase())) {
    return t("This slug format is not allowed");
  }
  return null;
}

type PublishTabProps = {
  pageId: string;
  readOnly?: boolean;
  isRestricted?: boolean;
  workspaceSharingDisabled?: boolean;
  spaceSharingDisabled?: boolean;
};

export function PublishTab({
  pageId,
  readOnly,
  isRestricted,
  workspaceSharingDisabled,
  spaceSharingDisabled,
}: PublishTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pageSlug, spaceSlug } = useParams();
  const { isTrial } = useTrial();

  const { data: share } = useShareForPageQuery(pageId);
  const createShareMutation = useCreateShareMutation();
  const updateShareMutation = useUpdateShareMutation();
  const deleteShareMutation = useDeleteShareMutation();

  const pageIsShared = share && share.level === 0;
  const isDescendantShared = share && share.level > 0;

  const publicIdentifier = share?.slug ?? share?.key;
  const publicLink = `${getAppUrl()}/share/${publicIdentifier}/p/${pageSlug}`;

  const [isPagePublic, setIsPagePublic] = useState<boolean>(false);
  const [slugInput, setSlugInput] = useState<string>("");
  const [slugError, setSlugError] = useState<string | null>(null);

  useEffect(() => {
    setIsPagePublic(!!share);
  }, [share, pageId]);

  useEffect(() => {
    setSlugInput(share?.slug ?? "");
    setSlugError(null);
  }, [share?.slug, share?.id]);

  const handleSlugSave = async () => {
    if (!share?.id) return;
    const value = slugInput.trim();
    const validationError = validateSlug(value, t);
    if (validationError) {
      setSlugError(validationError);
      return;
    }
    try {
      await updateShareMutation.mutateAsync({
        shareId: share.id,
        slug: value.length > 0 ? value : null,
      });
      setSlugError(null);
    } catch (err) {
      setSlugError(
        err?.["response"]?.data?.message ||
          t("This share slug is already in use"),
      );
    }
  };

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;

    if (value) {
      createShareMutation.mutateAsync({
        pageId: pageId,
        includeSubPages: true,
        searchIndexing: false,
      });
      setIsPagePublic(value);
    } else {
      if (share && share.id) {
        deleteShareMutation.mutateAsync(share.id);
        setIsPagePublic(value);
      }
    }
  };

  const handleSubPagesChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = event.currentTarget.checked;
    updateShareMutation.mutateAsync({
      shareId: share.id,
      includeSubPages: value,
    });
  };

  const handleIndexSearchChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = event.currentTarget.checked;
    updateShareMutation.mutateAsync({
      shareId: share.id,
      searchIndexing: value,
    });
  };

  const shareLink = useMemo(
    () => (
      <Group my="sm" gap={4} wrap="nowrap">
        <TextInput
          variant="filled"
          value={publicLink}
          readOnly
          rightSection={<CopyTextButton text={publicLink} />}
          style={{ width: "100%" }}
        />
        <ActionIcon
          component="a"
          variant="default"
          target="_blank"
          href={publicLink}
          size="sm"
        >
          <IconExternalLink size={16} />
        </ActionIcon>
      </Group>
    ),
    [publicLink],
  );

  if (isCloud() && isTrial) {
    return (
      <Stack align="center" py="md">
        <IconLock size={20} stroke={1.5} />
        <Text size="sm" ta="center" fw={500}>
          {t("Upgrade to share pages")}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {t(
            "Page sharing is available on paid plans. Upgrade to share your pages publicly.",
          )}
        </Text>
        <Button size="xs" onClick={() => navigate("/settings/billing")}>
          {t("Upgrade Plan")}
        </Button>
      </Stack>
    );
  }

  if (workspaceSharingDisabled || spaceSharingDisabled) {
    return (
      <Stack align="center" py="md">
        <IconLock size={20} stroke={1.5} />
        <Text size="sm" ta="center" fw={500}>
          {t("Public sharing is disabled")}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {workspaceSharingDisabled
            ? t("Public sharing has been disabled at the workspace level.")
            : t("Public sharing has been disabled for this space.")}
        </Text>
      </Stack>
    );
  }

  if (isRestricted) {
    return (
      <Stack align="center" py="md">
        <IconLock size={20} stroke={1.5} />
        <Text size="sm" ta="center" fw={500}>
          {t("Restricted page")}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {t("Restricted pages cannot be shared publicly.")}
        </Text>
      </Stack>
    );
  }

  if (isDescendantShared) {
    return (
      <Stack gap="sm">
        <Text size="sm">{t("Inherits public sharing from")}</Text>
        <Anchor
          size="sm"
          underline="never"
          style={{
            cursor: "pointer",
            color: "var(--mantine-color-text)",
          }}
          component={Link}
          to={buildPageUrl(
            spaceSlug,
            share.sharedPage.slugId,
            share.sharedPage.title,
          )}
        >
          <Group gap="4" wrap="nowrap">
            {getPageIcon(share.sharedPage.icon)}
            <Text fz="sm" fw={500} lineClamp={1}>
              {share.sharedPage.title || t("untitled")}
            </Text>
          </Group>
        </Anchor>
        {shareLink}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div>
          <Text size="sm">
            {isPagePublic ? t("Shared to web") : t("Share to web")}
          </Text>
          <Text size="xs" c="dimmed">
            {isPagePublic
              ? t("Anyone with the link can view this page")
              : t("Make this page publicly accessible")}
          </Text>
        </div>
        <Switch
          onChange={handleChange}
          checked={isPagePublic}
          disabled={readOnly}
          size="xs"
        />
      </Group>

      {pageIsShared && (
        <>
          {shareLink}
          <Group justify="space-between" wrap="nowrap" gap="xl">
            <div>
              <Text size="sm">{t("Include sub-pages")}</Text>
              <Text size="xs" c="dimmed">
                {t("Make sub-pages public too")}
              </Text>
            </div>
            <Switch
              onChange={handleSubPagesChange}
              checked={share.includeSubPages}
              size="xs"
              disabled={readOnly}
            />
          </Group>
          <Group justify="space-between" wrap="nowrap" gap="xl">
            <div>
              <Text size="sm">{t("Search engine indexing")}</Text>
              <Text size="xs" c="dimmed">
                {t("Allow search engines to index page")}
              </Text>
            </div>
            <Switch
              onChange={handleIndexSearchChange}
              checked={share.searchIndexing}
              size="xs"
              disabled={readOnly}
            />
          </Group>
          <Stack gap={4}>
            <div>
              <Text size="sm">{t("Custom link")}</Text>
              <Text size="xs" c="dimmed">
                {t("Use a memorable alias instead of the random link")}
              </Text>
            </div>
            <Group gap={4} wrap="nowrap" align="flex-start">
              <TextInput
                style={{ flex: 1 }}
                placeholder={share.key}
                value={slugInput}
                onChange={(event) => {
                  setSlugInput(event.currentTarget.value);
                  setSlugError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSlugSave();
                  }
                }}
                error={slugError}
                disabled={readOnly}
              />
              <Button
                variant="default"
                size="sm"
                onClick={handleSlugSave}
                loading={updateShareMutation.isPending}
                disabled={readOnly || slugInput.trim() === (share.slug ?? "")}
              >
                {t("Save")}
              </Button>
            </Group>
          </Stack>
        </>
      )}
    </Stack>
  );
}
