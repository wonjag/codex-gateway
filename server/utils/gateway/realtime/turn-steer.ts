import type { RealtimeClientMessage } from "~~/shared/types";
import { requireRecord } from "../http/validation/common";
import { turnSteerSchema } from "../http/validation/threads";
import { threadBroker } from "../runtime/broker";
import { hostStore } from "../state/hosts";
import { projectStore } from "../state/projects";
import {
  fileReferencesAdditionalContext,
  validateProjectFileReferences,
} from "../project-files/project-file-references";

export type RealtimeTurnSteerMessage = Extract<RealtimeClientMessage, { type: "turn.steer" }>;

export async function steerTurnFromRealtime(
  message: RealtimeTurnSteerMessage,
  onDispatch?: () => boolean,
) {
  const input = turnSteerSchema.parse(message);
  const host = requireRecord(hostStore.getWithSecret(input.hostId), "Host not found");
  const project = requireRecord(projectStore.get(input.projectId), "Project not found");
  if (project.hostId !== host.id) throw new Error("Project does not belong to host");
  const references = await validateProjectFileReferences(host, project, input.references);
  return threadBroker.steerTurn(
    host,
    input.threadId,
    {
      text: input.text,
      expectedTurnId: input.expectedTurnId,
      clientUserMessageId: input.clientUserMessageId,
      images: input.images,
      additionalContext: fileReferencesAdditionalContext(references),
    },
    { cwd: project.remotePath, onDispatch: onDispatch ?? (() => true) },
  );
}
