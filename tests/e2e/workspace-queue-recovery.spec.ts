import { randomUUID } from "node:crypto";
import { devices, type Page } from "@playwright/test";
import { quote } from "shell-quote";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp, reloadApp } from "./helpers/app";
import { execRemoteSsh, remoteCodexCommand, type RemoteCodexEnv } from "./helpers/remote-codex";
import { sendRealtimeRawRequest, sendRealtimeRequest } from "./helpers/realtime";
import { installRealtimeSocketProbe } from "./helpers/realtime-socket-probe";

test("corrects stale workspace routes and repairs a paused prompt without submitting it twice", async ({
  page,
  browser,
  remoteWorkspace,
}) => {
  test.setTimeout(8 * 60_000);
  await installRealtimeSocketProbe(page);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision();
  const wrongDirectory = `/tmp/gateway-wrong-workspace-${randomUUID()}`;
  await execRemoteSsh(remoteWorkspace.remote, `mkdir -p ${quote([wrongDirectory])}`);
  const wrongProject = await remoteWorkspace.addProject(host.id, "Other workspace", wrongDirectory);

  // A real CLI turn creates a persisted native thread which Gateway has never opened. Starting
  // through Gateway would pre-populate its snapshot and miss the cold-open regression.
  const seedMarker = `WORKSPACE_SEED_${randomUUID()}`;
  const threadId = await createNativeThread(remoteWorkspace.remote, project.remotePath, seedMarker);
  const scope = { hostId: host.id, threadId };
  const wrongUrl = `/?hostId=${host.id}&projectId=${wrongProject.id}&threadId=${threadId}`;
  await page.goto(wrongUrl, { waitUntil: "domcontentloaded" });
  await expectWorkspace(page, scope, project.id, project.remotePath);
  const rolloutPath = await page.evaluate(
    () => window.__codexGatewayE2e?.views.currentThread?.path,
  );
  if (rolloutPath === undefined || rolloutPath === null || rolloutPath === "")
    throw new Error("Expected the real native rollout path");

  // The same stale bookmark must also be corrected with an existing server snapshot.
  await page.goto(wrongUrl, { waitUntil: "domcontentloaded" });
  await expectWorkspace(page, scope, project.id, project.remotePath);
  const cached = await sendRealtimeRequest(page, {
    type: "thread.activate",
    requestId: randomUUID(),
    ...scope,
    projectId: wrongProject.id,
  });
  if (cached.type !== "thread.snapshot") throw new Error("Expected a thread snapshot");
  expect(cached.projectId).toBe(project.id);
  expect(cached.project?.remotePath).toBe(project.remotePath);
  expect(cached.thread.cwd).toBe(project.remotePath);

  // An idle thread must enforce the same guard on direct sends; otherwise a stale page can
  // bypass the queue and silently change the native working directory with turn.start.
  const rejectedMarker = `WRONG_WORKSPACE_REJECTED_${randomUUID()}`;
  const rejectedStart = await sendRealtimeRawRequest(page, {
    type: "turn.start",
    requestId: randomUUID(),
    ...scope,
    projectId: wrongProject.id,
    text: `Reply exactly ${rejectedMarker}, without calling any tools.`,
    clientUserMessageId: randomUUID(),
    model: remoteWorkspace.remote.testModel,
  });
  expect(rejectedStart.type).toBe("error");
  expect(await nativeEvidence(remoteWorkspace.remote, rolloutPath, rejectedMarker)).toMatchObject({
    threadId,
    cwd: project.remotePath,
    lastTurnCwd: project.remotePath,
    inputCount: 0,
  });

  // Identical relative paths in different workspaces must not be silently rebound to another
  // file. These are real fixture files; the rejected recovery must never submit a model turn.
  await execRemoteSsh(
    remoteWorkspace.remote,
    `printf original > ${quote([`${wrongDirectory}/reference.txt`])} && printf different > ${quote([`${project.remotePath}/reference.txt`])}`,
  );
  const referencedId = randomUUID();
  const referencedInput = {
    ...scope,
    projectId: wrongProject.id,
    text: "Review the selected file.",
    clientUserMessageId: referencedId,
    references: [{ type: "file" as const, path: "reference.txt", name: "reference.txt" }],
  };
  await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "enqueue",
    input: referencedInput,
  });
  const referencedQueue = await queueEntries(page, scope);
  expect(referencedQueue).toEqual([
    expect.objectContaining({
      id: referencedId,
      status: "paused",
      pauseReason: "workspace_mismatch",
      canRepairWorkspace: false,
    }),
  ]);
  await expect(page.getByTestId("repair-queued-workspace")).toHaveCount(0);
  await expect(page.getByTestId("turn-queue")).toContainText("重新选择文件");
  const refusedFileRepair = await sendRealtimeRawRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "repairWorkspace",
    id: referencedId,
  });
  expect(refusedFileRepair.type).toBe("error");
  expect(await queueEntries(page, scope)).toEqual(referencedQueue);
  await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "cancel",
    id: referencedId,
  });

  const marker = `WORKSPACE_RECOVERED_${randomUUID()}`;
  const input = {
    ...scope,
    projectId: wrongProject.id,
    text: `Reply exactly ${marker}, without calling any tools.`,
    clientUserMessageId: randomUUID(),
    model: remoteWorkspace.remote.testModel,
    approvalPolicy: "never" as const,
  };
  await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "enqueue",
    input,
  });
  const original = await queueEntries(page, scope);
  expect(original).toEqual([
    expect.objectContaining({
      id: input.clientUserMessageId,
      text: input.text,
      status: "paused",
      pauseReason: "workspace_mismatch",
      canRepairWorkspace: true,
    }),
  ]);
  expect(await nativeEvidence(remoteWorkspace.remote, rolloutPath, marker)).toMatchObject({
    threadId,
    cwd: project.remotePath,
    inputCount: 0,
  });

  // A blind resume cannot bypass the directory guard. It must retain the same recoverable input.
  const prematureResume = await sendRealtimeRawRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "resume",
  });
  expect(prematureResume.type).toBe("error");
  expect(await queueEntries(page, scope)).toEqual(original);

  const mobileContext = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width: 375, height: 812 },
    storageState: await page.context().storageState(),
  });
  const mobile = await mobileContext.newPage();
  await installRealtimeSocketProbe(mobile);
  try {
    await openApp(mobile, { resetConfig: false });
    await expectWorkspace(mobile, scope, project.id, project.remotePath);
    const mobileQueue = mobile.getByTestId("turn-queue");
    const mobileRow = mobileQueue.locator("[data-queue-status]").filter({ hasText: marker });
    const desktopRow = page
      .getByTestId("turn-queue")
      .locator("[data-queue-status]")
      .filter({ hasText: marker });
    for (const row of [mobileRow, desktopRow]) {
      await expect(row).toHaveAttribute("data-queue-pause-reason", "workspace_mismatch");
      await expect(row).toContainText("工作空间");
      await expect(row.getByTestId("repair-queued-workspace")).toBeVisible();
    }
    await expect(
      mobileQueue.getByRole("button", { name: "已核对，继续队列", exact: true }),
    ).toBeDisabled();
    const repair = mobileRow.getByTestId("repair-queued-workspace");
    await repair.scrollIntoViewIfNeeded();
    await expect(repair).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() => mobileQueue.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await mobile.screenshot({ path: test.info().outputPath("mobile-workspace-mismatch.png") });
    await repair.click();

    for (const row of [mobileRow, desktopRow]) {
      await expect(row).toHaveAttribute("data-queue-status", "paused");
      await expect(row).toHaveAttribute("data-queue-pause-reason", "workspace_repaired");
      await expect(row.getByTestId("repair-queued-workspace")).toHaveCount(0);
    }
    await expect(
      mobileQueue.getByRole("button", { name: "已核对，继续队列", exact: true }),
    ).toBeEnabled();
    const repaired = await queueEntries(page, scope);
    expect(repaired).toEqual([
      {
        ...original[0],
        status: "paused",
        pauseReason: "workspace_repaired",
        canRepairWorkspace: false,
      },
    ]);
    // A second repair cannot mutate a paused entry for a different reason, including a request
    // whose native delivery is unknown. The real-state case here is the already repaired entry.
    const repeatedRepair = await sendRealtimeRawRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "repairWorkspace",
      id: input.clientUserMessageId,
    });
    expect(repeatedRepair.type).toBe("error");
    expect(await queueEntries(page, scope)).toEqual(repaired);

    // Observe multiple worker intervals. Repair must never become an implicit send, including
    // after a new browser subscription or reload reconstructs the queue from durable storage.
    await reloadApp(page);
    await expectWorkspace(page, scope, project.id, project.remotePath);
    for (let interval = 0; interval < 3; interval += 1) {
      await page.waitForTimeout(2_100);
      expect(await queueEntries(page, scope)).toEqual(repaired);
      expect(await nativeEvidence(remoteWorkspace.remote, rolloutPath, marker)).toMatchObject({
        inputCount: 0,
      });
    }
    await mobileQueue.getByRole("button", { name: "已核对，继续队列", exact: true }).click();
    await expect.poll(() => completedReplies(page, marker), { timeout: 180_000 }).toHaveLength(1);
    for (const client of [page, mobile]) {
      await expect
        .poll(() => completedReplies(client, marker), { timeout: 30_000 })
        .toHaveLength(1);
      await expect(client.getByTestId("turn-queue")).toHaveCount(0);
      await expectWorkspace(client, scope, project.id, project.remotePath);
    }
    const evidence = await nativeEvidence(remoteWorkspace.remote, rolloutPath, marker);
    expect(evidence).toMatchObject({
      threadId,
      cwd: project.remotePath,
      inputCount: 1,
      lastTurnCwd: project.remotePath,
      approvalPolicy: "never",
    });
    if (remoteWorkspace.remote.testModel !== undefined)
      expect(evidence.model).toBe(remoteWorkspace.remote.testModel);

    // A delayed retry from a stale page must not resurrect the original encrypted input or
    // overwrite the corrected project; the client ID still denotes this one native submission.
    await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "enqueue",
      input,
    });
    await sendRealtimeRequest(mobile, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "resume",
    });
    expect(await queueEntries(page, scope)).toEqual([]);
    expect((await nativeEvidence(remoteWorkspace.remote, rolloutPath, marker)).inputCount).toBe(1);
    await reloadApp(page);
    await expectWorkspace(page, scope, project.id, project.remotePath);
    await expect(page.getByTestId("turn-queue")).toHaveCount(0);
    await expect.poll(() => completedReplies(page, marker)).toHaveLength(1);
    for (const client of [page, mobile]) {
      expect(
        await client.evaluate(() =>
          window.__gatewayRealtimeProbe?.messages.some(
            (message) => message.type === "turn.interrupt" || message.type === "turn.steer",
          ),
        ),
      ).toBe(false);
    }
  } finally {
    await mobileContext.close();
  }
});

