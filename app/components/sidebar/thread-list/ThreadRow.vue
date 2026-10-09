<script setup lang="ts">
import { CopyIcon, StarIcon } from "@lucide/vue";
import { computed, toRef } from "vue";
import { Button } from "@codex-gateway/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@codex-gateway/ui/context-menu";
import type { ThreadRuntimeStatus } from "@/stores/gateway/types";
import { titleForThread } from "@/stores/gateway/thread-utils/identity";
import { useCopySessionPath } from "@/composables/thread/useCopySessionPath";
import { selectedRowClass } from "../sidebar-utils";
import SidebarRowLabel from "../SidebarRowLabel.vue";
import ThreadStatusIndicator from "./ThreadStatusIndicator.vue";
import type { SidebarThreadRow } from "../sidebar-types";
import type { LongPressContextMenuHandlers } from "@/composables/interactions/useLongPressContextMenu";

const props = defineProps<{
  thread: SidebarThreadRow;
  testId: string;
  selected: boolean;
  status: ThreadRuntimeStatus;
  completionAttention?: boolean;
  subtitle?: string;
  pinLabel: string;
  showPinnedIcon?: boolean;
  workspaceName?: string | null;
  longPressHandlers?: LongPressContextMenuHandlers;
}>();

const emit = defineEmits<{
  open: [];
  togglePin: [];
  rename: [];
}>();

const pressHandlers = computed(() => props.longPressHandlers ?? {});
const sessionName = computed(() => titleForThread(props.thread));
const { copySessionPath } = useCopySessionPath({
  workspaceName: toRef(props, "workspaceName"),
  sessionName,
});
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <Button
        :data-testid="testId"
        v-bind="pressHandlers"
        :data-selected="selected ? 'true' : 'false'"
        variant="ghost"
        class="h-auto min-h-9 w-full min-w-0 justify-start overflow-hidden rounded-lg px-3 py-2 text-sm font-normal hover:bg-surface"
        :class="selectedRowClass(selected)"
        @click="emit('open')"
      >
        <SidebarRowLabel :title="titleForThread(thread)" :subtitle="subtitle">
          <template #title-prefix>
            <StarIcon
              v-if="showPinnedIcon"
              class="size-3.5 shrink-0 fill-current text-accent-orange"
            />
          </template>
          <template #trailing>
            <ThreadStatusIndicator :status="status" :completion-attention="completionAttention" />
          </template>
        </SidebarRowLabel>
      </Button>
    </ContextMenuTrigger>
    <ContextMenuContent :collision-padding="12" prioritize-position class="w-40">
      <ContextMenuItem @select="emit('togglePin')">
        {{ pinLabel }}
      </ContextMenuItem>
      <ContextMenuItem @select="emit('rename')">
        {{ $t("app.renameThread") }}
      </ContextMenuItem>
      <ContextMenuItem
        v-if="props.workspaceName"
        data-testid="copy-session-path-menu-item"
        @select="copySessionPath"
      >
        <CopyIcon class="mr-2 size-4" />
        {{ $t("app.copySessionPath") }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
