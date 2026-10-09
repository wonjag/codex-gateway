import { readValidatedBody } from "h3";
import { z } from "zod";
import { requireAuthenticatedUser } from "../../../../../../server/utils/gateway/auth/context";
import { defineGatewayEventHandler } from "../../../../../../server/utils/gateway/http/errors";
import { requireRecord } from "../../../../../../server/utils/gateway/http/validation/common";
import { threadBroker } from "../../../../../../server/utils/gateway/runtime/broker";
import { hostStore } from "../../../../../../server/utils/gateway/state/hosts";

const compactRequest = z
  .object({ hostId: z.number().int().positive(), threadId: z.string().min(1) })
  .strict();

// This authenticated E2E-only endpoint invokes one allowlisted native operation on the existing
// shared host client. It neither fabricates history nor exposes a generic app-server RPC tunnel.
export default defineGatewayEventHandler(async (event) => {
  requireAuthenticatedUser(event);
  const request = await readValidatedBody(event, (body) => compactRequest.parse(body));
  const host = requireRecord(hostStore.getWithSecret(request.hostId), "Host not found");
  const client = await threadBroker.getHostClient(host);
  await client.request("thread/compact/start", { threadId: request.threadId }, 120_000);
  return { accepted: true };
});
