import { randomUUID } from "node:crypto";
import { devices, type Page } from "@playwright/test";
import { quote } from "shell-quote";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp, reloadApp } from "./helpers/app";
import { execRemoteSsh, type RemoteCodexEnv } from "./helpers/remote-codex";
import { sendRealtimeRawRequest, sendRealtimeRequest } from "./helpers/realtime";
import { installRealtimeSocketProbe } from "./helpers/realtime-socket-probe";

test("inserts a selected queued prompt into the native turn without cancelling its command", async ({
  browser,
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(12 * 60_000);
  await installRealtimeSocketProbe(page);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  const root = `/tmp/gateway-insertion-${randomUUID()}`;
  const commandMarker = `COMMAND_DONE_${randomUUID()}`;
  const insertedMarker = `INSERTED_${randomUUID()}`;
  const laterMarker = `LATER_${randomUUID()}`;
  const laterId = randomUUID();
  const insertedId = randomUUID();
  await createGatedCommand(remoteWorkspace.remote, root, commandMarker);

  // Finish navigation before starting the command, so mobile setup cannot consume the real
  // tool's blocking window. Both pages share the production Gateway WebSocket/SSH lifecycle.
  const mobileContext = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width: 375, height: 812 },
    storageState: await page.context().storageState(),
  });
  const mobile = await mobileContext.newPage();
  await installRealtimeSocketProbe(mobile);
  try {
    await openApp(mobile, { resetConfig: false });
    await expect(mobile.getByTestId("mobile-layout")).toBeVisible();
    await expect
      .poll(() => mobile.evaluate(() => window.__codexGatewayE2e?.navigation.selectedThreadId))
      .toBe(threadId);
    await page
      .getByPlaceholder("输入后续修改要求")
      .fill(
        [
          `Run this exact command once: bash ${root}/command.sh`,
          "Use a blocking shell tool with timeout_ms 150000 if available; for exec_command use yield_time_ms 30000.",
          "The command waits for an external test controller. Do not modify its script or files, release it yourself, kill it, or run it again.",
          "If the tool yields a session or cell, keep waiting for the original command until it finishes.",
          `Only after its output contains ${commandMarker}, briefly acknowledge completion. Follow any later user instruction about the final response.`,
        ].join("\n"),
      );
    await page.getByTestId("send-turn-button").click();
    await expect.poll(() => activeTurnId(page, scope), { timeout: 60_000 }).not.toBe("");
    const originalTurnId = await activeTurnId(page, scope);
    await enqueue(laterId, `Reply exactly ${laterMarker}, without tools.`);
    await enqueue(
      insertedId,
      `Keep waiting for the original command to finish without cancelling or restarting it. After its output confirms completion, reply exactly ${insertedMarker}, without any further tools.`,
    );
    await expect(mobile.getByTestId("turn-queue")).toContainText(insertedMarker);
    await expect
      .poll(() => commandState(remoteWorkspace.remote, root), {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
      })
      .toBe("running");

    // Exercise the native expected-turn rejection while a different real turn is active.
    // A rejected insertion must leave both entries eligible for normal FIFO delivery.
    const rejected = await sendRealtimeRawRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "insert",
      id: insertedId,
      expectedTurnId: randomUUID(),
    });
    expect(rejected.type).toBe("error");
    if (rejected.type !== "error") throw new Error("Expected a native stale-turn rejection");
    expect(rejected.message).toMatch(/expected active turn id/);
    expect(await list()).toEqual([
      expect.objectContaining({ id: laterId, status: "waiting" }),
      expect.objectContaining({ id: insertedId, status: "waiting" }),
    ]);
    expect(await activeTurnId(page, scope)).toBe(originalTurnId);
    expect(await commandState(remoteWorkspace.remote, root)).toBe("running");

    const mobileQueue = mobile.getByTestId("turn-queue");
    const selectedRow = mobileQueue.locator("[data-queue-status]").filter({
      hasText: insertedMarker,
    });
    const insertButton = selectedRow.getByRole("button", {
      name: "插入当前任务",
      exact: true,
    });
    await expect(insertButton).toBeEnabled();
    await insertButton.scrollIntoViewIfNeeded();
    await expect(insertButton).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() => mobileQueue.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await mobile.screenshot({ path: test.info().outputPath("mobile-queued-insertion.png") });
    await insertButton.click();

    // A second page can retry before or after the first ACK. The queue ID must still represent
    // one native submission; the authoritative rollout below detects duplicates hidden by UI
    // reconciliation of identical client IDs.
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "insert",
      id: insertedId,
      expectedTurnId: originalTurnId,
    });
    await expect(page.getByTestId("turn-queue")).not.toContainText(insertedMarker);
    await expect(mobileQueue).not.toContainText(insertedMarker);
    expect(await list()).toEqual([expect.objectContaining({ id: laterId, status: "waiting" })]);
    expect(await activeTurnId(page, scope)).toBe(originalTurnId);
    expect(await activeTurnId(mobile, scope)).toBe(originalTurnId);
    expect(await commandState(remoteWorkspace.remote, root)).toBe("running");
    expect(await hasInterrupt(page)).toBe(false);
    expect(await hasInterrupt(mobile)).toBe(false);
    expect(
      await mobile.evaluate(
        (id) =>
          window.__gatewayRealtimeProbe?.messages.filter(
            (message) =>
              message.type === "turn.queue" && message.action === "insert" && message.id === id,
          ).length,
        insertedId,
      ),
    ).toBe(1);

    // Process liveness and completion are checked over real SSH. An exec tool can return a
    // running session/cell before its process ends, so an inProgress UI item alone is insufficient
    // evidence that insertion preserved the work. No assumption about model-stream preemption
    // or the instant_interrupt feature is needed here.
    await execRemoteSsh(remoteWorkspace.remote, `touch ${quote([`${root}/release`])}`);
    await expect
      .poll(() => commandState(remoteWorkspace.remote, root), { timeout: 30_000 })
      .toBe("completed");
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__codexGatewayE2e?.views.history?.thread.turns.find((turn) => turn.id === id)
                ?.status,
            originalTurnId,
          ),
        { timeout: 240_000 },
      )
      .toBe("completed");
    expect(
      await nativeUserMessageCounts(remoteWorkspace.remote, threadId, [insertedMarker]),
    ).toEqual([1]);
    for (const client of [page, mobile]) {
      await expect
        .poll(() => completedReplyTurnIds(client, insertedMarker), { timeout: 30_000 })
        .toEqual([originalTurnId]);
      await expect
        .poll(() => completedReplyTurnIds(client, laterMarker), { timeout: 240_000 })
        .toHaveLength(1);
      expect((await completedReplyTurnIds(client, laterMarker))[0]).not.toBe(originalTurnId);
      await expect(client.getByTestId("turn-queue")).toHaveCount(0);
      expect(await hasInterrupt(client)).toBe(false);
    }

    const nativeCounts = await nativeUserMessageCounts(remoteWorkspace.remote, threadId, [
      insertedMarker,
      laterMarker,
    ]);
    expect(nativeCounts).toEqual([1, 1]);
    const commandResult = await execRemoteSsh(
      remoteWorkspace.remote,
      `test ! -e ${quote([`${root}/cancelled`])} && cat ${quote([`${root}/completed`])}`,
    );
    expect(commandResult.stdout.trim()).toBe(commandMarker);
    const launches = await execRemoteSsh(
      remoteWorkspace.remote,
      `cat ${quote([`${root}/launches`])}`,
    );
    expect(launches.stdout.trim().split("\n")).toHaveLength(1);
    await reloadApp(page);
    await expect
      .poll(() => completedReplyTurnIds(page, insertedMarker), { timeout: 30_000 })
      .toEqual([originalTurnId]);
    await expect(page.getByTestId("turn-queue")).toHaveCount(0);
  } finally {
    // Preserve native delivery evidence even if the model ignores the requested final response.
    // UI user bubbles alone can be optimistic and cannot establish native input consumption.
    const diagnostics = {
      model: remoteWorkspace.remote.testModel,
      command: await commandState(remoteWorkspace.remote, root).catch(() => null),
      nativeInputCounts: await nativeUserMessageCounts(remoteWorkspace.remote, threadId, [
        insertedMarker,
        laterMarker,
      ]).catch(() => null),
      turns: await page
        .evaluate(() =>
          (window.__codexGatewayE2e?.views.history?.thread.turns ?? []).map((turn) => ({
            id: turn.id,
            status: turn.status,
            replies: turn.items
              .filter((item) => item.type === "agentMessage")
              .map((item) => item.text),
          })),
        )
        .catch(() => null),
    };
    await test.info().attach("native-insertion-diagnostics", {
      body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
      contentType: "application/json",
    });
    // Unblock the test's own command on an assertion failure; never kill an app-server or replace
    // native protocol responses to make the integration assertions pass.
    await execRemoteSsh(remoteWorkspace.remote, `touch ${quote([`${root}/release`])}`).catch(
      () => undefined,
    );
    await mobileContext.close();
  }

  async function enqueue(id: string, text: string) {
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "enqueue",
      input: { ...scope, projectId: project.id, text, clientUserMessageId: id },
    });
  }

  async function list() {
    const response = await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "list",
    });
    if (response.type !== "turn.queue.snapshot") throw new Error("Expected a queue snapshot");
    return response.entries;
  }
});

