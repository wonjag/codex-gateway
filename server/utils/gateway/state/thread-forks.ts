import { z } from "zod";
import type { ThreadForkOperation, ThreadForkOrigin } from "~~/shared/types";
import { gatewayDatabase } from "../storage/database";
import { currentGatewayUserId } from "./memory";
import { projectStore } from "./projects";

const rowSchema = z.object({
  operation_id: z.string(),
  host_id: z.number(),
  source_thread_id: z.string(),
  last_turn_id: z.string(),
  status: z.enum(["creating", "created", "failed", "outcome-unknown"]),
  thread_id: z.string().nullable(),
  cwd: z.string().nullable(),
  error: z.string().nullable(),
});

export interface ThreadForkInput {
  operationId: string;
  threadId: string;
  lastTurnId: string;
}

export const threadForkStore = {
  get(hostId: number, operationId: string): ThreadForkOperation | null {
    const row = gatewayDatabase()
      .prepare(
        "SELECT * FROM thread_fork_operations WHERE user_id = ? AND host_id = ? AND operation_id = ?",
      )
      .get(userId(), hostId, operationId);
    if (row === undefined) return null;
    const parsed = rowSchema.parse(row);
    return {
      operationId: parsed.operation_id,
      hostId: parsed.host_id,
      sourceThreadId: parsed.source_thread_id,
      lastTurnId: parsed.last_turn_id,
      status: parsed.status,
      threadId: parsed.thread_id,
      // Discovered projects are runtime grouping records. Re-resolve by the authoritative cwd
      // after restart instead of persisting an ID that might now describe another workspace.
      projectId: parsed.cwd === null ? null : projectStore.ensureForPath(hostId, parsed.cwd).id,
      error: parsed.error,
    };
  },

  create(hostId: number, input: ThreadForkInput) {
    gatewayDatabase()
      .prepare(
        `INSERT INTO thread_fork_operations
          (user_id, host_id, operation_id, source_thread_id, last_turn_id, status)
         VALUES (?, ?, ?, ?, ?, 'creating')`,
      )
      .run(userId(), hostId, input.operationId, input.threadId, input.lastTurnId);
  },

  created(
    hostId: number,
    operationId: string,
    threadId: string,
    cwd: string,
    pendingTitle: string,
    expectedName: string | null,
  ) {
    gatewayDatabase()
      .prepare(
        `UPDATE thread_fork_operations
         SET status = 'created', thread_id = ?, cwd = ?, pending_title = ?, expected_name = ?,
             error = NULL, updated_at = datetime('now')
         WHERE user_id = ? AND host_id = ? AND operation_id = ? AND status = 'creating'`,
      )
      .run(threadId, cwd, pendingTitle, expectedName, userId(), hostId, operationId);
  },

  pendingTitle(hostId: number, threadId: string) {
    const row = gatewayDatabase()
      .prepare(
        `SELECT operation_id, pending_title, expected_name FROM thread_fork_operations
         WHERE user_id = ? AND host_id = ? AND thread_id = ? AND pending_title IS NOT NULL`,
      )
      .get(userId(), hostId, threadId);
    if (row === undefined) return null;
    return z
      .object({
        operation_id: z.string(),
        pending_title: z.string(),
        expected_name: z.string().nullable(),
      })
      .parse(row);
  },

  clearPendingTitle(hostId: number, threadId: string) {
    gatewayDatabase()
      .prepare(
        `UPDATE thread_fork_operations
         SET pending_title = NULL, expected_name = NULL, error = NULL, updated_at = datetime('now')
         WHERE user_id = ? AND host_id = ? AND thread_id = ? AND status = 'created'`,
      )
      .run(userId(), hostId, threadId);
  },

  finishWithError(
    hostId: number,
    operationId: string,
    status: "failed" | "outcome-unknown" | "created",
    error: string,
  ) {
    // A recorded child is durable success even if title/subscription preparation later fails.
    gatewayDatabase()
      .prepare(
        `UPDATE thread_fork_operations
         SET status = CASE WHEN thread_id IS NOT NULL THEN 'created' ELSE ? END,
             error = ?, updated_at = datetime('now')
         WHERE user_id = ? AND host_id = ? AND operation_id = ?`,
      )
      .run(status, error, userId(), hostId, operationId);
  },

  origin(hostId: number, threadId: string): ThreadForkOrigin | null {
    const row = gatewayDatabase()
      .prepare(
        `SELECT source_thread_id, last_turn_id FROM thread_fork_operations
         WHERE user_id = ? AND host_id = ? AND thread_id = ?`,
      )
      .get(userId(), hostId, threadId);
    if (row === undefined) return null;
    const origin = rowSchema.pick({ source_thread_id: true, last_turn_id: true }).parse(row);
    return { threadId: origin.source_thread_id, turnId: origin.last_turn_id };
  },
};

function userId() {
  const id = currentGatewayUserId();
  if (id === null) throw new Error("Thread forks require an authenticated user scope");
  return id;
}
