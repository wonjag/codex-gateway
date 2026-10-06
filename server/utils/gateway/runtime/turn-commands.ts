import { maybeGenerateThreadTitle } from "./thread-title";
import { parseThreadReadResult } from "~~/shared/runtime/app-server";
import type { HostRecord } from "~~/shared/types";
import { INITIAL_TURN_PAGE_LIMIT } from "~~/shared/config";
import { randomUUID } from "node:crypto";
import type { ServerRequestResponseInput, TurnStartInput, TurnSteerInput } from "./types";
import type { ControllerRegistry } from "./controller-registry";
import { buildTurnStartParams, buildUserInput } from "../protocol/thread-payload";
import { runtimeLog } from "./runtime-log";
import type { ThreadOpenService } from "./thread-open-service";
import { recordFromUnknown, stringFromUnknown } from "~~/shared/utils/records";
import { trimmedOrFallback } from "~~/shared/utils/strings";
import { parseTurnStartResponse, parseTurnSteerResponse } from "~~/shared/runtime/app-server";
import { recordAcceptedUserMessage } from "./accepted-user-message";

export class ThreadTurnCommandService {
  constructor(
    private readonly registry: ControllerRegistry,
    private readonly openService: ThreadOpenService,
  ) {}

  async startTurn(host: HostRecord, threadId: string, input: TurnStartInput) {
    const clientUserMessageId = trimmedOrFallback(
      input.clientUserMessageId,
      `gateway-${randomUUID()}`,
    );
    return this.registry.withScopedSubscription(host, threadId, async (controller) => {
      maybeGenerateThreadTitle(
        host,
        threadId,
        trimmedOrFallback(controller.getOpenSnapshot()?.thread.preview, input.text),
      );
      const result = await controller.enqueue(() =>
        controller.client.request(
          "turn/start",
          buildTurnStartParams(threadId, clientUserMessageId, input),
          120_000,
          parseTurnStartResponse,
        ),
      );
      const turnId = result.turn?.id === undefined ? "" : String(result.turn.id);
      if (turnId !== "") {
        recordAcceptedUserMessage({
          hostId: host.id,
          threadId,
          turnId,
          clientUserMessageId,
          content: buildUserInput(input),
        });
      }
      controller.markActiveMainThread();
      return result;
    });
  }

  async startQueuedTurn(
    host: HostRecord,
    threadId: string,
    input: TurnStartInput,
    onStarting?: () => boolean,
  ) {
    return this.registry.withScopedSubscription(host, threadId, async (controller) =>
      controller.enqueue(async () => {
        // Fresh thread/start has no persisted rollout yet; its subscribed snapshot is authoritative.
        const snapshot = controller.getOpenSnapshot();
        const thread =
          snapshot?.thread.path === null
            ? snapshot.thread
            : (
                await controller.client.request(
                  "thread/read",
                  { threadId, includeTurns: false },
                  30_000,
                  parseThreadReadResult,
                )
              ).thread;
        if (thread.status.type !== "idle") return null;
        if (input.cwd != null && thread.cwd !== input.cwd)
          throw new Error("Queued thread workspace changed");
        if (onStarting !== undefined && !onStarting()) return null;
        const clientUserMessageId = input.clientUserMessageId ?? `gateway-${randomUUID()}`;
        maybeGenerateThreadTitle(host, threadId, thread.preview || input.text);
        const result = await controller.client.request(
          "turn/start",
          buildTurnStartParams(threadId, clientUserMessageId, input),
          120_000,
          parseTurnStartResponse,
        );
        const turnId = result.turn?.id;
        if (turnId !== undefined)
          recordAcceptedUserMessage({
            hostId: host.id,
            threadId,
            turnId: String(turnId),
            clientUserMessageId,
            content: buildUserInput(input),
          });
        controller.markActiveMainThread();
        return result;
      }),
    );
  }

  async steerTurn(host: HostRecord, threadId: string, input: TurnSteerInput) {
    const clientUserMessageId = trimmedOrFallback(
      input.clientUserMessageId,
      `gateway-steer-${randomUUID()}`,
    );
    return this.registry
      .withScopedSubscription(host, threadId, async (controller) => {
        const result = await controller.enqueue(() =>
          controller.client.request(
            "turn/steer",
            {
              threadId,
              expectedTurnId: input.expectedTurnId,
              clientUserMessageId,
              input: buildUserInput(input),
              additionalContext: input.additionalContext ?? {},
            },
            120_000,
            parseTurnSteerResponse,
          ),
        );
        recordAcceptedUserMessage({
          hostId: host.id,
          threadId,
          turnId: result.turnId ?? input.expectedTurnId,
          clientUserMessageId,
          content: buildUserInput(input),
        });
        controller.markActiveMainThread();
        return result;
      })
      .catch(async (error) => {
        if (isNoActiveTurnToSteer(error)) {
          runtimeLog("refreshing thread after stale steer state", {
            hostId: host.id,
            threadId,
            expectedTurnId: input.expectedTurnId,
          });
          await this.openService.refreshThreadState(host, threadId, null, INITIAL_TURN_PAGE_LIMIT);
        }
        throw error;
      });
  }

  async interruptTurn(host: HostRecord, threadId: string, turnId: string) {
    return this.registry.withScopedSubscription(host, threadId, (controller) =>
      controller.enqueue(() =>
        controller.client.request("turn/interrupt", {
          threadId,
          turnId,
        }),
      ),
    );
  }

  async respondToServerRequest(
    host: HostRecord,
    threadId: string,
    input: ServerRequestResponseInput,
  ) {
    const client = await this.registry.getHostClient(host);
    if (input.error) {
      client.respondError(input.requestId, input.error.code, input.error.message, input.error.data);
    } else {
      client.respond(input.requestId, input.result ?? {});
    }
  }
}

function isNoActiveTurnToSteer(error: unknown) {
  const record = recordFromUnknown(error);
  const message = stringFromUnknown(record?.message);
  return (
    record?.rpcMethod === "turn/steer" &&
    message !== null &&
    message.toLowerCase().includes("no active turn")
  );
}
