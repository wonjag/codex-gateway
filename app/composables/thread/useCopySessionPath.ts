import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { toast } from "@codex-gateway/ui/sonner";
import { copyCodeBlockText } from "@/utils/copy-code-block";

export function useCopySessionPath(options: {
  workspaceName: MaybeRefOrGetter<string | null | undefined>;
  sessionName: MaybeRefOrGetter<string | null | undefined>;
}) {
  const { t } = useI18n();
  const sessionPath = computed(() => {
    const workspaceName = toValue(options.workspaceName)?.trim() ?? "";
    const sessionName = toValue(options.sessionName)?.trim() ?? "";
    if (workspaceName === "" || sessionName === "") return "";
    return `workspace中${workspaceName}名为${sessionName}的session`;
  });

  async function copySessionPath() {
    if (!sessionPath.value) {
      toast.error(t("app.copySessionPathFailed"));
      return false;
    }
    try {
      await copyCodeBlockText(sessionPath.value);
      toast.success(t("app.sessionPathCopied"));
      return true;
    } catch {
      toast.error(t("app.copySessionPathFailed"));
      return false;
    }
  }

  return { sessionPath, copySessionPath };
}
