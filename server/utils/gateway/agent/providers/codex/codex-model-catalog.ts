import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelListResult, ModelRecord } from "~~/shared/types";
import type { AgentRpcClient } from "../../provider-adapter";
import { ModelRouteError } from "../../../runtime/model-route-errors";
import { currentGatewayUserId } from "../../../state/memory";
import { readCodexModelProviders } from "./codex-model-providers";

const groupSchema = z
  .object({
    userId: z.number().int().positive(),
    hostId: z.number().int().positive(),
    modelProvider: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    models: z.array(z.string().trim().min(1)).min(1).max(1000),
  })
  .strict();
const catalogPageSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        model: z.string().min(1),
        displayName: z.string(),
        hidden: z.boolean().optional(),
        isDefault: z.boolean().optional(),
      })
      .loose(),
  ),
  nextCursor: z.string().nullable().optional(),
});

function invalidGroups() {
  return new ModelRouteError(
    "The configured model groups are invalid. Check the Gateway model group configuration.",
    "MODEL_GROUPS_CONFIG_INVALID",
    502,
  );
}

function configuredGroups(hostId: number) {
  const raw = process.env.CODEX_GATEWAY_MODEL_GROUPS?.trim();
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidGroups();
  }
  const result = z.array(groupSchema).max(1000).safeParse(parsed);
  if (!result.success) throw invalidGroups();
  const userId = currentGatewayUserId();
  if (userId === null) throw new Error("Model groups require authentication.");
  const groups = result.data.filter((group) => group.userId === userId && group.hostId === hostId);
  const providers = new Set<string>();
  for (const group of groups) {
    if (providers.has(group.modelProvider) || new Set(group.models).size !== group.models.length)
      throw invalidGroups();
    providers.add(group.modelProvider);
  }
  return groups;
}

async function readNativeModels(client: AgentRpcClient): Promise<ModelRecord[]> {
  const models = new Map<string, ModelRecord>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  // Consume the native catalog before grouping: app-server 0.160.0 has no provider filter, and
  // applying grouping separately to native pages would omit or duplicate allowlisted models.
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = catalogPageSchema.parse(
      await client.request("model/list", { includeHidden: true, limit: 100, cursor }),
    );
    for (const model of page.data) models.set(model.model, model);
    cursor = page.nextCursor ?? null;
    if (cursor === null) return [...models.values()];
    if (cursors.has(cursor)) throw new Error("The native model catalog returned a repeated cursor");
    cursors.add(cursor);
  }
  throw new Error("The native model catalog exceeded the pagination limit");
}

export async function readCodexModelCatalog(client: AgentRpcClient, hostId: number, cwd?: string) {
  // No cross-host/user configuration cache. New selections always validate against the remote
  // configuration that the same shared Host RPC connection currently sees.
  const configuration = await readCodexModelProviders(client, cwd);
  const nativeModels = await readNativeModels(client);
  const byModel = new Map(nativeModels.map((model) => [model.model, model]));
  const configured = configuredGroups(hostId);
  const groups =
    configured.length > 0
      ? configured
      : [
          {
            modelProvider: configuration.defaultModelProvider,
            displayName:
              configuration.providers.get(configuration.defaultModelProvider) ??
              configuration.defaultModelProvider,
            models: nativeModels.map((model) => model.model),
          },
        ];
  const models: ModelRecord[] = [];
  for (const group of groups) {
    if (!configuration.providers.has(group.modelProvider)) throw invalidGroups();
    for (const slug of group.models) {
      const model = byModel.get(slug);
      if (model === undefined) throw invalidGroups();
      models.push({
        ...model,
        modelProvider: group.modelProvider,
        providerDisplayName: group.displayName,
        isDefault:
          group.modelProvider === configuration.defaultModelProvider &&
          (configuration.model === null ? model.isDefault === true : slug === configuration.model),
      });
    }
  }
  return { ...configuration, models };
}

export function requireModelRoute(
  catalog: Awaited<ReturnType<typeof readCodexModelCatalog>>,
  modelProvider: string,
  model: string,
) {
  if (
    !catalog.providers.has(modelProvider) ||
    !catalog.models.some((entry) => entry.modelProvider === modelProvider && entry.model === model)
  ) {
    throw new ModelRouteError("The selected model is not available in this provider group.");
  }
}

export async function listCodexModelGroups(
  client: AgentRpcClient,
  hostId: number,
  params: Record<string, unknown>,
): Promise<ModelListResult> {
  const catalog = await readCodexModelCatalog(client, hostId);
  const models =
    params.includeHidden === true
      ? catalog.models
      : catalog.models.filter((model) => model.hidden !== true);
  const revision = createHash("sha256")
    .update(JSON.stringify([currentGatewayUserId(), hostId, catalog.defaultModelProvider, models]))
    .digest("hex")
    .slice(0, 24);
  let offset = 0;
  if (typeof params.cursor === "string" && params.cursor !== "") {
    const match = /^groups:([a-f0-9]{24}):(\d+)$/.exec(params.cursor);
    if (match === null || match[1] !== revision) {
      throw new ModelRouteError("The model catalog changed. Reload the model list.");
    }
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset > models.length)
      throw new ModelRouteError("Invalid model catalog cursor.");
  }
  const limit = typeof params.limit === "number" ? params.limit : 50;
  const end = offset + limit;
  return {
    data: models.slice(offset, end),
    nextCursor: end < models.length ? `groups:${revision}:${end}` : null,
    defaultModelProvider: catalog.defaultModelProvider,
  };
}
