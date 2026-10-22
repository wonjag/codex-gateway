import { z } from "zod";
import type { AgentRpcClient } from "../../provider-adapter";

// config/read also contains credentials and private configuration. Strip everything except the
// routing metadata here, and never return the upstream object to a browser or cache it globally.
const providerConfigSchema = z.object({
  config: z.object({
    model: z.string().nullable(),
    model_provider: z.string().trim().min(1).nullable().optional(),
    model_reasoning_effort: z.string().nullable(),
    model_providers: z.record(z.string(), z.object({ name: z.string().optional() })).optional(),
  }),
});

export async function readCodexModelProviders(client: AgentRpcClient, cwd?: string) {
  const parsed = providerConfigSchema.safeParse(
    await client.request("config/read", { cwd, includeLayers: false }),
  );
  // Do not attach the input or Zod error: this boundary reads a potentially sensitive object.
  if (!parsed.success) throw new Error("The remote model provider configuration is invalid.");
  const { config } = parsed.data;
  const providers = new Map<string, string>([["openai", "Auth / OpenAI"]]);
  for (const [id, provider] of Object.entries(config.model_providers ?? {})) {
    providers.set(id, provider.name ?? id);
  }
  return {
    model: config.model,
    effort: config.model_reasoning_effort,
    defaultModelProvider: config.model_provider ?? "openai",
    providers,
  };
}
