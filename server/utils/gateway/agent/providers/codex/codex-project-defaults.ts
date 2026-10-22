import type { AgentProjectDefaults } from "~~/shared/types";
import type { AgentRpcClient } from "../../provider-adapter";
import { readCodexModelProviders } from "./codex-model-providers";

export async function readCodexProjectDefaults(
  client: AgentRpcClient,
  cwd: string,
): Promise<AgentProjectDefaults> {
  // config/read is the only authoritative pre-thread view of Codex's layered configuration.
  // model/list.isDefault describes the catalog, not ~/.codex/config.toml or project overrides.
  const configuration = await readCodexModelProviders(client, cwd);
  return {
    provider: "codex",
    model: configuration.model,
    modelProvider: configuration.defaultModelProvider,
    effort: configuration.effort,
  };
}
