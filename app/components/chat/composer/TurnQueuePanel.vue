<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Button } from "@codex-gateway/ui/button";
import { Textarea } from "@codex-gateway/ui/textarea";
import { useGatewayTurnQueueStore } from "@/stores/gateway-turn-queue";
import { gatewayDomainEvents } from "@/stores/gateway/domain-events";

const props = defineProps<{ hostId: number; threadId: string }>();
const queue = useGatewayTurnQueueStore();
const entries = computed(() => queue.queues[`${props.hostId}:${props.threadId}`] ?? []);
const editing = ref<string | null>(null);
const draft = ref("");
const pending = ref(false);
async function action(kind: "list" | "cancel" | "edit" | "resume", id?: string) {
  if (pending.value && kind !== "list") return;
  pending.value = true;
  try {
    await queue.action({
      hostId: props.hostId,
      threadId: props.threadId,
      action: kind,
      id,
      ...(kind === "edit" ? { text: draft.value } : {}),
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
    class="mb-2 grid max-h-60 gap-2 overflow-auto rounded-lg border p-3 text-sm"
    data-testid="turn-queue"
  >
    <p class="font-medium">{{ $t("app.queuedMessages", { count: entries.length }) }}</p>
    <p v-if="entries.some((entry) => entry.status === 'paused')" class="text-muted-foreground">
      {{ $t("app.queuePausedHint") }}
    </p>
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="grid gap-1"
      :data-queue-status="entry.status"
    >
      <p class="whitespace-pre-wrap break-words" :title="entry.text">{{ entry.text }}</p>
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
      :disabled="pending"
      @click="action('resume')"
      >{{ $t("app.resumeQueue") }}</Button
    >
  </section>
</template>
