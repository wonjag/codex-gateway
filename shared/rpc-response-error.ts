import { recordFromUnknown } from "./utils/records";

// A successful JSON-RPC envelope has already arrived. A decoder failure must never be
// reported as an upstream rejection or retried as a fresh mutation.
export const RPC_RESPONSE_INVALID = "codexResponseInvalid";
export const TURN_DELIVERY_UNCERTAIN = "turnDeliveryUncertain";

export class RpcResponseValidationError extends Error {
  readonly code: string;

  constructor(
    readonly rpcMethod: string,
    cause: unknown,
  ) {
    const mutation = rpcMethod === "turn/start" || rpcMethod === "turn/steer";
    super(
      mutation
        ? `Codex accepted ${rpcMethod}, but Gateway could not validate the response. Delivery is uncertain; inspect the native thread before resending.`
        : `Codex ${rpcMethod} response is incompatible with this Gateway. Check the running app-server protocol version.`,
      { cause },
    );
    this.name = "RpcResponseValidationError";
    this.code = mutation ? TURN_DELIVERY_UNCERTAIN : RPC_RESPONSE_INVALID;
  }
}

export function parseRpcResponse<T>(
  method: string,
  value: unknown,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(value);
  } catch (cause) {
    throw new RpcResponseValidationError(method, cause);
  }
}

export function isTurnDeliveryUncertain(error: unknown): boolean {
  const payload = recordFromUnknown(error);
  return (
    payload?.code === TURN_DELIVERY_UNCERTAIN ||
    recordFromUnknown(payload?.details)?.code === TURN_DELIVERY_UNCERTAIN
  );
}
