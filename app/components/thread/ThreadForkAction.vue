<script setup lang="ts">
import { computed } from "vue";
import { GitBranchIcon, Loader2Icon } from "@lucide/vue";
import { Button } from "@codex-gateway/ui/button";
import { useGatewayThreadForkStore } from "@/stores/gateway-thread-fork";

const props = defineProps<{ hostId: number; threadId: string; turnId: string }>();
const forks = useGatewayThreadForkStore();
const { t } = useI18n();
const operation = computed(() => forks.operationFor(props.hostId, props.threadId, props.turnId));
const pending = computed(() => forks.isPending(props.hostId, props.threadId, props.turnId));
const buttonLabel = computed(() => {
  if (pending.value) {
    if (operation.value?.status === "created") return t("app.forkOpening");
    if (operation.value?.status === "outcome-unknown") return t("app.forkChecking");
    return t("app.forkCreating");
  }
  if (operation.value?.status === "created") return t("app.forkOpenBranch");
  if (operation.value?.status === "creating" || operation.value?.status === "outcome-unknown")
    return t("app.forkCheckResult");
  if (operation.value?.status === "failed") return t("app.forkRetry");
  return t("app.forkFromHere");
});

async function activate(newBranch = false) {
  if (pending.value) return;
  try {
    if (!newBranch && operation.value !== null && operation.value.status !== "failed") {
      await forks.resumeOperation(props.hostId, props.threadId, props.turnId);
    } else {
      await forks.forkThread(props.hostId, props.threadId, props.turnId, { newBranch });
    }
  } catch {
    // The store reports failures through the shared notification channel and retains recovery state.
  }
}
</script>

<template>
  <div
    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted"
    data-testid="thread-fork-action"
    :data-turn-id="turnId"
    :data-fork-status="operation?.status ?? 'ready'"
    :aria-busy="pending"
  >
    <Button
      :data-testid="`thread-fork-${turnId}`"
      variant="ghost"
      size="sm"
      class="h-auto min-h-8 max-w-full gap-1.5 whitespace-normal text-ink-muted hover:text-ink"
      :title="t('app.forkFilesHint')"
      :disabled="pending"
      @click="activate()"
    >
      <Loader2Icon v-if="pending" class="size-3.5 shrink-0 animate-spin" />
      <GitBranchIcon v-else class="size-3.5 shrink-0" />
      {{ buttonLabel }}
    </Button>
    <Button
      v-if="operation?.status === 'created'"
      data-testid="thread-fork-another"
      variant="ghost"
      size="sm"
      class="h-auto min-h-8 max-w-full whitespace-normal text-ink-muted hover:text-ink"
      :disabled="pending"
      @click="activate(true)"
    >
      {{ t("app.forkAnotherBranch") }}
    </Button>
    <p v-if="operation?.status === 'outcome-unknown'" role="status" class="basis-full break-words">
      {{ t("app.forkOutcomeUnknown") }}
    </p>
    <p v-else-if="operation?.status === 'creating' && !pending" role="status" class="basis-full">
      {{ t("app.forkStillCreating") }}
    </p>
  </div>
</template>
