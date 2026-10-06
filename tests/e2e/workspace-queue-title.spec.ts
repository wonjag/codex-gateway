import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp, reloadApp } from "./helpers/app";
import { execRemoteSsh } from "./helpers/remote-codex";
import { sendRealtimeRequest } from "./helpers/realtime";
import { installRealtimeSocketProbe } from "./helpers/realtime-socket-probe";

// These tests use actual SSH/app-server threads. Delaying HTTP delivery below does not replace
// its response or mutate application stores; it exposes the old-list rendering window.
test("workspace switches clear stale lists, including a failed destination request", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(240_000);
  await openApp(page);
  const { host, project: a } = await remoteWorkspace.provision();
  const aThread = await remoteWorkspace.startThread(a.id);
  const directory = `/tmp/gateway-project-${randomUUID()}`;
  await execRemoteSsh(remoteWorkspace.remote, `mkdir -p '${directory}'`);
  const b = await remoteWorkspace.addProject(host.id, "Isolated workspace", directory);
  const bThread = await remoteWorkspace.startThread(b.id);
  await page.getByTestId(`project-button-${a.id}`).click();
  await expect(page.getByTestId(`project-thread-row-${aThread}`)).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/threads?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("projectId") === String(b.id)) {
      await gate;
      await route.abort("failed");
    } else await route.continue();
  });
  try {
    await page.getByTestId(`project-button-${b.id}`).click();
    await expect(page.getByTestId("project-thread-list")).toContainText("Isolated workspace");
    await expect(page.getByTestId(`project-thread-row-${aThread}`)).toHaveCount(0);
    release();
    await expect
      .poll(() => page.evaluate(() => window.__codexGatewayE2e?.views.loading))
      .toBe(false);
    await expect(page.getByTestId(`project-thread-row-${aThread}`)).toHaveCount(0);
  } finally {
    release();
    await page.unroute("**/api/threads?**");
  }
  const list = await authenticatedFetch(
    page,
    { url: `/api/threads?hostId=${host.id}&projectId=${b.id}` },
    (value) =>
      z.object({ data: z.array(z.object({ id: z.string(), cwd: z.string() })) }).parse(value),
  );
  expect(list.data.map((thread) => thread.id)).toContain(bThread);
  expect(list.data.every((thread) => thread.cwd === directory)).toBe(true);
  await page.getByTestId(`project-button-${a.id}`).click();
  await page.getByTestId(`project-button-${b.id}`).click();
  await expect(page.getByTestId(`project-thread-row-${bThread}`)).toBeVisible();
  await expect(page.getByTestId(`project-thread-row-${aThread}`)).toHaveCount(0);
});