test("keeps the remaining queue paused when a user stops a turn during insertion", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(8 * 60_000);
  await installRealtimeSocketProbe(page);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  const root = `/tmp/gateway-stop-insertion-${randomUUID()}`;
  const selectedId = randomUUID();
  const remainingId = randomUUID();
  const remainingMarker = `MUST_STAY_QUEUED_${randomUUID()}`;
  await createGatedCommand(remoteWorkspace.remote, root, `STOP_COMMAND_${randomUUID()}`);
  try {
    await page
      .getByPlaceholder("输入后续修改要求")
      .fill(
        [
          `Run this exact command once: bash ${root}/command.sh`,
          "Use a blocking shell tool with timeout_ms 150000 if available; for exec_command use yield_time_ms 30000.",
          "The test controller will release or stop it. Do not change its files, release it yourself, or restart it.",
          "If it yields a session or cell, keep waiting for the original command. Do not finish before the command completes.",
        ].join("\n"),
      );
    await page.getByTestId("send-turn-button").click();
    await expect.poll(() => activeTurnId(page, scope), { timeout: 60_000 }).not.toBe("");
    const originalTurnId = await activeTurnId(page, scope);
    for (const [id, text] of [
      [remainingId, `Reply exactly ${remainingMarker}, without tools.`],
      [selectedId, "Keep waiting for the original command without starting any other work."],
    ] as const) {
      await sendRealtimeRequest(page, {
        type: "turn.queue",
        requestId: randomUUID(),
        ...scope,
        action: "enqueue",
        input: { ...scope, projectId: project.id, text, clientUserMessageId: id },
      });
    }
    await expect
      .poll(() => commandState(remoteWorkspace.remote, root), {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
      })
      .toBe("running");

    // Both calls cross the real Gateway and app-server. Either native request may win: an
    // insertion can be accepted before the stop, or rejected/paused after it. Neither ordering
    // permits the other queued prompt to start automatically after this explicit user stop.
    const [insertion, interruption] = await Promise.all([
      sendRealtimeRawRequest(page, {
        type: "turn.queue",
        requestId: randomUUID(),
        ...scope,
        action: "insert",
        id: selectedId,
        expectedTurnId: originalTurnId,
      }),
      sendRealtimeRequest(page, {
        type: "turn.interrupt",
        requestId: randomUUID(),
        ...scope,
        turnId: originalTurnId,
      }),
    ]);
    expect(["turn.queue.snapshot", "error"]).toContain(insertion.type);
    expect(interruption.type).toBe("turn.interrupt.accepted");
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__codexGatewayE2e?.views.history?.thread.turns.find((turn) => turn.id === id)
                ?.status,
            originalTurnId,
          ),
        { timeout: 60_000 },
      )
      .toBe("interrupted");
    const remainingRow = page
      .getByTestId("turn-queue")
      .locator("[data-queue-status]")
      .filter({ hasText: remainingMarker });
    await expect(remainingRow).toHaveAttribute("data-queue-status", "paused");

    // Observe more than three normal worker intervals. Checking immediately after the stop
    // would miss a worker that resumes and starts the forgotten entry on its next idle probe.
    for (let interval = 0; interval < 3; interval += 1) {
      await page.waitForTimeout(2_100);
      const snapshot = await sendRealtimeRequest(page, {
        type: "turn.queue",
        requestId: randomUUID(),
        ...scope,
        action: "list",
      });
      if (snapshot.type !== "turn.queue.snapshot") throw new Error("Expected a queue snapshot");
      expect(snapshot.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: remainingId, status: "paused" })]),
      );
      expect(await activeTurnId(page, scope)).toBe("");
      expect(
        await nativeUserMessageCounts(remoteWorkspace.remote, threadId, [remainingMarker]),
      ).toEqual([0]);
    }
    expect(await hasInterrupt(page)).toBe(true);
    await remainingRow.getByRole("button", { name: "移除", exact: true }).click();
    await expect(remainingRow).toHaveCount(0);
    const afterRemoval = await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "list",
    });
    if (afterRemoval.type !== "turn.queue.snapshot") throw new Error("Expected a queue snapshot");
    expect(afterRemoval.entries.some((entry) => entry.id === remainingId)).toBe(false);
    expect(
      await nativeUserMessageCounts(remoteWorkspace.remote, threadId, [remainingMarker]),
    ).toEqual([0]);
  } finally {
    // An intentional user stop may cancel the shell or leave an already yielded process alive.
    // Release only this test's gate; cancellation is permitted in this scenario.
    await execRemoteSsh(remoteWorkspace.remote, `touch ${quote([`${root}/release`])}`).catch(
      () => undefined,
    );
  }
});

