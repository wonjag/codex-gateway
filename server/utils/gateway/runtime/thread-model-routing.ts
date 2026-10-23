import type { ThreadSettingsState } from "~~/shared/types";
import type { AgentRpcClient } from "../agent/provider-adapter";
import { parseThreadReadResult } from "~~/shared/runtime/app-server";
import {
  readCodexModelCatalog,
  requireModelRoute,
} from "../agent/providers/codex/codex-model-catalog";
import { threadSnapshotStore } from "../state/thread-snapshots";
import { assertThreadModelProvider, ModelRouteError } from "./model-route-errors";

interface ThreadModelState {
  modelProvider: string;
  model: string | null;
  cwd: string;
}

export async function readThreadModelState(
  client: AgentRpcClient,
  hostId: number,
  threadId: string,
): Promise<ThreadModelState> {
  const snapshot = threadSnapshotStore.get(hostId, threadId);
  // A fresh thread has no readable rollout until its first turn. Its native thread/start
  // snapshot is authoritative, including the provider selected by app-server.
  if (snapshot?.thread.path === null) {
    return {
      ...snapshot.thread,
      model: snapshot.threadSettings?.model ?? snapshot.thread.model,
    };
  }
  return (
    await client.request(
      "thread/read",
      { threadId, includeTurns: false },
      30_000,
      parseThreadReadResult,
    )
  ).thread;
}

export async function validateThreadModelSelection(
  client: AgentRpcClient,
  hostId: number,
  thread: ThreadModelState,
  input: Pick<ThreadSettingsState, "model" | "modelProvider" | "collaborationMode">,
) {
  assertThreadModelProvider(input.modelProvider, thread.modelProvider);
  const models = [input.model, input.collaborationMode?.settings.model].filter(
    (model): model is string => typeof model === "string" && model !== "",
  );
  // A catalog/allowlist update must not prevent continuing an already-running native route.
  // Any attempt to change its model still requires an allowed (provider, model) pair.
  const changed = models.filter((model) => model !== thread.model);
  if (changed.length === 0) return;
  const catalog = await readCodexModelCatalog(client, hostId, thread.cwd);
  for (const model of changed) requireModelRoute(catalog, thread.modelProvider, model);
}

export async function resolveNewThreadModelSelection(
  client: AgentRpcClient,
  hostId: number,
  params: Record<string, unknown>,
) {
  const requestedModel =
    typeof params.model === "string" && params.model !== "" ? params.model : null;
  const requestedProvider = typeof params.modelProvider === "string" ? params.modelProvider : null;
  // Preserve the existing "follow remote defaults" behavior. An explicit selection below pins
  // both model and provider before sending thread/start, including duplicate model names.
  if (requestedModel === null && requestedProvider === null) return {};
  const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
  const catalog = await readCodexModelCatalog(client, hostId, cwd);
  const modelProvider = requestedProvider ?? catalog.defaultModelProvider;
  const model = requestedModel ?? catalog.model;
  if (model === null) throw new ModelRouteError("Select a model for this provider group.");
  requireModelRoute(catalog, modelProvider, model);
  return { model, modelProvider };
}
