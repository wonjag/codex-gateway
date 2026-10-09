import type { RealtimeClientMessage } from "~~/shared/types";
import { handleTurnQueue, insertQueuedTurn } from "../../runtime/turn-queue";
import { generateThreadTitle } from "../../runtime/thread-title";
import { hostStore } from "../../state/hosts";
import { requireRecord } from "../../http/validation/common";
import { sendRealtimePeerMessage, type RealtimePeer } from "../peer-state";

export async function turnQueue(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "turn.queue" }>,
) {
  const result =
    request.action === "insert" ? await insertQueuedTurn(request) : await handleTurnQueue(request);
  sendRealtimePeerMessage(peer, { ...result, requestId: request.requestId });
}
export async function threadTitle(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "thread.title.generate" }>,
) {
  const host = requireRecord(hostStore.getWithSecret(request.hostId), "Host not found");
  const title = await generateThreadTitle(host, request.threadId);
  sendRealtimePeerMessage(peer, {
    type: "thread.title.generated",
    requestId: request.requestId,
    title,
  });
}