async function createGatedCommand(remote: RemoteCodexEnv, root: string, marker: string) {
  const script = [
    "#!/usr/bin/env bash",
    "set -eu",
    `work=${quote([root])}`,
    "trap 'printf cancelled > \"$work/cancelled\"; exit 143' INT TERM HUP",
    'printf "%s\\n" "$$" >> "$work/launches"',
    'printf %s "$$" > "$work/started"',
    "for attempt in $(seq 1 1200); do",
    '  if [ -e "$work/release" ]; then',
    `    printf '%s\\n' ${quote([marker])} > "$work/completed"`,
    '    cat "$work/completed"',
    "    exit 0",
    "  fi",
    "  sleep 0.1",
    "done",
    'printf timeout > "$work/timed-out"',
    "exit 1",
    "",
  ].join("\n");
  await execRemoteSsh(
    remote,
    `mkdir -p ${quote([root])} && printf %s ${quote([script])} > ${quote([`${root}/command.sh`])}`,
  );
}

async function commandState(remote: RemoteCodexEnv, root: string) {
  const { stdout } = await execRemoteSsh(
    remote,
    `work=${quote([root])}
if [ -e "$work/cancelled" ]; then printf cancelled
elif [ -e "$work/timed-out" ]; then printf timeout
elif [ -e "$work/completed" ]; then printf completed
elif [ -s "$work/started" ] && kill -0 "$(cat "$work/started")" 2>/dev/null; then printf running
else printf pending
fi`,
  );
  return stdout.trim();
}

