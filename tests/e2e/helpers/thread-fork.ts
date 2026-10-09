import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { AppServerTimelineEntry, ThreadForkOperation } from "../../../shared/types";
import { sendRealtimeRequest } from "./realtime";

export interface ForkScope {
  hostId: number;
  threadId: string;
}

export async function nameForkSource(page: Page, scope: ForkScope, title: string) {
  // A manual title keeps the separate automatic naming feature from adding model requests to
  // protocol tests, and provides a deterministic source for the branch-title assertions.
  await page.evaluate(
    async ({ hostId, threadId, title }) =>
      window.__codexGatewayE2e?.navigation.renameThread(hostId, threadId, title),
    { ...scope, title },
  );
}

export async function sendCompletedForkTurn(page: Page, text: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const driver = window.__codexGatewayE2e;
          return (
            driver !== undefined &&
            !driver.views.loading &&
            driver.navigation.selectedThreadId !== null &&
            driver.navigation.selectedHostId !== null &&
            driver.views.currentThread?.id === driver.navigation.selectedThreadId &&
            driver.views.currentThread?.hostId === driver.navigation.selectedHostId &&
            driver.views.history?.thread.id === driver.navigation.selectedThreadId
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  const composer = page.getByPlaceholder("输入后续修改要求");
  await expect(composer).toBeEditable();
  await composer.fill(text);
  const source = await page.evaluate(() => {
    const driver = window.__codexGatewayE2e;
    const thread = driver?.views.currentThread;
    const history = driver?.views.history;
    if (
      driver === undefined ||
      thread === null ||
      thread === undefined ||
      history === null ||
      history === undefined ||
      driver.navigation.selectedThreadId !== thread.id ||
      driver.navigation.selectedHostId !== thread.hostId ||
      history.thread.id !== thread.id
    ) {
      throw new Error("Selected native thread is not ready for input");
    }
    return {
      hostId: thread.hostId,
      threadId: thread.id,
      previous: history.thread.turns.map((turn) => turn.id),
    };
  });
  await page.getByTestId("send-turn-button").click();
  const completed: { turnId: string | null } = { turnId: null };
  await expect
    .poll(
      async () => {
        completed.turnId = await page.evaluate(
          ({ hostId, threadId, previous, text }) => {
            const driver = window.__codexGatewayE2e;
            if (
              driver === undefined ||
              driver.navigation.selectedHostId !== hostId ||
              driver.navigation.selectedThreadId !== threadId ||
              driver.views.currentThread?.id !== threadId ||
              driver.views.history?.thread.id !== threadId
            ) {
              return null;
            }
            return (
              driver.views.history.thread.turns.find(
                (turn) =>
                  !previous.includes(turn.id) &&
                  !/^(client-|system-)/.test(turn.id) &&
                  turn.status === "completed" &&
                  turn.items.some(
                    (item) =>
                      item.type === "userMessage" &&
                      (item.content ?? []).some(
                        (part) =>
                          part !== null &&
                          typeof part === "object" &&
                          "type" in part &&
                          part.type === "text" &&
                          "text" in part &&
                          part.text === text,
                      ),
                  ),
              )?.id ?? null
            );
          },
          { ...source, text },
        );
        return completed.turnId;
      },
      { timeout: 180_000 },
    )
    .not.toBeNull();
  // Keep the successful observation: a later pagination refresh can replace visible turns.
  const turnId = completed.turnId;
  if (turnId === null) throw new Error("No matching completed native turn was observed");
  // Native IDs are collected after turn completion, never taken from optimistic user bubbles.
  expect(turnId).not.toMatch(/^(client-|system-)/);
  return turnId;
}

export async function forkOperation(
  page: Page,
  scope: ForkScope,
  lastTurnId: string,
  operationId: string = randomUUID(),
) {
  const response = await sendRealtimeRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    ...scope,
    lastTurnId,
    operationId,
  });
  if (response.type !== "thread.fork.result") throw new Error("Expected a fork operation");
  return response.operation;
}

export async function forkStatus(page: Page, hostId: number, operationId: string) {
  const response = await sendRealtimeRequest(page, {
    type: "thread.fork.status",
    requestId: randomUUID(),
    hostId,
    operationId,
  });
  if (response.type !== "thread.fork.result") throw new Error("Expected a fork status");
  return response.operation;
}

export async function waitForCreatedFork(page: Page, operation: ThreadForkOperation) {
  let current = operation;
  await expect
    .poll(
      async () => {
        current = await forkStatus(page, operation.hostId, operation.operationId);
        return current.status;
      },
      { timeout: 120_000, intervals: [250, 500, 1_000] },
    )
    .toBe("created");
  if (current.threadId === null) throw new Error("Created fork has no native thread ID");
  return { ...current, threadId: current.threadId };
}

export async function openForkThread(page: Page, scope: ForkScope, projectId: number | null) {
  await page.evaluate(
    async ({ hostId, threadId, projectId }) => {
      const views = window.__codexGatewayE2e?.views;
      if (!views) throw new Error("Gateway E2E driver is unavailable");
      await views.openThread(threadId, { hostId, projectId });
    },
    { ...scope, projectId },
  );
  await expect
    .poll(() => page.evaluate(() => window.__codexGatewayE2e?.views.currentThread?.id))
    .toBe(scope.threadId);
  await expect(page.getByPlaceholder("输入后续修改要求")).toBeEnabled();
}

export async function nativeForkTimeline(page: Page, scope: ForkScope, limit = 100) {
  const entries: AppServerTimelineEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    const response = await sendRealtimeRequest(page, {
      type: "thread.timeline.load",
      requestId: randomUUID(),
      ...scope,
      cursor,
      limit,
    });
    if (response.type !== "thread.timeline.page") throw new Error("Expected native timeline");
    entries.push(...response.data);
    pageCount += 1;
    cursor = response.nextCursor;
    if (cursor !== null) {
      expect(cursors.has(cursor), "Native timeline cursor must advance").toBe(false);
      cursors.add(cursor);
    }
    if (pageCount > 200) throw new Error("Unexpectedly large E2E native timeline");
  } while (cursor !== null);
  return { entries: entries.sort((a, b) => a.position - b.position), pageCount };
}

export function timelineTurnIds(entries: AppServerTimelineEntry[]) {
  return entries.flatMap((entry) => (entry.type === "turnStarted" ? [entry.turnId] : []));
}

export async function forkQueue(page: Page, scope: ForkScope) {
  const response = await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "list",
  });
  if (response.type !== "turn.queue.snapshot") throw new Error("Expected queue snapshot");
  return response.entries;
}

export async function forkGoal(page: Page, scope: ForkScope) {
  const response = await sendRealtimeRequest(page, {
    type: "thread.goal.get",
    requestId: randomUUID(),
    ...scope,
  });
  if (response.type !== "thread.goal.snapshot") throw new Error("Expected goal snapshot");
  return response.goal;
}

export async function forkSettings(page: Page, scope: ForkScope) {
  const response = await sendRealtimeRequest(page, {
    type: "thread.settings.read",
    requestId: randomUUID(),
    ...scope,
  });
  if (response.type !== "thread.settings.snapshot") throw new Error("Expected native settings");
  return response.threadSettings;
}
