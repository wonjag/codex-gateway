import { readValidatedBody } from "h3";
import { z } from "zod";
import { requireAuthenticatedUser } from "../../../../../../server/utils/gateway/auth/context";
import { defineGatewayEventHandler } from "../../../../../../server/utils/gateway/http/errors";
import { requireRecord } from "../../../../../../server/utils/gateway/http/validation/common";
import { threadBroker } from "../../../../../../server/utils/gateway/runtime/broker";
import { hostStore } from "../../../../../../server/utils/gateway/state/hosts";
import { parseRpcResponse } from "../../../../../../shared/rpc-response-error";

// Fault injection only in the test Nuxt layer: the SSH app-server and mutation are real.
// Corrupt exactly one decoder input AFTER the upstream success; never fake an RPC result.
export default defineGatewayEventHandler(async (event) => {
  requireAuthenticatedUser(event);
  const input = await readValidatedBody(event, (body) =>
    z
      .object({ hostId: z.number().int().positive(), threadId: z.string().min(1) })
      .strict()
      .parse(body),
  );
  const host = requireRecord(hostStore.getWithSecret(input.hostId), "Host not found");
  const client = await threadBroker.getHostClient(host);
  const original = client.request.bind(client);
  client.request = (
    method: string,
    params: unknown = {},
    timeoutMs = 120_000,
    parse?: (value: unknown) => unknown,
  ) => {
    const scope = z.object({ threadId: z.string() }).safeParse(params);
    if (method !== "turn/start" || !scope.success || scope.data.threadId !== input.threadId) {
      return parse === undefined
        ? original(method, params, timeoutMs)
        : original(method, params, timeoutMs, parse);
    }
    client.request = original;
    return original(method, params, timeoutMs).then((response) => {
      const result = z.object({ turn: z.record(z.string(), z.unknown()) }).parse(response);
      const invalid = { ...result, turn: { ...result.turn, unsupportedField: true } };
      if (parse === undefined) throw new Error("Test requires the production turn decoder");
      return parseRpcResponse(method, invalid, parse);
    });
  };
  return { armed: true };
});
