import { expect, test } from "@playwright/test";
import {
  threadHistoryTurnFromUnknown,
  parseTurnStartResponse,
  threadTurnSchema,
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
