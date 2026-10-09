<script setup lang="ts">
import ThreadRow from "./ThreadRow.vue";
import { formatRelative, pinnedThreadId, pinnedThreadKey } from "../sidebar-utils";
import type { HostRecord, PinnedThreadRecord } from "../sidebar-types";
import type { ThreadRuntimeStatus } from "@/stores/gateway/types";
import type { LongPressContextMenuHandlers } from "@/composables/interactions/useLongPressContextMenu";

const props = defineProps<{
  threads: PinnedThreadRecord[];
  hosts: HostRecord[];
  selectedHostId: number | null;
  selectedThreadId: string | null;
  longPressHandlers?: LongPressContextMenuHandlers;
  runtimeStatus: (thread: PinnedThreadRecord) => ThreadRuntimeStatus;
  completionAttention: (thread: PinnedThreadRecord) => boolean;
}>();

const emit = defineEmits<{
  open: [thread: PinnedThreadRecord];
  unpin: [thread: PinnedThreadRecord];
  rename: [thread: PinnedThreadRecord];
}>();

function subtitleForPinnedThread(thread: PinnedThreadRecord) {
  const hostName = props.hosts.find((host) => host.id === thread.hostId)?.name;
  return [hostName, thread.projectName].filter(Boolean).join(" / ");
}

function isSelectedPinnedThread(thread: PinnedThreadRecord) {
  return (
    pinnedThreadId(thread) === String(props.selectedThreadId) &&
    thread.hostId === props.selectedHostId
  );
}
</script>

<template>
  <section class="flex min-w-0 max-w-full flex-col overflow-hidden">
    <div class="flex h-8 items-center justify-between gap-2 px-2 pb-2 text-sm text-ink-muted">
      <span>{{ $t("app.pinned") }}</span>
      <slot name="header-action" />
    </div>
    <div v-if="threads.length" class="space-y-1">
      <ThreadRow
        v-for="thread in threads"
        :key="pinnedThreadKey(thread)"
        :thread="thread"
        :test-id="`pinned-thread-button-${pinnedThreadId(thread)}`"
        :selected="isSelectedPinnedThread(thread)"
        :status="runtimeStatus(thread)"
        :completion-attention="completionAttention(thread)"
        :subtitle="subtitleForPinnedThread(thread) || formatRelative(thread.updatedAt)"
        :workspace-name="thread.projectName"
        :pin-label="$t('app.unpinThread')"
        :long-press-handlers="longPressHandlers"
        show-pinned-icon
        @open="emit('open', thread)"
        @toggle-pin="emit('unpin', thread)"
        @rename="emit('rename', thread)"
      />
    </div>
  </section>
</template>
