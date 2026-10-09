import { defineStore, skipHydrate } from "pinia";
import { ref, watch } from "vue";
import { useAccountLocalStorage } from "@/composables/storage/useAccountLocalStorage";
import type { GatewayThread } from "~~/shared/types";
import type { GatewayRouteSelection } from "@/stores/gateway/route-state";
import { createThreadListActions } from "./actions/thread-list";
import { createThreadPinningActions } from "./actions/thread-pinning";

const emptySelection = (): GatewayRouteSelection => ({
  hostId: null,
  projectId: null,
  threadId: null,
});

export const useGatewayNavigationStore = defineStore("gateway-navigation", () => {
  const lastOpenThread = useAccountLocalStorage<GatewayRouteSelection>(
    "last-open-thread",
    emptySelection(),
  );
  const threads = ref<GatewayThread[]>([]);
  // The native thread/list cursor is scoped to the current host/project/search query.
  // Keep it beside the result so the project home can fetch older sessions without
  // replacing the rows already rendered.
  const threadListNextCursor = ref<string | null>(null);
  const threadListLoadingMore = ref(false);
  const threadListSearchTerm = ref("");
  const threadListSeenCursors = ref<string[]>([]);
  const selectedHostId = ref<number | null>(null);
  const selectedProjectId = ref<number | null>(null);
  const selectedThreadId = ref<string | null>(null);
  const openingPinnedThreadKey = ref<string | null>(null);
  // Clear the old project synchronously, including route restoration and rapid A/B/A switches.
  const listGeneration = ref(0);
  watch(
    [selectedHostId, selectedProjectId],
    () => {
      threads.value = [];
      threadListNextCursor.value = null;
      threadListLoadingMore.value = false;
      threadListSearchTerm.value = "";
      threadListSeenCursors.value = [];
      listGeneration.value += 1;
    },
    { flush: "sync" },
  );
  const actions = {
    ...createThreadListActions(),
    ...createThreadPinningActions(),
  };

  function rememberOpenThread(selection: GatewayRouteSelection) {
    lastOpenThread.value = { ...selection };
  }

  function resetState() {
    threads.value = [];
    threadListNextCursor.value = null;
    threadListLoadingMore.value = false;
    threadListSearchTerm.value = "";
    threadListSeenCursors.value = [];
    selectedHostId.value = null;
    selectedProjectId.value = null;
    selectedThreadId.value = null;
    openingPinnedThreadKey.value = null;
  }

  return {
    lastOpenThread: skipHydrate(lastOpenThread),
    threads,
    threadListNextCursor,
    threadListLoadingMore,
    threadListSearchTerm,
    threadListSeenCursors,
    listGeneration,
    selectedHostId,
    selectedProjectId,
    selectedThreadId,
    openingPinnedThreadKey,
    rememberOpenThread,
    resetState,
    ...actions,
  };
});
