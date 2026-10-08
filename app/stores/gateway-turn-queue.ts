import { useGatewayThreadTurnsStore } from "@/stores/gateway-thread-turns";
import { defineStore } from "pinia";
import { ref } from "vue";
import type { QueuedTurn } from "~~/shared/types/turn-queue";
import type {
  ComposerTurnOptions,
  RealtimeClientMessage,
  RealtimeServerMessage,
} from "~~/shared/types";
import { useGatewayRealtimeStore } from "@/stores/gateway-realtime";
import { createClientUserMessageId } from "@/stores/gateway/thread-turns/turn-content";

export const useGatewayTurnQueueStore = defineStore("gateway-turn-queue", () => {
  const queues = ref<Record<string, QueuedTurn[]>>({});
  function receive(message: Extract<RealtimeServerMessage, { type: "turn.queue.snapshot" }>) {
    queues.value[`${message.hostId}:${message.threadId}`] = message.entries;
    if (message.entries.some((entry) => entry.status === "sending")) {
      // This turn is owned by the server queue, not a previous browser-side retry request.
      useGatewayThreadTurnsStore().clearRequest(message.hostId, message.threadId);
    }
  }
  function resetState() {
    queues.value = {};
  }
  async function action(
    input: Omit<Extract<RealtimeClientMessage, { type: "turn.queue" }>, "type" | "requestId">,
  ) {
    const response = await useGatewayRealtimeStore().request(
      (requestId) => ({ type: "turn.queue", requestId, ...input }),
      { errorMode: "notify" },
    );
    if (response.type !== "turn.queue.snapshot") throw new Error("Unexpected queue response");
    return response;
  }
  async function enqueue(
    hostId: number,
    threadId: string,
    projectId: number,
    text: string,
    options: ComposerTurnOptions,
    insertIntoTurnId?: string | null,
  ) {
    const id = createClientUserMessageId("turn");
    const queued = await action({
      hostId,
      threadId,
      action: "enqueue",
      input: {
        ...options,
        hostId,
        threadId,
        projectId,
        text,
        clientUserMessageId: id,
      },
    });
    if (insertIntoTurnId !== null && insertIntoTurnId !== undefined && insertIntoTurnId !== "") {
      try {
        return await action({
          hostId,
          threadId,
          action: "insert",
          id,
          expectedTurnId: insertIntoTurnId,
        });
      } catch {
        // The input was durably queued even if insertion failed. Clear the accepted draft so a
        // retry cannot enqueue another copy; the shared handler reports the insertion error.
      }
    }
    return queued;
  }
  return { queues, receive, resetState, action, enqueue };
});
