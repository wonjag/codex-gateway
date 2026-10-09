import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppServerTimelineEntry } from "../../shared/types";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp } from "./helpers/app";
import {
  forkOperation,
  forkSettings,
  nameForkSource,
  nativeForkTimeline,
  openForkThread,
  sendCompletedForkTurn,
  timelineTurnIds,
  waitForCreatedFork,
  type ForkScope,
} from "./helpers/thread-fork";

test("forks before and between real compaction checkpoints without importing later history", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(15 * 60_000);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const parent = { hostId: host.id, threadId };
  await nameForkSource(page, parent, "Compaction fork regression");
  const originalCode = `ORIGINAL_CODE_${randomUUID()}`;
  const excludedBeforeFirstCompact = `AFTER_FIRST_BOUNDARY_${randomUUID()}`;
  const retainedAfterFirstCompact = `BETWEEN_CHECKPOINTS_${randomUUID()}`;
  const excludedAfterSecondCompact = `AFTER_SECOND_BOUNDARY_${randomUUID()}`;
  const a = await sendCompletedForkTurn(
    page,
    `For future turns, remember the original project code is ${originalCode}. Reply exactly CODE_SAVED. Do not use tools.`,
  );
  await sendCompletedForkTurn(
    page,
    `The later deployment label is ${excludedBeforeFirstCompact}. Reply exactly LABEL_SAVED. Do not use tools.`,
  );
  const initialTimeline = await nativeForkTimeline(page, parent);
  const sourceSettings = await forkSettings(page, parent);
  expect(typeof sourceSettings.model).toBe("string");
  if (remoteWorkspace.remote.testModel !== undefined)
    expect(sourceSettings.model).toBe(remoteWorkspace.remote.testModel);
  const firstCheckpoint = await compact(parent, compactCount(initialTimeline.entries));

  // A fork before the first checkpoint must not reuse the parent's latest summary. The public
  // timeline and successful real follow-up are checked here; these assertions do not pretend to
  // be an HTTP capture of the provider's hidden input or proof of exact summary fidelity.
  const before = await waitForCreatedFork(page, await forkOperation(page, parent, a));
  const beforeScope = { hostId: host.id, threadId: before.threadId };
  await openForkThread(page, beforeScope, project.id);
  expect((await forkSettings(page, beforeScope)).model).toBe(sourceSettings.model);
  const beforeHistory = await nativeForkTimeline(page, beforeScope, 3);
  expect(timelineTurnIds(beforeHistory.entries)).toEqual([a]);
  expect(compactCount(beforeHistory.entries)).toBe(0);
  expect(JSON.stringify(beforeHistory.entries)).toContain(originalCode);
  expect(JSON.stringify(beforeHistory.entries)).not.toContain(excludedBeforeFirstCompact);
  await sendCompletedForkTurn(
    page,
    "Reply with the original project code saved in our first exchange. Do not use tools.",
  );
  await expect
    .poll(() =>
      page.evaluate(
        (code) =>
          window.__codexGatewayE2e?.views.history?.thread.turns
            .at(-1)
            ?.items.some(
              (item) => item.type === "agentMessage" && (item.text ?? "").includes(code),
            ),
        originalCode,
      ),
    )
    .toBe(true);

  await openForkThread(page, parent, project.id);
  const middle = await sendCompletedForkTurn(
    page,
    `The approved middle label is ${retainedAfterFirstCompact}. Reply exactly MIDDLE_SAVED. Do not use tools.`,
  );
  const retainedPrefix = await nativeForkTimeline(page, parent);
  expect(compactCount(retainedPrefix.entries)).toBe(firstCheckpoint);
  await sendCompletedForkTurn(
    page,
    `The newest private label is ${excludedAfterSecondCompact}. Reply exactly NEWEST_SAVED. Do not use tools.`,
  );
  const secondCheckpoint = await compact(parent, firstCheckpoint);
  expect(secondCheckpoint).toBeGreaterThan(firstCheckpoint);

  const between = await waitForCreatedFork(page, await forkOperation(page, parent, middle));
  const betweenScope = { hostId: host.id, threadId: between.threadId };
  await openForkThread(page, betweenScope, project.id);
  expect((await forkSettings(page, betweenScope)).model).toBe(sourceSettings.model);
  const betweenHistory = await nativeForkTimeline(page, betweenScope, 3);
  expect(timelineTurnIds(betweenHistory.entries)).toEqual(timelineTurnIds(retainedPrefix.entries));
  expect(compactCount(betweenHistory.entries)).toBe(firstCheckpoint);
  expect(JSON.stringify(betweenHistory.entries)).toContain(retainedAfterFirstCompact);
  expect(JSON.stringify(betweenHistory.entries)).not.toContain(excludedAfterSecondCompact);
  // New native turns still work with an inherited summary and the original model/provider. This
  // is run once with each selected real model via E2E_CODEX_MODEL, never by model-specific mocks.
  const continuation = await sendCompletedForkTurn(
    page,
    "Reply exactly FORK_AFTER_COMPACTION_OK. Do not use tools.",
  );
  expect(timelineTurnIds((await nativeForkTimeline(page, betweenScope)).entries).at(-1)).toBe(
    continuation,
  );
  const finalParent = await nativeForkTimeline(page, parent);
  expect(compactCount(finalParent.entries)).toBe(secondCheckpoint);
  expect(JSON.stringify(finalParent.entries)).not.toContain("FORK_AFTER_COMPACTION_OK");
  await test.info().attach("native-fork-compaction-boundaries", {
    body: Buffer.from(
      JSON.stringify(
        {
          model: remoteWorkspace.remote.testModel,
          parentThreadId: threadId,
          before: { sourceTurnId: a, childThreadId: before.threadId, checkpointCount: 0 },
          between: {
            sourceTurnId: middle,
            childThreadId: between.threadId,
            checkpointCount: firstCheckpoint,
          },
          sourceCheckpointCount: secondCheckpoint,
          evidenceScope:
            "Native persisted timeline boundaries and real continuation; not a provider HTTP input capture",
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });

  async function compact(scope: ForkScope, previousCount: number) {
    await authenticatedFetch(
      page,
      {
        url: "/api/e2e/compact-thread",
        method: "POST",
        body: scope,
      },
      (value) => z.object({ accepted: z.literal(true) }).parse(value),
    );
    let checkpointCount = previousCount;
    await expect
      .poll(
        async () => {
          const { entries } = await nativeForkTimeline(page, scope);
          checkpointCount = compactCount(entries);
          const lastCompaction = entries.findLast(
            (entry) => entry.type === "item" && entry.item.type === "contextCompaction",
          );
          return (
            checkpointCount > previousCount &&
            lastCompaction?.type === "item" &&
            entries.some(
              (entry) =>
                entry.type === "turnCompleted" &&
                entry.turnId === lastCompaction.turnId &&
                entry.status === "completed",
            )
          );
        },
        { timeout: 240_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true);
    return checkpointCount;
  }
});

function compactCount(entries: AppServerTimelineEntry[]) {
  return entries.filter((entry) => entry.type === "item" && entry.item.type === "contextCompaction")
    .length;
}
