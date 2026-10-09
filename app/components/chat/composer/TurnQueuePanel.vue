<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Button } from "@codex-gateway/ui/button";
import { Textarea } from "@codex-gateway/ui/textarea";
import { useGatewayTurnQueueStore } from "@/stores/gateway-turn-queue";
import { useGatewayThreadRuntimeStore } from "@/stores/gateway-thread-runtime";
import { gatewayDomainEvents } from "@/stores/gateway/domain-events";
import type { QueuePauseReason } from "~~/shared/types/turn-queue";

const props = defineProps<{ hostId: number; threadId: string }>();
const queue = useGatewayTurnQueueStore();
const runtime = useGatewayThreadRuntimeStore();
const entries = computed(() => queue.queues[`${props.hostId}:${props.threadId}`] ?? []);
const activeTurnId = computed(
  () => runtime.activeTurnIdsByThreadKey[`${props.hostId}:${props.threadId}`],
);
const editing = ref<string | null>(null);
const draft = ref("");
const pending = ref(false);
const pauseReasonKeys: Record<QueuePauseReason, string> = {
  workspace_mismatch: "app.queueWorkspaceMismatch",
  workspace_repaired: "app.queueWorkspaceRepaired",
  delivery_uncertain: "app.queueDeliveryUncertain",
  interrupted: "app.queueInterrupted",
  restarted: "app.queueRestarted",
  queue_blocked: "app.queueBlocked",
};
const workspaceMismatch = computed(() =>
  entries.value.some((entry) => entry.pauseReason === "workspace_mismatch"),
);
const canInsert = computed(
  () =>
    !pending.value &&
    Boolean(activeTurnId.value) &&
    entries.value.every((entry) => entry.status === "waiting"),
);
async function action(
  kind: "list" | "cancel" | "edit" | "resume" | "insert" | "repairWorkspace",
  id?: string,
) {
  if (pending.value && kind !== "list") return;
  const expectedTurnId = activeTurnId.value;
  if (
    kind === "insert" &&
    (!canInsert.value ||
      !expectedTurnId ||
      !entries.value.some((entry) => entry.id === id && entry.status === "waiting"))
  )
    return;
  pending.value = true;
  try {
    await queue.action({
      hostId: props.hostId,
      threadId: props.threadId,
      action: kind,
      id,
      ...(kind === "edit" ? { text: draft.value } : {}),
      ...(kind === "insert" ? { expectedTurnId } : {}),
    });
    if (kind === "edit") editing.value = null;
  } catch {
    /* Realtime request errors are displayed by the shared notification handler. */
  } finally {
    pending.value = false;
  }
}
watch(
  () => [props.hostId, props.threadId],
  () => {
    editing.value = null;
    void action("list");
  },
  { immediate: true },
);
const off = gatewayDomainEvents.on("realtime-reconnected", () => {
  void action("list");
});
onUnmounted(off);
</script>

<template>
  <section
    v-if="entries.length"
    class="mb-2 grid max-h-60 min-w-0 gap-2 overflow-auto rounded-lg border p-3 text-sm"
    data-testid="turn-queue"
  >
    <p class="font-medium">{{ $t("app.queuedMessages", { count: entries.length }) }}</p>
    <p class="text-muted-foreground">{{ $t("app.queueDeliveryHint") }}</p>
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="grid min-w-0 gap-1"
      :data-queue-status="entry.status"
      :data-queue-pause-reason="entry.pauseReason"
    >
      <p class="whitespace-pre-wrap break-words" :title="entry.text">{{ entry.text }}</p>
      <p v-if="entry.status === 'paused'" class="text-muted-foreground" role="status">
        {{
          $t(
            entry.pauseReason === "workspace_mismatch" && !entry.canRepairWorkspace
              ? "app.queueWorkspaceFilesNeedReview"
              : entry.pauseReason
                ? pauseReasonKeys[entry.pauseReason]
                : "app.queuePausedHint",
          )
        }}
      </p>
      <template v-if="editing === entry.id">
        <Textarea v-model="draft" :aria-label="$t('app.editQueuedMessage')" />
        <div class="flex gap-2">
          <Button
            size="sm"
            :disabled="pending || !draft.trim()"
            @click="action('edit', entry.id)"
            >{{ $t("app.save") }}</Button
          >
          <Button size="sm" variant="ghost" @click="editing = null">{{ $t("app.cancel") }}</Button>
        </div>
      </template>
      <div v-else class="flex flex-wrap gap-2">
        <span v-if="entry.status === 'sending'">{{ $t("app.queueSending") }}</span>
        <template v-else>
          <Button
            v-if="entry.canRepairWorkspace"
            size="sm"
            variant="outline"
            class="h-auto min-h-8 max-w-full whitespace-normal"
            data-testid="repair-queued-workspace"
            :disabled="pending"
            @click="action('repairWorkspace', entry.id)"
            >{{ $t("app.repairQueueWorkspace") }}</Button
          >
          <Button
            v-if="entry.status === 'waiting'"
            size="sm"
            variant="outline"
            class="h-auto min-h-8 max-w-full whitespace-normal"
            data-testid="insert-queued-message"
            :title="$t('app.queueDeliveryHint')"
            :disabled="!canInsert"
            @click="action('insert', entry.id)"
            >{{ $t("app.steerNow") }}</Button
          >
          <Button
            size="sm"
            variant="ghost"
            :disabled="pending"
            @click="
              editing = entry.id;
              draft = entry.text;
            "
            >{{ $t("app.editQueuedMessage") }}</Button
          >
          <Button
            size="sm"
            variant="ghost"
            :disabled="pending"
            @click="action('cancel', entry.id)"
            >{{ $t("app.removeQueuedMessage") }}</Button
          >
        </template>
      </div>
    </div>
    <Button
      v-if="entries.some((entry) => entry.status === 'paused')"
      size="sm"
      variant="outline"
      :disabled="pending || workspaceMismatch"
      @click="action('resume')"
      >{{ $t("app.resumeQueue") }}</Button
    >
  </section>
</template>
