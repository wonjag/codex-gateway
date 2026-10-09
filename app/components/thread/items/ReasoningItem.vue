<script setup lang="ts">
import type { ThreadHistoryItem } from "~~/shared/types";
import { BrainIcon, ChevronDownIcon, ChevronRightIcon } from "@lucide/vue";
import { computed, watch } from "vue";
import { Loader } from "@codex-gateway/ai-elements/loader";
import { Collapsible, CollapsibleTrigger } from "@codex-gateway/ui/collapsible";
import MarkdownContent from "@/components/common/MarkdownContent.vue";
import DeferredCollapsibleContent from "@/components/common/DeferredCollapsibleContent.vue";
import { ChatStickToBottomScrollArea } from "@/components/common/chat-virtualizer";
import { isItemInProgress, threadItemText } from "@/utils/thread-items";
import { formatDurationMs, itemCompletedAtMs, itemStartedAtMs } from "@/utils/item-timing";
import { usePausableTimestamp } from "@/composables/usePausableTimestamp";

const props = defineProps<{ item: ThreadHistoryItem; turnTerminal?: boolean }>();
const { t } = useI18n();
const { timestamp: now, pause, resume } = usePausableTimestamp(100);
const text = computed(() => threadItemText(props.item));
const startedAt = computed(() => itemStartedAtMs(props.item));
const completedAt = computed(() => itemCompletedAtMs(props.item));
// A terminal Turn is authoritative even if its last reasoning item missed completion.
// Keep this presentation guard local: compaction and sleep may legitimately outlive a Turn.
const inProgress = computed(
  () => !props.turnTerminal && completedAt.value === null && isItemInProgress(props.item),
);
const elapsedMs = computed(() => {
  if (startedAt.value === null) return null;
  const end = inProgress.value ? now.value : completedAt.value;
  // Missing item timing must not turn page-open time or Turn duration into reasoning duration.
  return end === null ? null : end - startedAt.value;
});
const timeLabel = computed(() =>
  elapsedMs.value === null ? null : formatDurationMs(elapsedMs.value),
);

watch(inProgress, (active) => (active ? resume() : pause()), { immediate: true });
</script>

<template>
  <Collapsible
    :default-open="true"
    v-slot="{ open }"
    data-testid="reasoning-item"
    :data-item-id="item.id"
    :data-reasoning-state="inProgress ? 'running' : 'idle'"
    class="max-w-4xl text-[0.9375rem] leading-7 text-ink-muted"
  >
    <CollapsibleTrigger
      class="flex w-full items-center gap-2 rounded-md py-1 text-left text-xs hover:bg-canvas-soft"
    >
      <Loader
        v-if="inProgress"
        data-testid="reasoning-spinner"
        class="size-4 shrink-0 text-primary"
        :aria-label="t('app.running')"
      />
      <BrainIcon v-else class="size-4 shrink-0" />
      <span class="flex-1">{{ t(inProgress ? "app.thinking" : "app.reasoningRecord") }}</span>
      <span
        v-if="timeLabel !== null"
        data-testid="reasoning-duration"
        class="rounded-full bg-surface/80 px-2 py-0.5 font-mono text-[0.6875rem] text-ink-secondary"
        >{{ timeLabel }}</span
      >
      <span class="rounded-full p-0.5">
        <ChevronDownIcon v-if="open" class="size-4 shrink-0 text-ink-faint" />
        <ChevronRightIcon v-else class="size-4 shrink-0 text-ink-faint" />
      </span>
    </CollapsibleTrigger>
    <!-- Keep long reasoning out of the DOM while collapsed, just like command output. Reasoning is
         prose, however, so it uses the page background and normal Markdown wrapping rather than
         the horizontally scrollable terminal treatment. Only its vertical growth is bounded. -->
    <DeferredCollapsibleContent :open="open">
      <ChatStickToBottomScrollArea
        v-if="text"
        class="mt-1 max-h-56"
        viewport-class="max-h-56"
        content-class="min-w-0 [overflow-wrap:anywhere]"
        :threshold="48"
        :follow-key="text.length"
      >
        <MarkdownContent
          :content="text"
          :streaming="inProgress"
          compact
          data-testid="reasoning-summary-content"
        />
      </ChatStickToBottomScrollArea>
    </DeferredCollapsibleContent>
  </Collapsible>
</template>
