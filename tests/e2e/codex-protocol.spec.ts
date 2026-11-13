import { isTurnDeliveryUncertain } from "../../shared/rpc-response-error";
import { realtimeRequestErrorFromServer } from "../../app/stores/gateway-realtime/request-errors";
import { gatewayThreadFixture } from "./fixtures/gateway-thread";
import { parseRpcResponse, TURN_DELIVERY_UNCERTAIN } from "../../shared/rpc-response-error";
import { expect, test } from "@playwright/test";
import {
  threadHistoryTurnFromUnknown,
  parseTurnStartResponse,
  threadTurnSchema,
  appServerThreadSchema,
  parseThreadReadResult,
} from "../../shared/runtime/app-server";
import { mapCodexNotification } from "../../server/utils/gateway/agent/providers/codex/codex-event-mapper";
import { appServerTurnFixture } from "./fixtures/app-server-turn";

// These boundary assertions supplement the real SSH/turn/multi-client E2E suite.
// They cover error and historical payloads that cannot be reliably induced with a model prompt.
test("accepts 0.167 turn lineage in responses, notifications and historical turns", () => {
  const turn = appServerTurnFixture({ id: "follow-up", rootTurnId: "original" });
  expect(parseTurnStartResponse({ turn }).turn).toEqual(turn);
  expect(threadHistoryTurnFromUnknown(turn)?.id).toBe("follow-up");
  for (const method of ["turn/started", "turn/completed"]) {
    const payload = method === "turn/completed" ? { ...turn, status: "completed" } : turn;
    expect(
      mapCodexNotification({ method, params: { threadId: "thread", turn: payload } }),
    ).toMatchObject({ event: { turn: { id: "follow-up", rootTurnId: "original" } } });
  }
  const { rootTurnId: _rootTurnId, ...historicalTurn } = turn;
  expect(threadTurnSchema.safeParse(historicalTurn).success).toBe(true);
  expect(threadTurnSchema.safeParse({ ...turn, rootTurnId: null }).success).toBe(true);
  expect(threadTurnSchema.safeParse({ ...turn, rootTurnId: 42 }).success).toBe(false);
  expect(threadTurnSchema.safeParse({ ...turn, id: "" }).success).toBe(false);
  expect(threadTurnSchema.safeParse({ ...turn, unknownTurnField: true }).success).toBe(false);
});

test("preserves native error details without losing failed-turn completion", () => {
  for (const codexErrorInfo of [
    "modelNotFound",
    "policyCapacityUnavailable",
    "newNativeError",
    { newNativeError: { detail: "opaque" } },
  ]) {
    const turn = appServerTurnFixture({
      id: "failed-turn",
      rootTurnId: "failed-turn",
      status: "failed",
      error: {
        message: "Native failure",
        codexErrorInfo,
        additionalDetails: null,
        misalignment: {
          errorType: "classification",
          detailedExplanation: "Explanation",
          reviewTarget: "opaque-review-target",
          steer: null,
        },
      },
    });
    expect(parseTurnStartResponse({ turn }).turn).toEqual(turn);
    expect(
      mapCodexNotification({ method: "turn/completed", params: { threadId: "thread", turn } }),
    ).toMatchObject({ event: { type: "turn.completed", turn } });
    expect(
      threadTurnSchema.safeParse({ ...turn, error: { ...turn.error, codexErrorInfo: 42 } }).success,
    ).toBe(false);
  }
});

test("0.169 keeps attached ownership separate from lineage and retains strict thread validation", () => {
  const fixture = gatewayThreadFixture({ id: "attached", attachedToThreadId: "owner" });
  const { hostId: _host, pinned: _pinned, title: _title, appServerProjectId, ...native } = fixture;
  const thread = { ...native, projectId: appServerProjectId };
  expect(appServerThreadSchema.parse(thread).attachedToThreadId).toBe("owner");
  expect(appServerThreadSchema.parse(thread).parentThreadId).toBeNull();
  expect(appServerThreadSchema.safeParse({ ...thread, attachedToThreadId: null }).success).toBe(
    true,
  );
  expect(appServerThreadSchema.safeParse({ ...thread, attachedToThreadId: 42 }).success).toBe(
    false,
  );
  expect(appServerThreadSchema.safeParse({ ...thread, unknownThreadField: true }).success).toBe(
    false,
  );
});

test("a successful upstream envelope with an invalid turn is explicitly delivery-uncertain", () => {
  const turn = { ...appServerTurnFixture({ id: "accepted" }), unsupportedField: true };
  let failure: unknown;
  try {
    parseRpcResponse("turn/start", { turn }, parseTurnStartResponse);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: TURN_DELIVERY_UNCERTAIN, rpcMethod: "turn/start" });
  expect(() => parseRpcResponse("thread/read", {}, parseThreadReadResult)).toThrow(/incompatible/);
});

test("uncertain delivery survives the real browser error details envelope", () => {
  const error = realtimeRequestErrorFromServer("Response decoder failed", undefined, {
    code: TURN_DELIVERY_UNCERTAIN,
  });
  expect(isTurnDeliveryUncertain(error)).toBe(true);
  expect(isTurnDeliveryUncertain(new Error("Rejected"))).toBe(false);
});
