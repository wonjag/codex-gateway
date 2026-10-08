import { z } from "zod";

export const queuedTurnSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["waiting", "sending", "paused"]),
  createdAt: z.string(),
});
export type QueuedTurn = z.infer<typeof queuedTurnSchema>;
export const queueActionSchema = z.enum(["list", "enqueue", "edit", "cancel", "resume", "insert"]);
