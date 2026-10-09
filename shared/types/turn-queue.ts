import { z } from "zod";

export const queuePauseReasonSchema = z.enum([
  "workspace_mismatch",
  "workspace_repaired",
  "delivery_uncertain",
  "interrupted",
  "restarted",
  "queue_blocked",
]);
export type QueuePauseReason = z.infer<typeof queuePauseReasonSchema>;

export const queuedTurnSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["waiting", "sending", "paused"]),
  pauseReason: queuePauseReasonSchema.nullable(),
  canRepairWorkspace: z.boolean(),
  createdAt: z.string(),
});
export type QueuedTurn = z.infer<typeof queuedTurnSchema>;
export const queueActionSchema = z.enum([
  "list",
  "enqueue",
  "edit",
  "cancel",
  "resume",
  "insert",
  "repairWorkspace",
]);
