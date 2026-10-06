import { runtimeLog } from "./runtime-log";
import { z } from "zod";
import type { QueuedTurn } from "~~/shared/types/turn-queue";
import type { RealtimeClientMessage } from "~~/shared/types";
import { gatewayDatabase } from "../storage/database";
import { encryptJson, decryptJson } from "../storage/crypto";
import { bindGatewayUser, currentGatewayUserId } from "../state/memory";
import { hostStore } from "../state/hosts";
import { projectStore } from "../state/projects";
import { requireRecord } from "../http/validation/common";
import { turnStartSchema } from "../http/validation/threads";
import { startTurnFromRealtime } from "../realtime/turn-start";
import { threadBroker } from "./broker";
import { threadRuntimeEvents } from "./thread-runtime-events";

const rowSchema = z.object({
  message_id: z.string(),
  encrypted_input: z.string(),
  status: z.enum(["waiting", "sending", "paused"]),
  created_at: z.string(),
});
type Scope = { hostId: number; threadId: string };
type Snapshot = Scope & { type: "turn.queue.snapshot"; requestId: string; entries: QueuedTurn[] };
const subscribers = new Map<number, Set<(snapshot: Snapshot) => void>>();
const workers = new Map<string, () => void>();
let recovered = false;

function userId() {
  const id = currentGatewayUserId();
  if (id === null) throw new Error("Queue requires authentication");
  return id;
}
function db() {
  const database = gatewayDatabase();
  if (!recovered) {
    // A restart loses runtime event continuity. Keep pending inputs, but require review before resuming.
    database
      .prepare("UPDATE turn_queue SET status = 'paused' WHERE status IN ('waiting', 'sending')")
      .run();
    recovered = true;
  }
  return database;
}
function rows(scope: Scope) {
  return z
    .array(rowSchema)
    .parse(
      db()
        .prepare(
          "SELECT * FROM turn_queue WHERE user_id=? AND host_id=? AND thread_id=? AND status!='sent' ORDER BY sequence",
        )
        .all(userId(), scope.hostId, scope.threadId),
    );
}
function snapshot(scope: Scope): Snapshot {
  return {
    type: "turn.queue.snapshot",
    requestId: "",
    ...scope,
    entries: rows(scope).map((row) => ({
      id: row.message_id,
      text: turnStartSchema.parse(decryptJson(row.encrypted_input)).text,
      status: row.status,
      createdAt: row.created_at,
    })),
  };
}
function publish(scope: Scope) {
  const message = snapshot(scope);
  for (const callback of subscribers.get(userId()) ?? []) {
    try {
      callback(message);
    } catch {
      /* A disconnected browser cannot stop a server queue. */
    }
  }
  return message;
}
function setStatus(scope: Scope, id: string, status: string) {
  db()
    .prepare(
      "UPDATE turn_queue SET status=?, encrypted_input=CASE WHEN ?='sent' THEN '' ELSE encrypted_input END WHERE user_id=? AND host_id=? AND thread_id=? AND message_id=?",
    )
    .run(status, status, userId(), scope.hostId, scope.threadId, id);
}
function pause(scope: Scope) {
  db()
    .prepare(
      "UPDATE turn_queue SET status='paused' WHERE user_id=? AND host_id=? AND thread_id=? AND status!='sent'",
    )
    .run(userId(), scope.hostId, scope.threadId);
  publish(scope);
}
export function subscribeTurnQueue(id: number, callback: (snapshot: Snapshot) => void) {
  const callbacks = subscribers.get(id) ?? new Set();
  callbacks.add(callback);
  subscribers.set(id, callbacks);
  return () => {
    callbacks.delete(callback);
    if (!callbacks.size) subscribers.delete(id);
  };
}

