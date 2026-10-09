import { randomUUID } from "node:crypto";
import { devices } from "@playwright/test";
import { quote } from "shell-quote";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp, reloadApp } from "./helpers/app";
import { execRemoteSsh, waitForSelectedThreadId } from "./helpers/remote-codex";
import { sendRealtimeRawRequest, sendRealtimeRequest } from "./helpers/realtime";
import {
  closeRealtimeSockets,
  installRealtimeSocketProbe,
  realtimeClientMessageCount,
} from "./helpers/realtime-socket-probe";
import {
  forkGoal,
  forkOperation,
  forkQueue,
  forkSettings,
  forkStatus,
  nameForkSource,
  nativeForkTimeline,
  openForkThread,
  sendCompletedForkTurn,
  timelineTurnIds,
  waitForCreatedFork,
} from "./helpers/thread-fork";

// All conversations, tools, IDs, pagination and compaction below come from the actual SSH/Codex
// fixture. A delayed WebSocket delivery in the second test preserves the real server response.
test("forks a historical native turn with tools, preserves the prefix and independent sessions", async ({
  page,
  browser,
  remoteWorkspace,
}) => {
  test.setTimeout(12 * 60_000);
  await installRealtimeSocketProbe(page);
  // This test exercises the native browser close/reconnect handshake.
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const parent = { hostId: host.id, threadId };
  const title = "Historical fork regression";
  await nameForkSource(page, parent, title);
  const aMarker = `PREFIX_A_${randomUUID()}`;
  const bMarker = `PREFIX_B_${randomUUID()}`;
  const cMarker = `EXCLUDED_C_${randomUUID()}`;
  const childMarker = `CHILD_ONLY_${randomUUID()}`;
  const parentMarker = `PARENT_ONLY_${randomUUID()}`;
  const evidenceFile = `/tmp/gateway-fork-once-${randomUUID()}`;
  const a = await sendCompletedForkTurn(page, `Reply exactly ${aMarker}. Do not use tools.`);
  const b = await sendCompletedForkTurn(
    page,
    `Execute this command once: printf '%s\\n' ${quote([bMarker])} >> ${quote([evidenceFile])}. Then reply exactly ${bMarker}.`,
  );
  const c = await sendCompletedForkTurn(page, `Reply exactly ${cMarker}. Do not use tools.`);
  const pausedGoal = await sendRealtimeRequest(page, {
    type: "thread.goal.set",
    requestId: randomUUID(),
    ...parent,
    objective: `A goal added after the fork boundary: ${cMarker}`,
    status: "paused",
  });
  expect(pausedGoal.type).toBe("thread.goal.updated");

  // Use real small native pages, so the historical ID is tested after following a cursor rather
  // than only being present in a browser's live optimistic timeline.
  const original = await nativeForkTimeline(page, parent, 3);
  const sourceSettings = await forkSettings(page, parent);
  expect(typeof sourceSettings.model).toBe("string");
  if (remoteWorkspace.remote.testModel !== undefined)
    expect(sourceSettings.model).toBe(remoteWorkspace.remote.testModel);
  expect(original.pageCount).toBeGreaterThan(1);
  expect(timelineTurnIds(original.entries)).toEqual([a, b, c]);
  expect(
    original.entries.some(
      (entry) =>
        entry.type === "item" && entry.turnId === b && entry.item.type === "commandExecution",
    ),
  ).toBe(true);
  await page.getByTestId(`thread-fork-${b}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`thread-fork-${b}`).click();
  const childId = await waitForSelectedThreadId(page, threadId);
  const child = { hostId: host.id, threadId: childId };
  await expect(page.getByPlaceholder("输入后续修改要求")).toBeFocused();
  await expect(page.getByTestId(`thread-button-${childId}`)).toContainText(`${title} · 分支`);
  await expect(page.getByTestId("thread-fork-origin")).toHaveAttribute(
    "data-fork-source-thread",
    threadId,
  );
  await expect(page.getByTestId("thread-fork-origin")).toHaveAttribute("data-fork-source-turn", b);
  const childSettings = await forkSettings(page, child);
  expect(childSettings.model).toBe(sourceSettings.model);
  expect(childSettings.effort ?? null).toBe(sourceSettings.effort ?? null);
  await test.info().attach("native-fork-model-settings", {
    body: Buffer.from(
      JSON.stringify({
        requested: remoteWorkspace.remote.testModel,
        source: { model: sourceSettings.model, effort: sourceSettings.effort },
        child: { model: childSettings.model, effort: childSettings.effort },
      }),
    ),
    contentType: "application/json",
  });
  await test.info().attach("desktop-historical-fork", {
    body: await page.screenshot({ path: test.info().outputPath("desktop-historical-fork.png") }),
    contentType: "image/png",
  });
  const request = await page.evaluate(() =>
    window.__gatewayRealtimeProbe?.messages.find((message) => message.type === "thread.fork"),
  );
  const operationId = z.object({ operationId: z.string() }).parse(request).operationId;
  const operation = await forkStatus(page, host.id, operationId);
  expect(operation).toMatchObject({
    status: "created",
    sourceThreadId: threadId,
    lastTurnId: b,
    threadId: childId,
    projectId: project.id,
  });
  const retained = await nativeForkTimeline(page, child, 3);
  expect(timelineTurnIds(retained.entries)).toEqual([a, b]);
  expect(JSON.stringify(retained.entries)).toContain(bMarker);
  expect(JSON.stringify(retained.entries)).not.toContain(cMarker);
  expect(await forkGoal(page, child)).toBeNull();
  expect(await forkQueue(page, child)).toEqual([]);
  expect(await forkGoal(page, parent)).toMatchObject({ status: "paused" });
  expect(
    await page.evaluate(() => window.__codexGatewayE2e?.views.currentThread?.parentThreadId),
  ).toBeNull();
  expect(
    await page.evaluate(() => window.__codexGatewayE2e?.views.currentThread?.forkedFromId),
  ).toBe(threadId);

  // Concurrent retries share the native child. A changed boundary with the same operation ID
  // must fail instead of silently returning a branch from a different location.
  const retries = await Promise.all([
    forkOperation(page, parent, b, operationId),
    forkOperation(page, parent, b, operationId),
  ]);
  expect(retries.map((retry) => retry.threadId)).toEqual([childId, childId]);
  const changedBoundary = await sendRealtimeRawRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    ...parent,
    lastTurnId: a,
    operationId,
  });
  expect(changedBoundary.type).toBe("error");
  const missing = await forkOperation(page, parent, randomUUID());
  expect(missing).toMatchObject({ status: "failed", threadId: null });

  const childTurn = await sendCompletedForkTurn(
    page,
    `Reply exactly ${childMarker}. Do not use tools.`,
  );
  expect(timelineTurnIds((await nativeForkTimeline(page, child)).entries)).toEqual([
    a,
    b,
    childTurn,
  ]);
  // Fork must not replay the historical command, and the ordinary next turn must be usable even
  // though forked root threads do not expose experimental per-response amount events.
  const launches = await execRemoteSsh(remoteWorkspace.remote, `cat ${quote([evidenceFile])}`);
  expect(launches.stdout.trim().split("\n")).toEqual([bMarker]);
  await reloadApp(page);
  await expect(page.getByTestId(`thread-button-${childId}`)).toContainText(`${title} · 分支`);
  await expect(page.getByTestId("thread-fork-origin")).toHaveAttribute("data-fork-source-turn", b);
  const reconnectMessageOffset = await realtimeClientMessageCount(page);
  const previousReadyCount = await page.evaluate(
    () => window.__codexGatewayE2e?.realtime.readyCount ?? 0,
  );
  await closeRealtimeSockets(page);
  await expect
    .poll(
      () =>
        page.evaluate((readyCount) => {
          const realtime = window.__codexGatewayE2e?.realtime;
          return (
            realtime !== undefined &&
            realtime.connected &&
            realtime.readyCount > readyCount &&
            realtime.socket?.readyState === WebSocket.OPEN
          );
        }, previousReadyCount),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ offset, hostId, threadId }) =>
            window.__gatewayRealtimeProbe?.messages
              .slice(offset)
              .some(
                (message) =>
                  message.type === "thread.subscribe" &&
                  message.hostId === hostId &&
                  message.threadId === threadId,
              ) ?? false,
          { offset: reconnectMessageOffset, hostId: host.id, threadId: childId },
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(await forkStatus(page, host.id, operationId)).toMatchObject({
    status: "created",
    threadId: childId,
  });
  await expect(page.getByPlaceholder("输入后续修改要求")).toBeEnabled();

  const mobileContext = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width: 375, height: 812 },
    storageState: await page.context().storageState(),
  });
  try {
    const mobile = await mobileContext.newPage();
    await openApp(mobile, { resetConfig: false });
    await expect(mobile.getByTestId("thread-fork-origin")).toHaveAttribute(
      "data-fork-source-thread",
      threadId,
    );
    await expect(mobile.getByTestId("thread-fork-source")).toBeInViewport();
    expect(
      await mobile
        .getByTestId("thread-fork-origin")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await test.info().attach("mobile-fork-origin", {
      body: await mobile.screenshot({ path: test.info().outputPath("mobile-fork-origin.png") }),
      contentType: "image/png",
    });
  } finally {
    await mobileContext.close();
  }

  await page.getByTestId("thread-fork-source").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("threadId")).toBe(threadId);
  const createsBeforeRecovery = await page.evaluate(
    () =>
      window.__gatewayRealtimeProbe?.messages.filter((message) => message.type === "thread.fork")
        .length ?? 0,
  );
  await page.getByTestId(`thread-fork-${b}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`thread-fork-${b}`).click();
  expect(await waitForSelectedThreadId(page, threadId)).toBe(childId);
  expect(
    await page.evaluate(
      () =>
        window.__gatewayRealtimeProbe?.messages.filter((message) => message.type === "thread.fork")
          .length ?? 0,
    ),
  ).toBe(createsBeforeRecovery);
  expect(await forkStatus(page, host.id, operationId)).toMatchObject({ threadId: childId });

  const manualBranchTitle = "Manually named branch";
  await nameForkSource(page, child, manualBranchTitle);
  await forkStatus(page, host.id, operationId);
  await reloadApp(page);
  await expect(page.getByTestId(`thread-button-${childId}`)).toContainText(manualBranchTitle);
  await expect(page.getByTestId("thread-fork-origin")).toHaveAttribute("data-fork-source-turn", b);
  await page.getByTestId("thread-fork-source").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("threadId")).toBe(threadId);
  await sendRealtimeRequest(page, {
    type: "thread.goal.clear",
    requestId: randomUUID(),
    ...parent,
  });
  const parentTurn = await sendCompletedForkTurn(
    page,
    `Reply exactly ${parentMarker}. Do not use tools.`,
  );
  const updatedParent = await nativeForkTimeline(page, parent);
  expect(timelineTurnIds(updatedParent.entries)).toEqual([a, b, c, parentTurn]);
  expect(JSON.stringify(updatedParent.entries)).not.toContain(childMarker);
  expect(JSON.stringify((await nativeForkTimeline(page, child)).entries)).not.toContain(
    parentMarker,
  );

  // First-turn and latest-turn boundaries, and forking an existing branch, need no additional
  // model calls. Each result is checked through native pagination after normal activation.
  for (const [source, boundary, expected] of [
    [parent, a, [a]],
    [parent, parentTurn, [a, b, c, parentTurn]],
    [child, b, [a, b]],
  ] as const) {
    const branch = await waitForCreatedFork(page, await forkOperation(page, source, boundary));
    await openForkThread(page, { hostId: host.id, threadId: branch.threadId }, project.id);
    const history = await nativeForkTimeline(page, { hostId: host.id, threadId: branch.threadId });
    expect(timelineTurnIds(history.entries)).toEqual(expected);
  }
});