async function expectWorkspace(
  page: Page,
  scope: { hostId: number; threadId: string },
  projectId: number,
  cwd: string,
) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const driver = window.__codexGatewayE2e;
          const query = new URLSearchParams(window.location.search);
          return {
            threadId: driver?.views.currentThread?.id,
            cwd: driver?.views.currentThread?.cwd,
            selectedProjectId: driver?.navigation.selectedProjectId,
            routeHostId: Number(query.get("hostId")),
            routeProjectId: Number(query.get("projectId")),
            routeThreadId: query.get("threadId"),
          };
        }),
      { timeout: 60_000 },
    )
    .toEqual({
      threadId: scope.threadId,
      cwd,
      selectedProjectId: projectId,
      routeHostId: scope.hostId,
      routeProjectId: projectId,
      routeThreadId: scope.threadId,
    });
}

async function queueEntries(page: Page, scope: { hostId: number; threadId: string }) {
  const response = await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "list",
  });
  if (response.type !== "turn.queue.snapshot") throw new Error("Expected a queue snapshot");
  return response.entries;
}

async function completedReplies(page: Page, marker: string) {
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

async function createNativeThread(remote: RemoteCodexEnv, cwd: string, marker: string) {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", cwd];
  if (remote.testModel !== undefined) args.push("-m", remote.testModel);
  args.push(`Reply exactly ${marker}, without calling any tools.`);
  // SSH exec leaves stdin open. Explicit EOF prevents Codex from waiting for additional input.
  const { stdout } = await execRemoteSsh(
    remote,
    `timeout 120s ${remoteCodexCommand(remote)} ${quote(args)} < /dev/null`,
  );
  const events = z.array(z.object({ type: z.string(), thread_id: z.string().optional() })).parse(
    stdout
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line)),
  );
  expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  const threadId = events.find((event) => event.type === "thread.started")?.thread_id;
  if (threadId === undefined || threadId === "")
    throw new Error("Native CLI did not return its thread ID");
  return threadId;
}

