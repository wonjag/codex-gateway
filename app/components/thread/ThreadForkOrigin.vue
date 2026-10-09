<script setup lang="ts">
import { computed } from "vue";
import { GitBranchIcon } from "@lucide/vue";
import { Button } from "@codex-gateway/ui/button";
import type { GatewayThread } from "~~/shared/types";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";

const props = defineProps<{ hostId: number | null; thread: GatewayThread | null }>();
const views = useGatewayThreadViewStore();
const sourceThreadId = computed(
  () => props.thread?.forkOrigin?.threadId ?? props.thread?.forkedFromId,
);
const sourceTurnId = computed(() => props.thread?.forkOrigin?.turnId ?? null);
const { t } = useI18n();

async function openSource() {
  if (props.hostId === null || !sourceThreadId.value) return;
  await views.openThread(sourceThreadId.value, { hostId: props.hostId });
}
</script>

<template>
  <div
    v-if="sourceThreadId"
    class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-canvas-soft/40 px-3 py-2 text-xs text-ink-muted"
    data-testid="thread-fork-origin"
    :data-fork-source-thread="sourceThreadId"
    :data-fork-source-turn="sourceTurnId"
  >
    <GitBranchIcon class="size-3.5 shrink-0" />
    <Button
      data-testid="thread-fork-source"
      variant="link"
      size="sm"
      class="h-auto min-h-6 max-w-full whitespace-normal p-0 text-xs"
      :title="sourceTurnId ? t('app.forkSourceTurn', { turnId: sourceTurnId }) : undefined"
      :disabled="hostId === null"
      @click="openSource"
    >
      {{ t(sourceTurnId ? "app.forkSourceHistory" : "app.forkSourceSession") }}
    </Button>
    <span class="min-w-0 break-words">{{ t("app.forkFilesHint") }}</span>
    <details class="basis-full">
      <summary class="w-fit cursor-pointer text-ink-faint">{{ t("app.forkUsageDetails") }}</summary>
      <p class="mt-1 break-words">{{ t("app.forkUsageHint") }}</p>
    </details>
  </div>
</template>