export function handleTurnQueue(request: Extract<RealtimeClientMessage, { type: "turn.queue" }>) {
  const scope = { hostId: request.hostId, threadId: request.threadId };
  const host = requireRecord(hostStore.getWithSecret(scope.hostId), "Host not found");
  if (request.action === "enqueue") {
    const input = turnStartSchema.parse(request.input);
    if (input.hostId !== scope.hostId || input.threadId !== scope.threadId)
      throw new Error("Queue scope mismatch");
    const project = requireRecord(projectStore.get(input.projectId), "Project not found");
    if (project.hostId !== scope.hostId) throw new Error("Project does not belong to host");
    const id = z.string().min(1).parse(input.clientUserMessageId);
    if (rows(scope).length >= 50) throw new Error("Queue limit reached (50)");
    db()
      .prepare(
        "INSERT OR IGNORE INTO turn_queue(user_id,host_id,thread_id,message_id,encrypted_input,status,created_at) VALUES(?,?,?,?,?,'waiting',?)",
      )
      .run(
        userId(),
        scope.hostId,
        scope.threadId,
        id,
        encryptJson(input),
        new Date().toISOString(),
      );
  } else if (request.action === "cancel" || request.action === "edit") {
    const row = rows(scope).find((item) => item.message_id === request.id);
    if (!row || row.status === "sending") throw new Error("Message is no longer editable");
    if (request.action === "cancel") {
      // Preserve the idempotency tombstone so a delayed enqueue cannot resurrect a cancelled message.
      setStatus(scope, row.message_id, "sent");
    } else {
      const text = z.string().trim().min(1).parse(request.text);
      const input = turnStartSchema.parse(decryptJson(row.encrypted_input));
      db()
        .prepare(
          "UPDATE turn_queue SET encrypted_input=? WHERE user_id=? AND host_id=? AND thread_id=? AND message_id=?",
        )
        .run(
          encryptJson({ ...input, text }),
          userId(),
          scope.hostId,
          scope.threadId,
          row.message_id,
        );
    }
  } else if (request.action === "resume") {
    db()
      .prepare(
        "UPDATE turn_queue SET status='waiting' WHERE user_id=? AND host_id=? AND thread_id=? AND status='paused'",
      )
      .run(userId(), scope.hostId, scope.threadId);
  }
  const result = publish(scope);
  const key = `${userId()}:${scope.hostId}:${scope.threadId}`;
  if (!workers.has(key) && rows(scope)[0]?.status === "waiting") {
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = threadBroker.retainQueuedThread(host, scope.threadId);
    const unsubscribe = threadRuntimeEvents.subscribe(scope.hostId, scope.threadId, (event) => {
      if (event.event.type === "turn.completed" && event.event.turn.status !== "completed") {
        pause(scope);
        stop();
      }
    });
    function stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      lease.release();
      workers.delete(key);
    }
    const run = bindGatewayUser(async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        await lease.ready;
        const row = rows(scope)[0];
        if (!row || row.status !== "waiting") {
          stop();
          return;
        }
        const input = turnStartSchema.parse(decryptJson(row.encrypted_input));
        const result = await startTurnFromRealtime(
          { ...input, type: "turn.start", requestId: row.message_id },
          true,
          () => {
            const current = rows(scope)[0];
            if (
              stopped ||
              current?.message_id !== row.message_id ||
              current.status !== "waiting" ||
              current.encrypted_input !== row.encrypted_input
            )
              return false;
            setStatus(scope, row.message_id, "sending");
            publish(scope);
            return true;
          },
        );
        // A busy result must not undo concurrent edits, cancellations or pauses.
        if (result !== null) setStatus(scope, row.message_id, "sent");
        publish(scope);
        if (!rows(scope).length) {
          stop();
          return;
        }
      } catch {
        // Retain input on validation/transport failure; never guess whether turn/start was accepted.
        runtimeLog("queued turn submission paused after failure", scope);
        pause(scope);
        stop();
      } finally {
        busy = false;
        if (!stopped)
          timer = setTimeout(() => {
            void run();
          }, 2_000);
      }
    });
    workers.set(key, stop);
    // Publish the enqueue acknowledgement before attempting remote work.
    timer = setTimeout(() => {
      void run();
    }, 0);
  }
  return result;
}