test("queued prompts survive reload, synchronize across pages, and run as a later turn", async ({
  page,
  browser,
  remoteWorkspace,
}) => {
  test.setTimeout(12 * 60_000);
  await installRealtimeSocketProbe(page);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const first = `FIRST_DONE_${Date.now()}`;
  const second = `SECOND_DONE_${Date.now()}`;
  await page
    .getByPlaceholder("输入后续修改要求")
    .fill(
      `Run the shell command sleep 90, then reply exactly ${first}. Wait for the command to finish.`,
    );
  await page.getByTestId("send-turn-button").click();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__codexGatewayE2e?.views.events.some(
            (event) =>
              event.event.type === "timeline.item.upsert" &&
              event.event.item.type === "commandExecution" &&
              event.event.item.status === "inProgress",
          ),
        ),
      { timeout: 180_000 },
    )
    .toBe(true);
  const firstTurnId = await page.evaluate(
    ({ hostId, threadId }) =>
      window.__codexGatewayE2e?.runtime.activeTurnIdsByThreadKey[`${hostId}:${threadId}`],
    { hostId: host.id, threadId },
  );
  await page.getByPlaceholder("输入后续修改要求").fill(`Reply exactly ${second}.`);
  await page.getByTestId("send-turn-button").click();
  await expect(page.getByTestId("turn-queue")).toContainText(second);
  const list = await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: "list",
    hostId: host.id,
    threadId,
    action: "list",
  });
  if (list.type !== "turn.queue.snapshot") throw new Error("Missing queue snapshot");
  expect(list.entries).toHaveLength(1);
  const id = list.entries[0]!.id;
  // A retried enqueue carries the same id and must not create another pending turn.
  await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: "retry",
    hostId: host.id,
    threadId,
    action: "enqueue",
    input: {
      hostId: host.id,
      threadId,
      projectId: project.id,
      text: `Reply exactly ${second}.`,
      clientUserMessageId: id,
    },
  });
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const otherPage = await other.newPage();
  try {
    await openApp(otherPage, { resetConfig: false });
    await expect(otherPage.getByTestId("turn-queue")).toContainText(second);
    const cancelId = randomUUID();
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: "extra",
      hostId: host.id,
      threadId,
      action: "enqueue",
      input: {
        hostId: host.id,
        threadId,
        projectId: project.id,
        text: "This message will be cancelled",
        clientUserMessageId: cancelId,
      },
    });
    await sendRealtimeRequest(otherPage, {
      type: "turn.queue",
      requestId: "cancel",
      hostId: host.id,
      threadId,
      action: "cancel",
      id: cancelId,
    });
    await expect(page.getByTestId("turn-queue")).not.toContainText(
      "This message will be cancelled",
    );
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: "edit",
      hostId: host.id,
      threadId,
      action: "edit",
      id,
      text: `Reply exactly ${second}, with no tools.`,
    });
    await expect(otherPage.getByTestId("turn-queue")).toContainText("with no tools");
    await reloadApp(page);
    await expect(page.getByTestId("turn-queue")).toContainText(second);
    await expect
      .poll(
        () =>
          page.evaluate((marker) => {
            const turns = window.__codexGatewayE2e?.views.history?.thread.turns ?? [];
            return turns
              .filter((turn) =>
                turn.items.some(
                  (item) => item.type === "agentMessage" && (item.text ?? "").includes(marker),
                ),
              )
              .map((turn) => turn.id);
          }, second),
        { timeout: 240_000 },
      )
      .toHaveLength(1);
    const completedTurns = await page.evaluate(
      () =>
        window.__codexGatewayE2e?.views.history?.thread.turns.map((turn) => ({
          id: turn.id,
          status: turn.status,
        })) ?? [],
    );
    expect(completedTurns.find((turn) => turn.id === firstTurnId)?.status).toBe("completed");
    expect(
      completedTurns.filter((turn) => turn.status === "completed").length,
    ).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("turn-queue")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.__gatewayRealtimeProbe?.messages.some(
          (message) => message.type === "turn.steer" || message.type === "turn.interrupt",
        ),
      ),
    ).toBe(false);
  } finally {
    await other.close();
  }
});

test("title suggestions summarize real history without overwriting a manual title", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(8 * 60_000);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  await page
    .getByPlaceholder("输入后续修改要求")
    .fill("请用一句话说明如何修复工作空间切换后显示旧会话列表的问题，不要调用工具。");
  await page.getByTestId("send-turn-button").click();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__codexGatewayE2e?.views.history?.thread.turns.some(
            (turn) => turn.status === "completed",
          ),
        ),
      { timeout: 180_000 },
    )
    .toBe(true);
  const manual = "用户人工设置的标题，不应被后台摘要任务覆盖";
  await page.evaluate(
    async ({ hostId, threadId, name }) => {
      await window.__codexGatewayE2e?.navigation.renameThread(hostId, threadId, name);
    },
    { hostId: host.id, threadId, name: manual },
  );
  await page.getByTestId(`thread-button-${threadId}`).click({ button: "right" });
  await page.getByRole("menuitem", { name: /重命名|Rename/ }).click();
  await page.getByTestId("generate-thread-title").click();
  await expect(page.getByTestId("rename-thread-input")).not.toHaveValue(manual, {
    timeout: 120_000,
  });
  const suggestion = await page.getByTestId("rename-thread-input").inputValue();
  expect(suggestion.length).toBeGreaterThan(0);
  expect(suggestion.length).toBeLessThanOrEqual(48);
  await page
    .getByTestId("rename-thread-dialog")
    .getByRole("button", { name: /取消|Cancel/ })
    .click();
  await reloadApp(page);
  await expect(page.getByTestId(`thread-button-${threadId}`)).toContainText(manual);
});
