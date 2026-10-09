import type { RealtimeClientMessage } from "~~/shared/types";
import { requireRecord } from "../../http/validation/common";
import { threadForkSchema, threadForkStatusSchema } from "../../http/validation/threads";
import { threadBroker } from "../../runtime/broker";
import { hostStore } from "../../state/hosts";
import { sendRealtimePeerMessage, type RealtimePeer } from "../peer-state";

export async function forkThread(
  peer: RealtimePeer,
  message: Extract<RealtimeClientMessage, { type: "thread.fork" }>,
) {
  const input = threadForkSchema.parse(message);
  const host = requireRecord(hostStore.getWithSecret(input.hostId), "Host not found");
  const operation = await threadBroker.forkThread(host, input);
  sendRealtimePeerMessage(peer, {
    type: "thread.fork.result",
    requestId: message.requestId,
    operation,
  });
}

export async function readForkStatus(
  peer: RealtimePeer,
  message: Extract<RealtimeClientMessage, { type: "thread.fork.status" }>,
) {
  const input = threadForkStatusSchema.parse(message);
  const host = requireRecord(hostStore.getWithSecret(input.hostId), "Host not found");
  const operation = await threadBroker.forkStatus(host, input.operationId);
  if (operation === null) {
    sendRealtimePeerMessage(peer, {
      type: "error",
      requestId: message.requestId,
      message: "Fork operation not found",
      code: "FORK_OPERATION_NOT_FOUND",
      details: { code: "FORK_OPERATION_NOT_FOUND" },
    });
    return;
  }
  sendRealtimePeerMessage(peer, {
    type: "thread.fork.result",
    requestId: message.requestId,
    operation,
  });
}
