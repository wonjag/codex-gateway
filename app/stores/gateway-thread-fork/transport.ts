import type { RealtimeServerMessage } from "~~/shared/types";
import type { ThreadForkReference } from "~~/shared/types/thread-fork";
import { useGatewayRealtimeStore } from "@/stores/gateway-realtime";

function parseForkResult(message: RealtimeServerMessage) {
  if (message.type !== "thread.fork.result") throw new Error("Unexpected fork response");
  return message.operation;
}

export function requestThreadFork(reference: ThreadForkReference) {
  return useGatewayRealtimeStore().request(
    (requestId) => ({
      type: "thread.fork",
      requestId,
      hostId: reference.hostId,
      threadId: reference.sourceThreadId,
      lastTurnId: reference.lastTurnId,
      operationId: reference.operationId,
    }),
    parseForkResult,
    { timeoutMs: 150_000 },
  );
}

export function requestThreadForkStatus(reference: ThreadForkReference) {
  return useGatewayRealtimeStore().request(
    (requestId) => ({
      type: "thread.fork.status",
      requestId,
      hostId: reference.hostId,
      operationId: reference.operationId,
    }),
    parseForkResult,
    { timeoutMs: 20_000 },
  );
}