async function activeTurnId(page: Page, scope: { hostId: number; threadId: string }) {
  return page.evaluate(
    ({ hostId, threadId }) =>
      window.__codexGatewayE2e?.runtime.activeTurnIdsByThreadKey[`${hostId}:${threadId}`] ?? "",
    scope,
  );
}

async function completedReplyTurnIds(page: Page, marker: string) {
  return page.evaluate(
    (marker) =>
      (window.__codexGatewayE2e?.views.history?.thread.turns ?? [])
        .filter(
          (turn) =>
            turn.status === "completed" &&
            turn.items.some(
              (item) => item.type === "agentMessage" && (item.text ?? "").includes(marker),
            ),
        )
        .map((turn) => turn.id),
    marker,
  );
}

async function hasInterrupt(page: Page) {
  return page.evaluate(
    () =>
      window.__gatewayRealtimeProbe?.messages.some(
        (message) => message.type === "turn.interrupt",
      ) ?? false,
  );
}

async function nativeUserMessageCounts(
  remote: RemoteCodexEnv,
  threadId: string,
  markers: string[],
) {
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const threadId = ${JSON.stringify(threadId)};
const markers = ${JSON.stringify(markers)};
const root = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'sessions');
const file = fs.readdirSync(root, { recursive: true }).find(name => name.endsWith('-' + threadId + '.jsonl'));
if (!file) throw new Error('Native rollout was not found');
const userItems = fs.readFileSync(path.join(root, file), 'utf8').trim().split('\\n')
  .map(line => JSON.parse(line))
  .filter(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user');
const texts = userItems.map(row => (row.payload.content || []).map(item => item.text || '').join('\\n'));
process.stdout.write(JSON.stringify(markers.map(marker => texts.filter(text => text.includes(marker)).length)));
`;
  const { stdout } = await execRemoteSsh(
    remote,
    quote(["/opt/codex-preview-runtime/bin/node", "-e", script]),
  );
  return z.array(z.number().int().nonnegative()).parse(JSON.parse(stdout));
}
