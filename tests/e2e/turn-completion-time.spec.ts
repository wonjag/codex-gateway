import { randomUUID } from "node:crypto";
import { formatTurnCompletedAt } from "../../app/utils/turn-timing";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp, reloadApp } from "./helpers/app";
import { nameForkSource, nativeForkTimeline, sendCompletedForkTurn } from "./helpers/thread-fork";

test.use({ timezoneId: "America/Los_Angeles" });

test("formats Beijing completion times across midnight and rejects missing timestamps", () => {
  expect(formatTurnCompletedAt(1_782_986_402.5)).toBe("2026-07-02 18:00:02");
  expect(formatTurnCompletedAt(Date.parse("2026-12-31T16:00:00Z") / 1000)).toBe(
    "2027-01-01 00:00:00",
  );
  expect(formatTurnCompletedAt(null)).toBeNull();
  expect(formatTurnCompletedAt(Number.NaN)).toBeNull();
  expect(formatTurnCompletedAt(Number.POSITIVE_INFINITY)).toBeNull();
  expect(formatTurnCompletedAt(Number.MAX_VALUE)).toBeNull();
});

test("shows the native turn end time in Beijing on live completion and restored mobile history", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  await nameForkSource(page, scope, "Turn end time regression");
  await expect(page.locator('[data-testid^="turn-completed-at-"]')).toHaveCount(0);

  const turnId = await sendCompletedForkTurn(
    page,
    `Reply exactly TIME_${randomUUID()}. Do not use tools.`,
  );
  const timeline = await nativeForkTimeline(page, scope, 3);
  const completion = timeline.entries.find(
    (entry) => entry.type === "turnCompleted" && entry.turnId === turnId,
  );
  if (completion?.type !== "turnCompleted" || completion.completedAt === null) {
    throw new Error("Expected a native completion timestamp");
  }
  // Independent UTC arithmetic for a modern fixture; the application uses Intl/Asia/Shanghai.
  const beijingTime = new Date((completion.completedAt + 8 * 60 * 60) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const label = page.getByTestId(`turn-completed-at-${turnId}`);
  const expected = `结束时间（北京时间）：${beijingTime}`;
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
    "America/Los_Angeles",
  );
  await expect(label).toHaveCount(1);
  await expect(label).toHaveText(expected);
  await expect(label).toBeVisible();
  await test.info().attach("desktop-turn-completion-time", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await reloadApp(page);
  await expect(label).toHaveText(expected);
  const steps = page.getByRole("button", { name: /中间过程/ });
  if ((await steps.count()) > 0) {
    await steps.last().click();
    await expect(steps.last()).toHaveAttribute("data-state", "open");
    await expect(label).toBeVisible();
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await reloadApp(page);
  await expect(label).toHaveText(expected);
  await expect(label).toBeVisible();
  expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await label.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await test.info().attach("mobile-turn-completion-time", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
