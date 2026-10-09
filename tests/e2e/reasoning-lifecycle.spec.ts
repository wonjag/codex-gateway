import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/remote-workspace";
import { appServerTurnFixture } from "./fixtures/app-server-turn";
import { openApp, reloadApp } from "./helpers/app";
import { gatewayEventFromNotification } from "./helpers/canonical-event";
import {
  applyGatewayLiveEvent,
  seedGatewayThread,
  selectedThreadStatusInStore,
} from "./helpers/gateway-store";
import { revealVirtualizedChatLocator } from "./helpers/scroll";
import { nameForkSource, nativeForkTimeline, sendCompletedForkTurn } from "./helpers/thread-fork";

const startedAt = Date.parse("2026-07-02T10:00:00.000Z");

function reasoningItem(page: Page, itemId: string) {
  return page.locator(`[data-testid="reasoning-item"][data-item-id="${itemId}"]`);
}

async function expandTurnSteps(page: Page, turnId: string) {
  const toggle = page
    .locator(`[data-row-key$=":turn-${turnId}:intermediate-header"]`)
    .getByRole("button", { name: /中间过程/ });
  await revealVirtualizedChatLocator(page, toggle);
  if ((await toggle.getAttribute("data-state")) === "closed") await toggle.click();
  await expect(toggle).toHaveAttribute("data-state", "open");
}

async function expectStoppedReasoning(page: Page, itemId: string) {
  const item = reasoningItem(page, itemId);
  await revealVirtualizedChatLocator(page, item);
  await expect(item).toHaveAttribute("data-reasoning-state", "idle");
  await expect(item.getByText("思考记录", { exact: true })).toBeVisible();
  await expect(item.getByTestId("reasoning-spinner")).toHaveCount(0);
  await expect(item.getByText("思考中", { exact: true })).toHaveCount(0);
  return item;
}

// These presentation fixtures reproduce missing/replayed lifecycle notifications. The separate
// native test below verifies the real SSH/app-server/model path without replacing its events.
for (const status of ["completed", "failed", "interrupted"] as const) {
  test(`${status} history stops stale reasoning without inventing an item duration`, async ({
    page,
  }) => {
    await openApp(page);
    const threadId = `reasoning-history-${status}`;
    const turnId = `turn-${status}`;
    await seedGatewayThread(page, {
      threadId,
      currentThread: { id: threadId, name: "Reasoning history" },
      status,
      history: {
        thread: {
          id: threadId,
          turns: [
            appServerTurnFixture({
              id: turnId,
              status,
              startedAt: startedAt / 1_000,
              completedAt: (startedAt + 10_000) / 1_000,
              items: [
                {
                  id: "stale-reasoning",
                  type: "reasoning",
                  status: "inProgress",
                  startedAt,
                  summary: ["Historical reasoning is still readable."],
                },
                {
                  id: "final-answer",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "The turn has ended.",
                },
              ],
            }),
          ],
        },
      },
    });

    await expandTurnSteps(page, turnId);
    const item = await expectStoppedReasoning(page, "stale-reasoning");
    await expect(item.getByTestId("reasoning-duration")).toHaveCount(0);
    await expect(item.getByTestId("reasoning-summary-content")).toContainText(
      "Historical reasoning is still readable.",
    );
  });
}

test("item completion timestamps override stale activity and missing timings stay absent", async ({
  page,
}) => {
  await openApp(page);
  const threadId = "reasoning-item-timing";
  await seedGatewayThread(page, {
    threadId,
    currentThread: { id: threadId, name: "Reasoning item timing" },
    status: "running",
    history: {
      thread: {
        id: threadId,
        turns: [
          appServerTurnFixture({
            id: "timing-turn",
            items: [
              {
                id: "timed-reasoning",
                type: "reasoning",
                status: "inProgress",
                startedAt,
                completedAt: startedAt + 4_250,
                summary: ["The native item has already completed."],
              },
              {
                id: "untimed-reasoning",
                type: "reasoning",
                status: "completed",
                startedAt,
                summary: ["Completion arrived without an item end time."],
              },
              {
                id: "active-reasoning",
                type: "reasoning",
                status: "inProgress",
                startedAt: Date.now() - 1_000,
                summary: ["The current item is active."],
              },
            ],
          }),
        ],
      },
    },
  });

  await expandTurnSteps(page, "timing-turn");
  const timed = await expectStoppedReasoning(page, "timed-reasoning");
  await expect(timed.getByTestId("reasoning-duration")).toHaveText("4.25s");
  const untimed = await expectStoppedReasoning(page, "untimed-reasoning");
  await expect(untimed.getByTestId("reasoning-duration")).toHaveCount(0);
  const active = reasoningItem(page, "active-reasoning");
  await revealVirtualizedChatLocator(page, active);
  await expect(active).toHaveAttribute("data-reasoning-state", "running");
  await expect(active.getByTestId("reasoning-spinner")).toBeVisible();
  await expect(active.getByText("思考中", { exact: true })).toBeVisible();
  await expect(active.getByTestId("reasoning-duration")).toBeVisible();
});

