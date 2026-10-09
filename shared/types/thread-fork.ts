import { z } from "zod";

export const threadForkOriginSchema = z
  .object({ threadId: z.string().min(1), turnId: z.string().min(1) })
  .strict();

export const threadForkOperationSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    hostId: z.number().int().positive(),
    sourceThreadId: z.string().min(1),
    lastTurnId: z.string().min(1),
    status: z.enum(["creating", "created", "failed", "outcome-unknown"]),
    threadId: z.string().min(1).nullable(),
    projectId: z.number().int().positive().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const threadForkReferenceSchema = threadForkOperationSchema.pick({
  operationId: true,
  hostId: true,
  sourceThreadId: true,
  lastTurnId: true,
});

export type ThreadForkOrigin = z.infer<typeof threadForkOriginSchema>;
export type ThreadForkOperation = z.infer<typeof threadForkOperationSchema>;
export type ThreadForkReference = z.infer<typeof threadForkReferenceSchema>;