async function nativeEvidence(remote: RemoteCodexEnv, rolloutPath: string, marker: string) {
  // Read only this test's short rollout, never a shared session tree. Native user input evidence
  // detects duplicate delivery which identical client message IDs can hide in browser bubbles.
  const script = `
const fs = require('node:fs');
const file = ${JSON.stringify(rolloutPath)};
const marker = ${JSON.stringify(marker)};
if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Unexpectedly large test rollout');
const rows = fs.readFileSync(file, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
const metadata = rows.find(row => row.type === 'session_meta')?.payload;
const context = rows.filter(row => row.type === 'turn_context').at(-1)?.payload;
const inputs = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user');
const inputCount = inputs.filter(row => (row.payload.content || []).some(item => (item.text || '').includes(marker))).length;
process.stdout.write(JSON.stringify({ threadId: metadata?.id, cwd: metadata?.cwd, inputCount, lastTurnCwd: context?.cwd, model: context?.model, approvalPolicy: context?.approval_policy }));
`;
  const { stdout } = await execRemoteSsh(
    remote,
    quote(["/opt/codex-preview-runtime/bin/node", "-e", script]),
  );
  return z
    .object({
      threadId: z.string(),
      cwd: z.string(),
      inputCount: z.number().int().nonnegative(),
      lastTurnCwd: z.string(),
      model: z.string(),
      approvalPolicy: z.string(),
    })
    .parse(JSON.parse(stdout));
}