test("summary-only turn completion stops reasoning while compaction and a later turn keep running", async ({
  page,
}) => {
  await openApp(page);
  const threadId = "reasoning-live-completion";
  const turnId = "previous-turn";
  await seedGatewayThread(page, {
    threadId,
    currentThread: { id: threadId, name: "Reasoning live completion" },
    status: "running",
    history: {
      thread: {
        id: threadId,
        turns: [
          appServerTurnFixture({
            id: turnId,
            items: [
              {
                id: "previous-reasoning",
                type: "reasoning",
                status: "inProgress",
                startedAt,
                summary: ["A completion notification will omit this item."],
              },
              {
                id: "continuing-compaction",
                type: "contextCompaction",
                status: "inProgress",
                startedAt,
              },
            ],
          }),
        ],
      },
    },
  });
  await expect(reasoningItem(page, "previous-reasoning")).toHaveAttribute(
    "data-reasoning-state",
    "running",
  );
  await applyGatewayLiveEvent(
    page,
    gatewayEventFromNotification({
      id: 1,
      threadId,
      method: "turn/completed",
      params: {
        threadId,
        turn: appServerTurnFixture({ id: turnId, status: "completed", itemsView: "summary" }),
      },
    }),
  );
  await expandTurnSteps(page, turnId);
  const previous = await expectStoppedReasoning(page, "previous-reasoning");
  await expect(previous.getByTestId("reasoning-duration")).toHaveCount(0);
  const compaction = page.locator('[data-row-key$=":intermediate:continuing-compaction"]');
  await revealVirtualizedChatLocator(page, compaction);
  await expect(compaction.getByText("压缩上下文", { exact: true })).toBeVisible();
  await expect(compaction.locator(".animate-spin")).toBeVisible();
  await applyGatewayLiveEvent(
    page,
    gatewayEventFromNotification({
      id: 2,
      threadId,
      method: "turn/started",
      params: { threadId, turn: appServerTurnFixture({ id: "next-turn" }) },
    }),
  );
  for (const [index, itemId, targetTurnId] of [
    [3, "next-reasoning", "next-turn"],
    [4, "previous-reasoning", turnId],
    [5, "late-reasoning", turnId],
  ] as const) {
    await applyGatewayLiveEvent(
      page,
      gatewayEventFromNotification({
        id: index,
        threadId,
        method: "item/reasoning/summaryTextDelta",
        params: { threadId, turnId: targetTurnId, itemId, summaryIndex: 0, delta: " Updated." },
      }),
    );
  }
  await expandTurnSteps(page, turnId);
  await expectStoppedReasoning(page, "previous-reasoning");
  const late = await expectStoppedReasoning(page, "late-reasoning");
  await expect(late.getByTestId("reasoning-duration")).toHaveCount(0);
  await expandTurnSteps(page, "next-turn");
  const next = reasoningItem(page, "next-reasoning");
  await revealVirtualizedChatLocator(page, next);
  await expect(next).toHaveAttribute("data-reasoning-state", "running");
  await expect(next.getByTestId("reasoning-spinner")).toBeVisible();
  await expect.poll(() => selectedThreadStatusInStore(page)).toBe("running");
});

test("native reasoning is stopped after model completion and restored history", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  await nameForkSource(page, scope, "Native reasoning lifecycle regression");
  const turnId = await sendCompletedForkTurn(
    page,
    "Without tools, calculate 12347 * 6789 + 2468 * 1357. Check your arithmetic, then reply with only the result.",
  );
  const timeline = await nativeForkTimeline(page, scope);
  const reasoningIds = timeline.entries.flatMap((entry) =>
    entry.type === "item" && entry.turnId === turnId && entry.item.type === "reasoning"
      ? [entry.item.id]
      : [],
  );
  // Empty/encrypted summaries are valid, but an absent reasoning item must not pass this test.
  expect(
    reasoningIds.length,
    "The real model must emit at least one reasoning item",
  ).toBeGreaterThan(0);
  await expandTurnSteps(page, turnId);
  for (const itemId of reasoningIds) await expectStoppedReasoning(page, itemId);
  await reloadApp(page);
  await expandTurnSteps(page, turnId);
  for (const itemId of reasoningIds) await expectStoppedReasoning(page, itemId);
  await page.screenshot({ path: test.info().outputPath("native-reasoning-after-reload.png") });
});
