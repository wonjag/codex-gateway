import { runtimeLog } from "./runtime-log";
import { posix } from "node:path";
import { z } from "zod";
import {
  queuePauseReasonSchema,
  type QueuedTurn,
  type QueuePauseReason,
} from "~~/shared/types/turn-queue";
import type { RealtimeClientMessage } from "~~/shared/types";
import { gatewayDatabase } from "../storage/database";
import { encryptJson, decryptJson } from "../storage/crypto";
import { bindGatewayUser, currentGatewayUserId } from "../state/memory";
import { hostStore } from "../state/hosts";
import { projectStore } from "../state/projects";
import { requireRecord } from "../http/validation/common";
import { turnStartSchema } from "../http/validation/threads";
import { startTurnFromRealtime } from "../realtime/turn-start";
import { steerTurnFromRealtime } from "../realtime/turn-steer";
import { CodexRpcError } from "../http/errors";
import { threadBroker } from "./broker";
import { threadRuntimeEvents } from "./thread-runtime-events";
import { ThreadWorkspaceMismatchError } from "./thread-workspace";

const rowSchema = z.object({
  message_id: z.string(),
  encrypted_input: z.string(),
  status: z.enum(["waiting", "sending", "paused"]),
  pause_reason: queuePauseReasonSchema.nullable(),
  created_at: z.string(),
});
type Scope = { hostId: number; threadId: string };
type Snapshot = Scope & { type: "turn.queue.snapshot"; requestId: string; entries: QueuedTurn[] };
const subscribers = new Map<number, Set<(snapshot: Snapshot) => void>>();
const workers = new Map<string, () => void>();
const inserting = new Map<string, { id: string; dispatched: boolean }>();
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
      .prepare(
        "UPDATE turn_queue SET pause_reason=CASE WHEN status='sending' THEN 'delivery_uncertain' ELSE 'restarted' END, status='paused' WHERE status IN ('waiting', 'sending')",
      )
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
    entries: rows(scope).map((row) => {
      const input = turnStartSchema.parse(decryptJson(row.encrypted_input));
      return {
        id: row.message_id,
        text: input.text,
        status: row.status,
        pauseReason: row.pause_reason,
        canRepairWorkspace:
          row.status === "paused" &&
          row.pause_reason === "workspace_mismatch" &&
          !hasWorkspaceRelativeAttachments(input),
        createdAt: row.created_at,
      };
    }),
  };
}
function hasWorkspaceRelativeAttachments(input: z.infer<typeof turnStartSchema>) {
  // Project references are resolved under project.remotePath. Rebinding them could silently
  // select a different same-named file, so preserve the input and require explicit reattachment.
  return (
    input.references.length > 0 ||
    input.files.some((file) => !posix.isAbsolute(file.path)) ||
    input.images.some((image) => image.path !== undefined && !posix.isAbsolute(image.path))
  );
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
      "UPDATE turn_queue SET status=?, pause_reason=NULL, encrypted_input=CASE WHEN ?='sent' THEN '' ELSE encrypted_input END WHERE user_id=? AND host_id=? AND thread_id=? AND message_id=?",
    )
    .run(status, status, userId(), scope.hostId, scope.threadId, id);
}
function pause(scope: Scope, reason: QueuePauseReason, failedId?: string) {
  db()
    .prepare(
      "UPDATE turn_queue SET status='paused', pause_reason=CASE WHEN ? IS NULL OR message_id=? THEN ? ELSE 'queue_blocked' END WHERE user_id=? AND host_id=? AND thread_id=? AND status IN ('waiting', 'sending')",
    )
    .run(failedId ?? null, failedId ?? null, reason, userId(), scope.hostId, scope.threadId);
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

type QueueRequest = Extract<RealtimeClientMessage, { type: "turn.queue" }>;

export async function insertQueuedTurn(request: QueueRequest) {
  const scope = { hostId: request.hostId, threadId: request.threadId };
  const host = requireRecord(hostStore.getWithSecret(scope.hostId), "Host not found");
  const id = z.string().min(1).parse(request.id);
  const expectedTurnId = z.string().min(1).parse(request.expectedTurnId);
  const key = `${userId()}:${scope.hostId}:${scope.threadId}`;
  const pending = rows(scope);
  const row = pending.find((item) => item.message_id === id);
  // Sent/cancelled tombstones and concurrent retries must never submit the same message twice.
  if (!row) return publish(scope);
  const existing = inserting.get(key);
  if (existing?.id === id) return publish(scope);
  if (existing)
    throw new Error("Another queued message is being inserted; this message remains queued");
  if (pending.some((item) => item.status !== "waiting"))
    throw new Error("Queue must be waiting before inserting a message");
  const input = turnStartSchema.parse(decryptJson(row.encrypted_input));
  const attempt = { id, dispatched: false };
  inserting.set(key, attempt);
  let unsubscribe = () => {};
  let release = () => {};
  try {
    const lease = threadBroker.retainQueuedThread(host, scope.threadId);
    release = () => lease.release();
    // Keep failure continuity while the FIFO worker is suspended for this explicit insertion.
    unsubscribe = threadRuntimeEvents.subscribe(scope.hostId, scope.threadId, (event) => {
      if (event.event.type === "turn.completed" && event.event.turn.status !== "completed")
        pause(scope, "interrupted");
    });
    workers.get(key)?.();
    await lease.ready;
    const result = await steerTurnFromRealtime(
      { ...input, type: "turn.steer", requestId: id, expectedTurnId },
      () => {
        const current = rows(scope);
        const candidate = current.find((item) => item.message_id === id);
        if (
          candidate?.encrypted_input !== row.encrypted_input ||
          current.some((item) => item.status !== "waiting")
        )
          return false;
        setStatus(scope, id, "sending");
        publish(scope);
        attempt.dispatched = true;
        return true;
      },
    );
    // ACK means the runtime accepted the input, not that the model has consumed or obeyed it.
    if (result !== null) setStatus(scope, id, "sent");
    return publish(scope);
  } catch (error) {
    if (error instanceof ThreadWorkspaceMismatchError && !attempt.dispatched) {
      if (rows(scope).some((item) => item.message_id === id))
        pause(scope, "workspace_mismatch", id);
    } else if (attempt.dispatched && !isRejectedSteer(error)) {
      // A timeout/disconnect can occur after acceptance. Preserve the message for manual review.
      pause(scope, "delivery_uncertain", id);
    } else if (rows(scope).find((item) => item.message_id === id)?.status === "sending") {
      setStatus(scope, id, "waiting");
    }
    publish(scope);
    throw error;
  } finally {
    inserting.delete(key);
    unsubscribe();
    release();
    // Return to normal FIFO processing, including after an explicit stale-turn rejection.
    await handleTurnQueue({ ...request, action: "list" });
  }
}

function isRejectedSteer(error: unknown) {
  return (
    error instanceof CodexRpcError &&
    error.rpcMethod === "turn/steer" &&
    (error.rpcCode === -32601 ||
      (error.rpcCode === -32600 &&
        (error.message === "no active turn to steer" ||
          /^expected active turn id `.+` but found `.+`$/.test(error.message))))
  );
}

export async function handleTurnQueue(request: QueueRequest) {
  const scope = { hostId: request.hostId, threadId: request.threadId };
  const host = requireRecord(hostStore.getWithSecret(scope.hostId), "Host not found");
  const key = `${userId()}:${scope.hostId}:${scope.threadId}`;
  const insertion = inserting.get(key);
  if (
    insertion?.dispatched === true &&
    (request.action === "resume" ||
      request.action === "repairWorkspace" ||
      ((request.action === "edit" || request.action === "cancel") && request.id === insertion.id))
  )
    throw new Error("Wait for the in-flight insertion before changing this message or resuming");
  if (request.action === "enqueue") {
    const input = turnStartSchema.parse(request.input);
    if (input.hostId !== scope.hostId || input.threadId !== scope.threadId)
      throw new Error("Queue scope mismatch");
    const project = requireRecord(projectStore.get(input.projectId), "Project not found");
    if (project.hostId !== scope.hostId) throw new Error("Project does not belong to host");
    const id = z.string().min(1).parse(input.clientUserMessageId);
    // Include sent/cancelled tombstones: retries must not resurrect a delivered message or
    // replace a user's repaired input with the original request's stale workspace.
    const findExisting = db().prepare(
      "SELECT 1 FROM turn_queue WHERE user_id=? AND host_id=? AND thread_id=? AND message_id=?",
    );
    if (findExisting.get(userId(), scope.hostId, scope.threadId, id)) return publish(scope);
    const workspace = await threadBroker.readThreadWorkspace(host, scope.threadId);
    if (findExisting.get(userId(), scope.hostId, scope.threadId, id)) return publish(scope);
    const mismatch = project.remotePath !== workspace.cwd;
    if (rows(scope).length >= 50) throw new Error("Queue limit reached (50)");
    db()
      .prepare(
        "INSERT OR IGNORE INTO turn_queue(user_id,host_id,thread_id,message_id,encrypted_input,status,pause_reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        userId(),
        scope.hostId,
        scope.threadId,
        id,
        encryptJson(input),
        mismatch ? "paused" : "waiting",
        mismatch ? "workspace_mismatch" : null,
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
  } else if (request.action === "repairWorkspace") {
    const id = z.string().min(1).parse(request.id);
    const pending = rows(scope);
    const row = pending.find((item) => item.message_id === id);
    if (inserting.has(key) || pending.some((item) => item.status === "sending"))
      throw new Error("Wait for the in-flight message before repairing the workspace");
    if (row?.status !== "paused" || row.pause_reason !== "workspace_mismatch")
      throw new Error(
        "Only a confirmed workspace mismatch can be repaired; review message delivery first",
      );
    const input = turnStartSchema.parse(decryptJson(row.encrypted_input));
    if (hasWorkspaceRelativeAttachments(input))
      throw new Error(
        "This message has workspace-relative files. Remove it and reselect files in the correct conversation before sending.",
      );
    // Stop any worker still checking a prior input. Its onStarting guard will reject dispatch.
    workers.get(key)?.();
    const workspace = await threadBroker.readThreadWorkspace(host, scope.threadId);
    const changed = db()
      .prepare(
        "UPDATE turn_queue SET encrypted_input=?, pause_reason='workspace_repaired' WHERE user_id=? AND host_id=? AND thread_id=? AND message_id=? AND status='paused' AND pause_reason='workspace_mismatch' AND encrypted_input=?",
      )
      .run(
        encryptJson({ ...input, projectId: workspace.projectId }),
        userId(),
        scope.hostId,
        scope.threadId,
        id,
        row.encrypted_input,
      );
    if (changed.changes !== 1)
      throw new Error("The queued message changed during repair; review its current state");
    // Repair never starts a turn. The user must review the preserved input and resume separately.
    return publish(scope);
  } else if (request.action === "resume") {
    if (rows(scope).some((row) => row.pause_reason === "workspace_mismatch"))
      throw new Error("Repair or remove messages with a workspace mismatch before resuming");
    db()
      .prepare(
        "UPDATE turn_queue SET status='waiting', pause_reason=NULL WHERE user_id=? AND host_id=? AND thread_id=? AND status='paused'",
      )
      .run(userId(), scope.hostId, scope.threadId);
  }
  const result = publish(scope);
  if (!workers.has(key) && !inserting.has(key) && rows(scope)[0]?.status === "waiting") {
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = threadBroker.retainQueuedThread(host, scope.threadId);
    const unsubscribe = threadRuntimeEvents.subscribe(scope.hostId, scope.threadId, (event) => {
      if (event.event.type === "turn.completed" && event.event.turn.status !== "completed") {
        pause(scope, "interrupted");
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
      let candidateId: string | undefined;
      try {
        await lease.ready;
        if (stopped) return;
        const row = rows(scope)[0];
        if (!row || row.status !== "waiting") {
          stop();
          return;
        }
        candidateId = row.message_id;
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
      } catch (error) {
        // Retain input on validation/transport failure; never guess whether turn/start was accepted.
        if (
          !stopped &&
          (candidateId === undefined || rows(scope).some((row) => row.message_id === candidateId))
        ) {
          const reason =
            error instanceof ThreadWorkspaceMismatchError
              ? "workspace_mismatch"
              : "delivery_uncertain";
          runtimeLog("queued turn submission paused after failure", { ...scope, reason });
          pause(scope, reason, candidateId);
          stop();
        }
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