test("forks an earlier turn while its parent tool runs without copying its queue or stealing navigation", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(12 * 60_000);
  let holdForkResult = false;
  const heldResults: Array<() => void> = [];
  await page.routeWebSocket(/\/api\/realtime$/, (route) => {
    const upstream = route.connectToServer();
    route.onMessage((raw) => upstream.send(raw));
    upstream.onMessage((raw) => {
      const message: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      const forkResult = z
        .object({
          type: z.literal("thread.fork.result"),
          operation: z.object({ status: z.string() }),
        })
        .safeParse(message);
      if (holdForkResult && forkResult.success && forkResult.data.operation.status === "created") {
        heldResults.push(() => route.send(raw));
      } else route.send(raw);
    });
  });
  await installRealtimeSocketProbe(page);
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const parent = { hostId: host.id, threadId };
  await nameForkSource(page, parent, "Running parent fork regression");
  const a = await sendCompletedForkTurn(
    page,
    "Reply exactly FORK_STABLE_PREFIX. Do not use tools.",
  );
  const gateRoot = `/tmp/gateway-fork-gate-${randomUUID()}`;
  const otherDirectory = `/tmp/gateway-fork-other-${randomUUID()}`;
  await execRemoteSsh(remoteWorkspace.remote, `mkdir -p ${quote([gateRoot, otherDirectory])}`);
  const otherProject = await remoteWorkspace.addProject(
    host.id,
    "Fork race destination",
    otherDirectory,
  );
  const gateScript = [
    "#!/usr/bin/env bash",
    "set -eu",
    `root=${quote([gateRoot])}`,
    'printf "%s\\n" "$$" >> "$root/launches"',
    'printf "%s" "$$" > "$root/started"',
    "trap 'touch \"$root/cancelled\"; exit 143' INT TERM HUP",
    "for attempt in $(seq 1 2400); do",
    '  if [ -e "$root/release" ]; then touch "$root/done"; echo FORK_GATE_DONE; exit 0; fi',
    "  sleep 0.1",
    "done",
    "exit 1",
  ].join("\n");
  await execRemoteSsh(
    remoteWorkspace.remote,
    `printf %s ${quote([gateScript])} > ${quote([`${gateRoot}/command.sh`])}`,
  );
  await openForkThread(page, parent, project.id);
  await page
    .getByPlaceholder("输入后续修改要求")
    .fill(
      [
        `Run bash ${gateRoot}/command.sh exactly once. The test controller will release this command.`,
        "Use a blocking shell tool with timeout_ms 300000 if available, or exec_command yield_time_ms 30000.",
        "Do not change its files, release or cancel it. Keep waiting for the original process if the tool yields.",
        "After it prints FORK_GATE_DONE, reply exactly FORK_PARENT_FINISHED.",
      ].join("\n"),
    );
  await page.getByTestId("send-turn-button").click();
  const queuedId = randomUUID();
  const queuedMarker = `PARENT_QUEUE_ONLY_${randomUUID()}`;
  let childId: string | null = null;
  try {
    await expect
      .poll(
        async () => {
          const { stdout } = await execRemoteSsh(
            remoteWorkspace.remote,
            `test -s ${quote([`${gateRoot}/started`])} && printf running || printf pending`,
          );
          return stdout;
        },
        { timeout: 180_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe("running");
    const activeId = await page.evaluate(
      ({ hostId, threadId }) =>
        window.__codexGatewayE2e?.runtime.activeTurnIdsByThreadKey[`${hostId}:${threadId}`],
      parent,
    );
    if (activeId === null || activeId === undefined || activeId === "")
      throw new Error("Missing active native parent turn");
    await expect(page.getByTestId(`thread-fork-${activeId}`)).toHaveCount(0);
    const rejected = await forkOperation(page, parent, activeId);
    expect(rejected).toMatchObject({ status: "failed", threadId: null });
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...parent,
      action: "enqueue",
      input: {
        ...parent,
        projectId: project.id,
        text: queuedMarker,
        clientUserMessageId: queuedId,
      },
    });
    await expect(page.getByTestId("turn-queue")).toContainText(queuedMarker);
    holdForkResult = true;
    await page.getByTestId(`thread-fork-${a}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`thread-fork-${a}`).click();
    await expect.poll(() => heldResults.length, { timeout: 120_000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__codexGatewayE2e?.views.loading)).toBe(false);
    await expect(page.getByPlaceholder("输入后续修改要求")).toBeEnabled();
    await page.getByTestId(`project-button-${otherProject.id}`).click();
    holdForkResult = false;
    for (const deliver of heldResults.splice(0)) deliver();
    await expect(page.getByText("分支会话已创建", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__codexGatewayE2e?.navigation.selectedProjectId)).toBe(
      otherProject.id,
    );
    const request = await page.evaluate(
      (lastTurnId) =>
        window.__gatewayRealtimeProbe?.messages.find(
          (message) => message.type === "thread.fork" && message.lastTurnId === lastTurnId,
        ),
      a,
    );
    const operationId = z.object({ operationId: z.string() }).parse(request).operationId;
    const branch = await waitForCreatedFork(page, await forkStatus(page, host.id, operationId));
    childId = branch.threadId;
    expect(branch.projectId).toBe(project.id);
    expect(await forkQueue(page, parent)).toEqual([
      expect.objectContaining({ id: queuedId, status: "waiting" }),
    ]);
    await openForkThread(page, { hostId: host.id, threadId: childId }, project.id);
    expect(await forkQueue(page, { hostId: host.id, threadId: childId })).toEqual([]);
    expect(await forkGoal(page, { hostId: host.id, threadId: childId })).toBeNull();
    expect(
      timelineTurnIds(
        (await nativeForkTimeline(page, { hostId: host.id, threadId: childId })).entries,
      ),
    ).toEqual([a]);
    expect(
      await page.evaluate(
        ({ hostId, threadId }) =>
          window.__codexGatewayE2e?.runtime.activeTurnIdsByThreadKey[`${hostId}:${threadId}`],
        parent,
      ),
    ).toBe(activeId);
    expect(
      await page.evaluate(() =>
        window.__gatewayRealtimeProbe?.messages.some(
          (message) => message.type === "turn.interrupt",
        ),
      ),
    ).toBe(false);
    const processState = await execRemoteSsh(
      remoteWorkspace.remote,
      `test ! -e ${quote([`${gateRoot}/cancelled`])} && test ! -e ${quote([`${gateRoot}/done`])} && cat ${quote([`${gateRoot}/launches`])}`,
    );
    expect(processState.stdout.trim().split("\n")).toHaveLength(1);
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...parent,
      action: "cancel",
      id: queuedId,
    });
    await openForkThread(page, parent, project.id);
    // Once the earlier fork has proven it leaves the live parent alone, deliberately stop that
    // real tool turn. A terminal interrupted boundary must also be forkable and usable afterward.
    const interruption = await sendRealtimeRequest(page, {
      type: "turn.interrupt",
      requestId: randomUUID(),
      ...parent,
      turnId: activeId,
    });
    expect(interruption.type).toBe("turn.interrupt.accepted");
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__codexGatewayE2e?.views.history?.thread.turns.find((turn) => turn.id === id)
                ?.status,
            activeId,
          ),
        { timeout: 60_000 },
      )
      .toBe("interrupted");
    await execRemoteSsh(remoteWorkspace.remote, `touch ${quote([`${gateRoot}/release`])}`);
    const stoppedSourceHistory = await nativeForkTimeline(page, parent);
    expect(timelineTurnIds(stoppedSourceHistory.entries)).toEqual([a, activeId]);
    const interruptedSourceEntries = stoppedSourceHistory.entries.filter(
      (entry) => entry.type !== "realtime" && entry.turnId === activeId,
    );
    await page.getByTestId(`thread-fork-${activeId}`).scrollIntoViewIfNeeded();
    await expect(page.getByTestId(`thread-fork-${activeId}`)).toBeEnabled();
    await page.getByTestId(`thread-fork-${activeId}`).click();
    const interruptedChildId = await waitForSelectedThreadId(page, threadId);
    const interruptedChild = { hostId: host.id, threadId: interruptedChildId };
    expect(interruptedChildId).not.toBe(childId);
    const interruptedHistory = await nativeForkTimeline(page, interruptedChild);
    expect(timelineTurnIds(interruptedHistory.entries)).toEqual([a, activeId]);
    expect(interruptedHistory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turnCompleted",
          turnId: activeId,
          status: "interrupted",
        }),
      ]),
    );
    // Paginated native history projects ItemCompleted records. An interrupted live command may
    // have no persisted commandExecution item; the SSH gate above proves it actually ran. The
    // branch must preserve exactly the source's persisted entries, including their positions.
    expect(
      interruptedHistory.entries.filter(
        (entry) => entry.type !== "realtime" && entry.turnId === activeId,
      ),
    ).toEqual(interruptedSourceEntries);
    const interruptedMarker = `FORK_INTERRUPTED_CHILD_${randomUUID()}`;
    const interruptedContinuation = await sendCompletedForkTurn(
      page,
      `The previous tool attempt was deliberately interrupted. Do not resume or repeat it. Reply exactly ${interruptedMarker}. Do not use tools.`,
    );
    const continuedHistory = await nativeForkTimeline(page, interruptedChild);
    expect(timelineTurnIds(continuedHistory.entries)).toEqual([
      a,
      activeId,
      interruptedContinuation,
    ]);
    expect(
      continuedHistory.entries.some(
        (entry) =>
          entry.type === "item" &&
          entry.turnId === interruptedContinuation &&
          entry.item.type === "agentMessage" &&
          typeof entry.item.text === "string" &&
          entry.item.text.includes(interruptedMarker),
      ),
    ).toBe(true);
    const launchesAfterContinuation = await execRemoteSsh(
      remoteWorkspace.remote,
      `cat ${quote([`${gateRoot}/launches`])}`,
    );
    expect(launchesAfterContinuation.stdout.trim().split("\n")).toEqual(
      processState.stdout.trim().split("\n"),
    );
    const stoppedParentHistory = await nativeForkTimeline(page, parent);
    expect(timelineTurnIds(stoppedParentHistory.entries)).toEqual([a, activeId]);
    expect(JSON.stringify(stoppedParentHistory.entries)).not.toContain(interruptedMarker);
    await openForkThread(page, { hostId: host.id, threadId: childId }, project.id);
    const childTurn = await sendCompletedForkTurn(
      page,
      "Reply exactly FORK_CHILD_FINISHED. Do not use tools.",
    );
    expect(
      timelineTurnIds(
        (await nativeForkTimeline(page, { hostId: host.id, threadId: childId })).entries,
      ),
    ).toEqual([a, childTurn]);
  } finally {
    holdForkResult = false;
    for (const deliver of heldResults.splice(0)) deliver();
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...parent,
      action: "cancel",
      id: queuedId,
    }).catch(() => undefined);
    await execRemoteSsh(remoteWorkspace.remote, `touch ${quote([`${gateRoot}/release`])}`).catch(
      () => undefined,
    );
  }
});
