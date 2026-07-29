import { LoginForm } from "@/features/auth/components/login-form";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { UnsyncedRecoveryNotice } from "@/features/offline/unsynced-recovery-notice";

export default function LoginPage() {
  const { t } = useTranslation();

  return (
    <>
      <DocumentTitle title={t("Login")} />
      <UnsyncedRecoveryNotice />
      <LoginForm />
    </>
  );
}
