import { Alert, Button, Divider } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useWorkspacePublicDataQuery } from "@/features/workspace/queries/workspace-query.ts";
import { getRedirectParam } from "@/lib/app-route.ts";

export const OIDC_LOGIN_PATH = "/api/oidc/login";

export function buildOidcLoginUrl(redirect: string | null): string {
  return redirect
    ? `${OIDC_LOGIN_PATH}?redirect=${encodeURIComponent(redirect)}`
    : OIDC_LOGIN_PATH;
}

export function OidcLoginButton() {
  const { t } = useTranslation();
  const { data } = useWorkspacePublicDataQuery();

  if (!data?.oidcEnabled) return null;

  const failed = new URLSearchParams(window.location.search).has("oidc_error");

  return (
    <>
      {failed && (
        <Alert color="red" mb="md">
          {t(
            "SSO sign-in failed. Contact your administrator if this persists.",
          )}
        </Alert>
      )}

      <Button
        onClick={() =>
          window.location.assign(buildOidcLoginUrl(getRedirectParam()))
        }
        leftSection={<IconLock size={16} />}
        variant="default"
        fullWidth
      >
        {t("Sign in with SSO")}
      </Button>

      {!data.enforceSso && (
        <Divider my="xs" label={t("OR")} labelPosition="center" />
      )}
    </>
  );
}
